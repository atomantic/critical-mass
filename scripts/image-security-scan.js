#!/usr/bin/env node
// @ts-check
/**
 * Container-image vulnerability scan driver for .github/workflows/image-security.yml
 * (issue #1951). Syft inventories an image, Grype matches that inventory against
 * its vulnerability database, and every target ends in exactly one of:
 *
 *   scanned      OS + application inventories and all-severity findings written
 *   unavailable  a named reason (build, auth, architecture, scanner, inventory)
 *
 * An unavailable target never carries a findings file, so a failure cannot be
 * read as a clean scan. See docs/IMAGE_SECURITY.md for the maintainer workflow.
 *
 *   node scripts/image-security-scan.js plan
 *   node scripts/image-security-scan.js scan --target <id> --out <dir> [--source <syft-source>] [--upstream-failure <detail>]
 *   node scripts/image-security-scan.js aggregate --in <dir> --out <dir>
 *   node scripts/image-security-scan.js selftest --out <dir>
 *
 * Environment: IMAGE_SCAN_SYFT_BIN / IMAGE_SCAN_GRYPE_BIN override the tools,
 * IMAGE_SCAN_SKIP_DB_UPDATE=1 reuses the local Grype database (offline runs),
 * GITHUB_SHA / GITHUB_SERVER_URL / GITHUB_REPOSITORY / GITHUB_RUN_ID attribute the evidence.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const evidence = require('./lib/image-scan-evidence');

const REPO_ROOT = path.join(__dirname, '..');
const TOOL_TIMEOUT_MS = 20 * 60_000;
const SBOM_FILE = 'syft.json';
const FINDINGS_RAW_FILE = 'grype.json';

/** @param {string} bin @param {string[]} args @param {NodeJS.ProcessEnv} env */
function run(bin, args, env) {
  const r = spawnSync(bin, args, { encoding: 'utf8', env, timeout: TOOL_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: `${r.stderr ?? ''}${r.error && /** @type {any} */ (r.error).code !== 'ENOENT' ? ` ${r.error.message}` : ''}`,
    missing: Boolean(r.error && /** @type {any} */ (r.error).code === 'ENOENT'),
  };
}

/** @param {string} file @returns {any|null} */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   target: any, outDir: string, source?: string, upstreamFailure?: string,
 *   syftBin?: string, grypeBin?: string, skipDbUpdate?: boolean, root?: string, now?: Date,
 *   env?: NodeJS.ProcessEnv,
 * }} p
 */
function scanTarget({ target, outDir, source, upstreamFailure, syftBin, grypeBin, skipDbUpdate, root = REPO_ROOT, now = new Date(), env = process.env }) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const syft = syftBin ?? env.IMAGE_SCAN_SYFT_BIN ?? 'syft';
  const grype = grypeBin ?? env.IMAGE_SCAN_GRYPE_BIN ?? 'grype';
  const toolEnv = { ...env, SYFT_CHECK_FOR_APP_UPDATE: 'false', GRYPE_CHECK_FOR_APP_UPDATE: 'false', GRYPE_DB_AUTO_UPDATE: 'false' };
  const runUrl = env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY
    ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    : '';
  const context = {
    sourceCommit: env.GITHUB_SHA ?? '',
    workflowRun: runUrl,
    recipe: fs.existsSync(path.join(root, 'Dockerfile')) ? evidence.computeRecipeHashes(root) : {},
  };

  /** @param {string} reason @param {string} detail @param {boolean} [expected] */
  const unavailable = (reason, detail, expected = false) => {
    const result = evidence.unavailableResult({ target, reason, detail, expected, now, context });
    fs.writeFileSync(path.join(outDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  };

  if (target.unsupportedReason && !source) return unavailable('architecture_unsupported', target.unsupportedReason, true);
  if (upstreamFailure) return unavailable('build_failed', upstreamFailure);
  const scanSource = source ?? target.source;
  if (!scanSource) return unavailable('build_failed', 'no image source was produced for this target');

  const syftVersion = run(syft, ['--version'], toolEnv);
  if (syftVersion.missing || syftVersion.status !== 0) return unavailable('scanner_unavailable', `syft: ${syftVersion.stderr || 'not runnable'}`);
  const grypeVersion = run(grype, ['version', '-o', 'json'], toolEnv);
  if (grypeVersion.missing || grypeVersion.status !== 0) return unavailable('scanner_unavailable', `grype: ${grypeVersion.stderr || 'not runnable'}`);

  if (!skipDbUpdate && env.IMAGE_SCAN_SKIP_DB_UPDATE !== '1') {
    const update = run(grype, ['db', 'update'], toolEnv);
    if (update.status !== 0) return unavailable('scanner_database_unavailable', update.stderr || update.stdout);
  }
  const dbStatus = run(grype, ['db', 'status', '-o', 'json'], toolEnv);
  const db = dbStatus.status === 0 ? safeParse(dbStatus.stdout) : null;
  if (!db || db.valid !== true || !db.built) {
    return unavailable('scanner_database_unavailable', dbStatus.stderr || 'grype database is missing or invalid');
  }

  const sbomPath = path.join(outDir, SBOM_FILE);
  const syftArgs = [scanSource];
  if (target.platform && scanSource.startsWith('registry:')) syftArgs.push('--platform', target.platform);
  syftArgs.push('-o', `syft-json=${sbomPath}`, '-q');
  const cataloged = run(syft, syftArgs, toolEnv);
  if (cataloged.status !== 0) {
    const reason = scanSource.startsWith('oci-archive:') ? 'build_failed' : evidence.classifyFetchFailure(cataloged.stderr);
    return unavailable(reason, cataloged.stderr);
  }
  const sbom = readJson(sbomPath);
  if (!sbom || !Array.isArray(sbom.artifacts)) return unavailable('inventory_failed', 'syft did not produce a readable inventory');

  const meta = sbom.source?.metadata ?? {};
  const isImage = sbom.source?.type === 'image';
  if (target.platform && isImage && meta.architecture !== evidence.archOf(target.platform)) {
    return unavailable('architecture_mismatch', `requested ${target.platform}, image reports ${meta.os ?? '?'}/${meta.architecture ?? '?'}`);
  }

  const inventory = evidence.splitInventory(sbom);
  const missing = [];
  if (target.require.includes('os') && inventory.os.length === 0) missing.push('OS packages');
  if (target.require.includes('app') && inventory.app.length === 0) missing.push('application dependencies');
  const found = (target.requirePackages ?? []).filter((/** @type {string} */ spec) => {
    const [type, name] = spec.split(':');
    return inventory.app.some((a) => a.type === type && a.name === name);
  });
  for (const spec of target.requirePackages ?? []) {
    if (!found.includes(spec)) missing.push(`package ${spec}`);
  }
  if (missing.length > 0) return unavailable('inventory_failed', `inventory is missing: ${missing.join(', ')}`);

  const grypePath = path.join(outDir, FINDINGS_RAW_FILE);
  const matched = run(grype, [`sbom:${sbomPath}`, '-o', 'json', '--file', grypePath, '-q'], toolEnv);
  const grypeJson = matched.status === 0 ? readJson(grypePath) : null;
  if (!grypeJson || !Array.isArray(grypeJson.matches)) {
    return unavailable('scanner_failed', matched.stderr || 'grype did not produce readable findings');
  }
  const findings = evidence.normalizeFindings(grypeJson);

  const write = (/** @type {string} */ name, /** @type {any} */ value) =>
    fs.writeFileSync(path.join(outDir, name), `${JSON.stringify(value, null, 2)}\n`);
  write('os-inventory.json', inventory.os);
  write('app-inventory.json', inventory.app);
  write('findings.json', findings);

  /** @type {Record<string,string>} */
  const artifacts = {};
  for (const name of [SBOM_FILE, FINDINGS_RAW_FILE, 'os-inventory.json', 'app-inventory.json', 'findings.json']) {
    artifacts[name] = evidence.sha256File(path.join(outDir, name));
  }

  const requestedDigest = scanSource.match(/@(sha256:[0-9a-f]{64})$/)?.[1] ?? null;
  const result = {
    schemaVersion: evidence.SCHEMA_VERSION,
    targetId: target.id,
    kind: target.kind,
    platform: target.platform,
    status: 'scanned',
    expectedUnavailable: false,
    generatedAt: now.toISOString(),
    ...context,
    image: {
      source: scanSource,
      requestedDigest,
      manifestDigest: meta.manifestDigest ?? null,
      imageId: meta.imageID ?? null,
      repoDigests: Array.isArray(meta.repoDigests) ? meta.repoDigests : [],
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      os: meta.os ?? null,
      architecture: meta.architecture ?? null,
      distro: [sbom.distro?.name, sbom.distro?.version].filter(Boolean).join(' ') || null,
    },
    scanner: {
      syft: { version: sbom.descriptor?.version ?? '' },
      grype: {
        version: safeParse(grypeVersion.stdout)?.version ?? '',
        db: { built: db.built, schemaVersion: db.schemaVersion ?? '', checksum: db.checksum ?? null },
      },
    },
    inventory: { osPackages: inventory.os.length, appPackages: inventory.app.length, requiredPackagesFound: found },
    findings: { total: findings.length, bySeverity: evidence.countBySeverity(findings) },
    artifacts,
  };
  write('result.json', result);
  return result;
}

/** @param {string} text */
function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Negative and positive controls proving the pipeline reports what it should:
 * a known-vulnerable fixture must produce findings, and an unreachable image or
 * missing scanner must produce unavailable coverage with no findings at all.
 * @param {{outDir:string, env?:NodeJS.ProcessEnv}} p
 */
function selfTest({ outDir, env = process.env }) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'image-scan-selftest-'));
  const lockfile = {
    name: 'selftest-fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'selftest-fixture', version: '1.0.0', dependencies: { lodash: '4.17.15' } },
      'node_modules/lodash': { version: '4.17.15', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz', license: 'MIT' },
    },
  };
  fs.writeFileSync(path.join(work, 'package.json'), '{"name":"selftest-fixture","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(work, 'package-lock.json'), JSON.stringify(lockfile));

  const base = { kind: 'fixture', platform: '', require: ['app'], requirePackages: ['npm:lodash'] };
  const controls = [
    {
      name: 'vulnerable-fixture-is-detected',
      target: { ...base, id: 'selftest-vulnerable' },
      source: `dir:${work}`,
      pass: (/** @type {any} */ r) => r.status === 'scanned' && r.findings.total > 0,
    },
    {
      name: 'unreachable-image-is-unavailable-not-clean',
      target: { ...base, id: 'selftest-unreachable', platform: 'linux/amd64', require: ['os'], requirePackages: [] },
      source: `registry:ghcr.io/atomantic/critical-mass@sha256:${'0'.repeat(64)}`,
      pass: (/** @type {any} */ r) => r.status === 'unavailable' && !('findings' in r),
    },
    {
      name: 'missing-scanner-is-unavailable-not-clean',
      target: { ...base, id: 'selftest-no-scanner' },
      source: `dir:${work}`,
      syftBin: path.join(work, 'no-such-syft'),
      pass: (/** @type {any} */ r) => r.status === 'unavailable' && r.unavailableReason === 'scanner_unavailable' && !('findings' in r),
    },
  ];

  const report = controls.map((c) => {
    const result = scanTarget({
      target: c.target,
      outDir: path.join(outDir, c.target.id),
      source: c.source,
      syftBin: c.syftBin,
      env,
    });
    return { name: c.name, passed: c.pass(result), status: result.status, reason: result.unavailableReason ?? null, findings: result.findings?.total ?? null };
  });
  fs.rmSync(work, { recursive: true, force: true });
  const summary = { schemaVersion: evidence.SCHEMA_VERSION, generatedAt: new Date().toISOString(), passed: report.every((c) => c.passed), controls: report };
  fs.writeFileSync(path.join(outDir, 'selftest.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

/** @param {{results:any[], problems:string[], sourceCommit:string}} p */
function renderSummary({ results, problems, sourceCommit }) {
  const lines = [
    '## Image vulnerability scan coverage',
    '',
    `Source commit: \`${sourceCommit || 'unknown'}\``,
    '',
    '| Target | Platform | Coverage | OS pkgs | App pkgs | Findings (all severities) |',
    '| --- | --- | --- | ---: | ---: | --- |',
  ];
  for (const r of [...results].sort((a, b) => String(a.targetId).localeCompare(String(b.targetId)))) {
    if (r.status === 'scanned') {
      const sev = Object.entries(r.findings.bySeverity).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none';
      lines.push(`| ${r.targetId} | ${r.platform} | scanned | ${r.inventory.osPackages} | ${r.inventory.appPackages} | ${r.findings.total} (${sev}) |`);
    } else {
      const why = `${r.unavailableReason}${r.expectedUnavailable ? ' (expected)' : ''}`;
      lines.push(`| ${r.targetId} | ${r.platform} | **UNAVAILABLE** ${why} | - | - | not scanned |`);
    }
  }
  lines.push('');
  lines.push(problems.length === 0 ? 'Coverage complete.' : `Coverage problems:\n\n${problems.map((p) => `- ${p}`).join('\n')}`);
  return `${lines.join('\n')}\n`;
}

/** @param {string[]} argv */
function parseFlags(argv) {
  /** @type {Record<string,string>} */
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument ${argv[i]}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${argv[i]} needs a value`);
    flags[argv[i].slice(2)] = value;
    i += 1;
  }
  return flags;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const need = (/** @type {string} */ name) => {
    if (!flags[name]) throw new Error(`--${name} is required`);
    return flags[name];
  };

  if (command === 'plan') {
    process.stdout.write(`${JSON.stringify({ include: evidence.buildTargetPlan(REPO_ROOT) })}\n`);
    return 0;
  }
  if (command === 'scan') {
    const target = evidence.buildTargetPlan(REPO_ROOT).find((t) => t.id === need('target'));
    if (!target) throw new Error(`unknown target ${flags.target}`);
    const result = scanTarget({ target, outDir: need('out'), source: flags.source, upstreamFailure: flags['upstream-failure'] });
    const label = result.status === 'scanned' ? `${result.findings.total} findings` : `unavailable (${result.unavailableReason})`;
    console.log(`${result.status === 'scanned' ? '✅' : '⚠️'} ${target.id}: ${label}`);
    return result.status === 'scanned' || result.expectedUnavailable ? 0 : 2;
  }
  if (command === 'aggregate') {
    const outDir = need('out');
    const verdict = evidence.verifyEvidenceDir({ evidenceRoot: need('in'), root: REPO_ROOT });
    fs.mkdirSync(outDir, { recursive: true });
    const sourceCommit = verdict.results.find((r) => r.sourceCommit)?.sourceCommit ?? '';
    const summary = {
      schemaVersion: evidence.SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      sourceCommit,
      complete: verdict.current,
      problems: verdict.problems,
      targets: verdict.results.map((r) => ({ targetId: r.targetId, status: r.status, unavailableReason: r.unavailableReason ?? null, findings: r.findings?.total ?? null })),
    };
    fs.writeFileSync(path.join(outDir, 'coverage-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    const markdown = renderSummary({ results: verdict.results, problems: verdict.problems, sourceCommit });
    fs.writeFileSync(path.join(outDir, 'summary.md'), markdown);
    process.stdout.write(markdown);
    return verdict.current ? 0 : 2;
  }
  if (command === 'selftest') {
    const summary = selfTest({ outDir: need('out') });
    for (const c of summary.controls) console.log(`${c.passed ? '✅' : '❌'} ${c.name}: ${c.status}${c.reason ? ` (${c.reason})` : ''}`);
    return summary.passed ? 0 : 1;
  }
  throw new Error('usage: image-security-scan.js <plan|scan|aggregate|selftest> [--flag value]...');
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(`❌ ${/** @type {Error} */ (err).message}`);
    process.exitCode = 1;
  }
}

module.exports = { scanTarget, selfTest, renderSummary };
