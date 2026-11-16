// @ts-check
/**
 * Evidence model for the container-image vulnerability scans (issue #1951).
 *
 * One module owns three things so the workflow, the scan CLI and the
 * dependency-audit verifier cannot drift apart:
 *   - the target plan, derived from the checked-in recipes (Dockerfile, Umbrel
 *     manifest, storage smoke test) instead of copied image references;
 *   - the recipe hashes and age rules that decide whether stored evidence still
 *     describes today's repository;
 *   - the per-target `result.json` contract, where every target is either
 *     `scanned` or `unavailable` with a reason. Unavailable is never an empty
 *     finding set: a missing scanner, registry refusal, build failure or empty
 *     inventory must not be readable as "zero vulnerabilities".
 *
 * Pure functions only (file reads aside); no network, no scanner invocation.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
/** Evidence older than this is not "current" for a dependency audit. */
const MAX_EVIDENCE_AGE_DAYS = 14;
const MS_PER_DAY = 86_400_000;
/** Tolerated clock skew between the runner that wrote the evidence and the verifier. */
const FUTURE_SKEW_MS = 5 * 60_000;
/** Every file a scanned target must record and hash; a result that omits one is incomplete. */
const SCAN_ARTIFACTS = ['syft.json', 'grype.json', 'os-inventory.json', 'app-inventory.json', 'findings.json'];
/** The scanner controls' summary, which the aggregate job places in the evidence bundle. */
const SELFTEST_FILE = 'selftest.json';

/** Files whose content defines what the scanned images contain. */
const RECIPE_FILES = [
  'Dockerfile',
  'docker-compose.yml',
  'docker-entrypoint.sh',
  'umbrel/docker-compose.yml',
  'package.json',
  'package-lock.json',
  'admin/package.json',
  'admin/package-lock.json',
  'docker/pm2/package.json',
  'docker/pm2/package-lock.json',
  'scripts/docker-storage-smoke-test.sh',
];

const PLATFORMS = ['linux/amd64', 'linux/arm64'];

/** Unavailable-coverage reasons. Anything else is rejected as a malformed result. */
const UNAVAILABLE_REASONS = [
  'architecture_unsupported',
  'architecture_mismatch',
  'build_failed',
  'authentication_failed',
  'image_not_found',
  'scanner_unavailable',
  'scanner_database_unavailable',
  'scanner_failed',
  'inventory_failed',
];

/** @param {string|Buffer} data */
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** @param {string} file */
const sha256File = (file) => sha256(fs.readFileSync(file));

/** @param {string} root */
function computeRecipeHashes(root) {
  /** @type {Record<string,string>} */
  const hashes = {};
  for (const rel of RECIPE_FILES) {
    hashes[rel] = sha256File(path.join(root, rel));
  }
  return hashes;
}

/**
 * The digest-pinned image the Umbrel app store installs.
 * @param {string} root
 */
function readUmbrelImage(root) {
  const text = fs.readFileSync(path.join(root, 'umbrel/docker-compose.yml'), 'utf8');
  const m = text.match(/^\s*image:\s*(\S+?)@(sha256:[0-9a-f]{64})\s*$/m);
  if (!m) throw new Error('umbrel/docker-compose.yml must pin its image by sha256 digest');
  return { reference: m[1], digest: m[2] };
}

/**
 * Default helper images used by the disposable storage smoke test.
 * @param {string} root
 */
function readStorageFixtureImages(root) {
  const text = fs.readFileSync(path.join(root, 'scripts/docker-storage-smoke-test.sh'), 'utf8');
  const pick = (/** @type {string} */ name) => {
    const m = text.match(new RegExp(`^${name}="\\$\\{${name}:-([^}"]+)\\}"`, 'm'));
    if (!m) throw new Error(`docker-storage-smoke-test.sh no longer defaults ${name}`);
    return m[1];
  };
  return { alpine: pick('ALPINE_IMAGE'), node: pick('NODE_IMAGE') };
}

/** @param {string} platform */
const archOf = (platform) => platform.split('/')[1];

/**
 * Every target the workflow covers. Ids are stable: the verifier requires all of them.
 * @param {string} root
 */
function buildTargetPlan(root) {
  const umbrel = readUmbrelImage(root);
  const fixtures = readStorageFixtureImages(root);
  /** @type {any[]} */
  const targets = [];
  for (const platform of PLATFORMS) {
    const arch = archOf(platform);
    targets.push({
      id: `runtime-${arch}`,
      kind: 'runtime',
      description: 'Final stage of Dockerfile (also used by docker-compose.yml)',
      platform,
      build: true,
      dockerTarget: '',
      require: ['os', 'app'],
      requirePackages: ['npm:pm2', 'npm:pm2-logrotate'],
    });
    if (platform === 'linux/amd64') {
      targets.push({
        id: `builder-${arch}`,
        kind: 'builder',
        description: 'Builder stage of Dockerfile (admin UI build toolchain)',
        platform,
        build: true,
        dockerTarget: 'builder',
        require: ['os', 'app'],
        requirePackages: [],
      });
    } else {
      targets.push({
        id: `builder-${arch}`,
        kind: 'builder',
        description: 'Builder stage of Dockerfile (admin UI build toolchain)',
        platform,
        build: false,
        unsupportedReason:
          'The builder stage is pinned to $BUILDPLATFORM and runs only on the amd64 CI host; it is not shipped for this architecture',
        require: [],
        requirePackages: [],
      });
    }
    targets.push({
      id: `umbrel-${arch}`,
      kind: 'umbrel',
      description: 'Digest-pinned image installed by umbrel/docker-compose.yml',
      platform,
      build: false,
      source: `registry:${umbrel.reference}@${umbrel.digest}`,
      expectDigest: umbrel.digest,
      require: ['os', 'app'],
      requirePackages: ['npm:pm2'],
    });
    targets.push({
      id: `fixture-alpine-${arch}`,
      kind: 'fixture',
      description: 'Disposable storage smoke-test helper (test-only)',
      platform,
      build: false,
      source: `registry:${fixtures.alpine}`,
      require: ['os'],
      requirePackages: [],
    });
    targets.push({
      id: `fixture-node-${arch}`,
      kind: 'fixture',
      description: 'Entrypoint smoke-test image (test-only)',
      platform,
      build: false,
      source: `registry:${fixtures.node}`,
      require: ['os'],
      requirePackages: [],
    });
  }
  return targets;
}

/**
 * Split syft-json artifacts into OS packages and application dependencies.
 * @param {any} syft
 */
function splitInventory(syft) {
  const OS_TYPES = new Set(['apk', 'deb', 'rpm', 'alpm', 'portage', 'nix', 'opkg']);
  const os = [];
  const app = [];
  for (const a of Array.isArray(syft?.artifacts) ? syft.artifacts : []) {
    const entry = {
      type: String(a.type ?? ''),
      name: String(a.name ?? ''),
      version: String(a.version ?? ''),
      purl: typeof a.purl === 'string' ? a.purl : '',
      locations: (Array.isArray(a.locations) ? a.locations : [])
        .map((/** @type {any} */ l) => String(l?.path ?? ''))
        .filter(Boolean),
    };
    (OS_TYPES.has(entry.type) ? os : app).push(entry);
  }
  const byKey = (/** @type {any} */ a, /** @type {any} */ b) =>
    a.type.localeCompare(b.type) || a.name.localeCompare(b.name) || a.version.localeCompare(b.version);
  return { os: os.sort(byKey), app: app.sort(byKey) };
}

/**
 * All-severity findings, reduced to the fields a reviewer triages on.
 * @param {any} grype
 */
function normalizeFindings(grype) {
  const matches = Array.isArray(grype?.matches) ? grype.matches : [];
  const findings = matches.map((/** @type {any} */ m) => ({
    id: String(m.vulnerability?.id ?? ''),
    severity: String(m.vulnerability?.severity ?? 'Unknown'),
    package: String(m.artifact?.name ?? ''),
    version: String(m.artifact?.version ?? ''),
    type: String(m.artifact?.type ?? ''),
    purl: typeof m.artifact?.purl === 'string' ? m.artifact.purl : '',
    fixState: String(m.vulnerability?.fix?.state ?? 'unknown'),
    fixedIn: Array.isArray(m.vulnerability?.fix?.versions) ? m.vulnerability.fix.versions.map(String) : [],
    dataSource: String(m.vulnerability?.dataSource ?? ''),
  }));
  findings.sort((a, b) => `${a.severity}${a.id}${a.package}`.localeCompare(`${b.severity}${b.id}${b.package}`));
  return findings;
}

/** @param {{severity:string}[]} findings */
function countBySeverity(findings) {
  /** @type {Record<string,number>} */
  const counts = {};
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  return counts;
}

/**
 * Map scanner stderr onto an unavailable reason. Order matters: a refused
 * credential must not be reported as a missing image.
 * @param {string} stderr
 * @returns {'authentication_failed'|'image_not_found'|'architecture_mismatch'|'inventory_failed'}
 */
function classifyFetchFailure(stderr) {
  if (/unauthorized|denied|forbidden|\b40[13]\b|authentication required|requires authentication|login/i.test(stderr)) {
    return 'authentication_failed';
  }
  if (/no child with platform|platform .*not (found|available)|unsupported platform|no matching manifest/i.test(stderr)) {
    return 'architecture_mismatch';
  }
  if (/manifest unknown|not found|\b404\b|name unknown|no such (image|file)/i.test(stderr)) {
    return 'image_not_found';
  }
  return 'inventory_failed';
}

/** One-line, bounded, newline-free scanner diagnostics for result.json. */
function tidyDetail(/** @type {string} */ text) {
  const plain = text.replace(/\u001b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim();
  return plain.length > 500 ? `${plain.slice(0, 497)}...` : plain;
}

/**
 * Build the result.json for a target that could not be scanned.
 * @param {{target:any, reason:string, detail?:string, expected?:boolean, now?:Date, context:any}} p
 */
function unavailableResult({ target, reason, detail = '', expected = false, now = new Date(), context }) {
  if (!UNAVAILABLE_REASONS.includes(reason)) throw new Error(`unknown unavailable reason: ${reason}`);
  return {
    schemaVersion: SCHEMA_VERSION,
    targetId: target.id,
    kind: target.kind,
    platform: target.platform,
    status: 'unavailable',
    unavailableReason: reason,
    expectedUnavailable: expected,
    detail: tidyDetail(detail),
    generatedAt: now.toISOString(),
    ...context,
  };
}

/**
 * Decide whether a result.json set describes the checkout at `root` today.
 * Returns every problem found so a maintainer can fix them in one pass.
 *
 * @param {{results:any[], root:string, now?:Date, maxAgeDays?:number, fileHashes?:(r:any)=>Record<string,string|null>}} p
 */
function verifyEvidence({ results, root, now = new Date(), maxAgeDays = MAX_EVIDENCE_AGE_DAYS, fileHashes }) {
  /** @type {string[]} */
  const problems = [];
  const plan = buildTargetPlan(root);
  const recipe = computeRecipeHashes(root);
  const umbrel = readUmbrelImage(root);
  const byId = new Map(results.map((r) => [r?.targetId, r]));

  for (const target of plan) {
    const r = byId.get(target.id);
    const tag = `[${target.id}]`;
    if (!r) {
      problems.push(`${tag} no evidence recorded for this target`);
      continue;
    }
    if (r.schemaVersion !== SCHEMA_VERSION) problems.push(`${tag} unsupported schemaVersion ${r.schemaVersion}`);
    if (r.platform !== target.platform) problems.push(`${tag} evidence is for ${r.platform}, expected ${target.platform}`);

    const at = Date.parse(r.generatedAt);
    if (Number.isNaN(at)) {
      problems.push(`${tag} generatedAt is missing or invalid`);
    } else if (at - now.getTime() > FUTURE_SKEW_MS) {
      problems.push(`${tag} generatedAt is in the future`);
    } else if (now.getTime() - at > maxAgeDays * MS_PER_DAY) {
      problems.push(`${tag} evidence is older than ${maxAgeDays} days (${r.generatedAt})`);
    }

    for (const [file, hash] of Object.entries(recipe)) {
      if (r.recipe?.[file] !== hash) problems.push(`${tag} recipe hash mismatch for ${file}`);
    }

    if (r.status === 'unavailable') {
      if (!(r.expectedUnavailable === true && target.unsupportedReason)) {
        problems.push(`${tag} coverage unavailable: ${r.unavailableReason ?? 'unknown'}`);
      }
      continue;
    }
    if (target.unsupportedReason) problems.push(`${tag} must be recorded as unavailable (unsupported architecture)`);
    if (r.status !== 'scanned') {
      problems.push(`${tag} status must be scanned or unavailable, got ${r.status}`);
      continue;
    }

    const requireOs = target.require.includes('os');
    const requireApp = target.require.includes('app');
    if (requireOs && !(r.inventory?.osPackages > 0)) problems.push(`${tag} OS inventory is empty`);
    if (requireApp && !(r.inventory?.appPackages > 0)) problems.push(`${tag} application inventory is empty`);
    for (const pkg of target.requirePackages) {
      if (!r.inventory?.requiredPackagesFound?.includes(pkg)) problems.push(`${tag} inventory lacks required package ${pkg}`);
    }
    if (!r.image?.manifestDigest) problems.push(`${tag} image manifest digest was not recorded`);
    if (target.kind === 'umbrel' && r.image?.requestedDigest !== umbrel.digest) {
      problems.push(`${tag} scanned image digest ${r.image?.requestedDigest} does not match umbrel/docker-compose.yml (${umbrel.digest})`);
    }
    if (!r.scanner?.grype?.db?.built) problems.push(`${tag} scanner database build time was not recorded`);
    if (!r.scanner?.syft?.version || !r.scanner?.grype?.version) problems.push(`${tag} scanner versions were not recorded`);
    if (!(r.findings?.total >= 0) || !r.sourceCommit) problems.push(`${tag} findings count or source commit missing`);
    for (const name of SCAN_ARTIFACTS) {
      if (typeof r.artifacts?.[name] !== 'string') problems.push(`${tag} artifact ${name} is not recorded`);
    }

    if (fileHashes) {
      const actual = fileHashes(r);
      for (const [name, expected] of Object.entries(r.artifacts ?? {})) {
        if (actual[name] !== expected) problems.push(`${tag} artifact ${name} is missing or does not match its recorded hash`);
      }
    }
  }

  const known = new Set(plan.map((t) => t.id));
  for (const r of results) {
    if (!known.has(r?.targetId)) problems.push(`[${r?.targetId}] evidence for a target that is not in the current plan`);
  }
  return { current: problems.length === 0, problems };
}

/**
 * Read every `<dir>/result.json` directly under, or one level below, the
 * evidence root (artifact downloads add one directory per target).
 * @param {string} evidenceRoot
 */
function loadEvidenceDir(evidenceRoot) {
  const dirs = [evidenceRoot];
  for (const entry of fs.readdirSync(evidenceRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) dirs.push(path.join(evidenceRoot, entry.name));
  }
  /** @type {any[]} */
  const results = [];
  /** @type {Map<string,string>} */
  const dirByTarget = new Map();
  /** @type {string[]} */
  const errors = [];
  for (const dir of dirs) {
    const file = path.join(dir, 'result.json');
    if (!fs.existsSync(file)) continue;
    try {
      const result = JSON.parse(fs.readFileSync(file, 'utf8'));
      results.push(result);
      dirByTarget.set(result.targetId, dir);
    } catch (err) {
      errors.push(`${path.relative(evidenceRoot, file) || 'result.json'} is not valid JSON: ${/** @type {Error} */ (err).message}`);
    }
  }
  return { results, dirByTarget, errors };
}

/**
 * The scanner controls must have passed in the same run: findings of zero mean
 * nothing if the vulnerable fixture went undetected (e.g. an empty Grype database).
 * Looks for selftest.json at the evidence root or one directory below it.
 * @param {{evidenceRoot:string, now:Date, maxAgeDays:number}} p
 * @returns {string[]}
 */
function verifySelfTest({ evidenceRoot, now, maxAgeDays }) {
  const candidates = [path.join(evidenceRoot, SELFTEST_FILE)];
  for (const entry of fs.readdirSync(evidenceRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) candidates.push(path.join(evidenceRoot, entry.name, SELFTEST_FILE));
  }
  const found = candidates.filter((file) => fs.existsSync(file));
  if (found.length === 0) return ['[selftest] no scanner control evidence (selftest.json) in the bundle'];
  if (found.length > 1) return ['[selftest] more than one selftest.json in the bundle'];
  let summary;
  try {
    summary = JSON.parse(fs.readFileSync(found[0], 'utf8'));
  } catch (err) {
    return [`[selftest] selftest.json is not valid JSON: ${/** @type {Error} */ (err).message}`];
  }
  /** @type {string[]} */
  const problems = [];
  if (summary?.passed !== true) problems.push('[selftest] scanner controls did not pass, so zero findings cannot be trusted');
  const at = Date.parse(summary?.generatedAt);
  if (Number.isNaN(at)) problems.push('[selftest] generatedAt is missing or invalid');
  else if (at - now.getTime() > FUTURE_SKEW_MS) problems.push('[selftest] generatedAt is in the future');
  else if (now.getTime() - at > maxAgeDays * MS_PER_DAY) problems.push(`[selftest] control evidence is older than ${maxAgeDays} days (${summary.generatedAt})`);
  return problems;
}

/**
 * verifyEvidence over an evidence directory, including artifact hash checks
 * and the scanner controls' result.
 * @param {{evidenceRoot:string, root:string, now?:Date, maxAgeDays?:number}} p
 */
function verifyEvidenceDir({ evidenceRoot, root, now = new Date(), maxAgeDays = MAX_EVIDENCE_AGE_DAYS }) {
  const { results, dirByTarget, errors } = loadEvidenceDir(evidenceRoot);
  const selfTestProblems = verifySelfTest({ evidenceRoot, now, maxAgeDays });
  const verdict = verifyEvidence({
    results,
    root,
    now,
    maxAgeDays,
    fileHashes: (r) => {
      /** @type {Record<string,string|null>} */
      const out = {};
      const dir = dirByTarget.get(r.targetId);
      for (const name of Object.keys(r.artifacts ?? {})) {
        const file = dir ? path.join(dir, path.basename(name)) : '';
        out[name] = file && fs.existsSync(file) ? sha256File(file) : null;
      }
      return out;
    },
  });
  const problems = [...errors, ...verdict.problems, ...selfTestProblems];
  return { results, current: problems.length === 0, problems };
}

module.exports = {
  loadEvidenceDir,
  verifyEvidenceDir,
  SCHEMA_VERSION,
  MAX_EVIDENCE_AGE_DAYS,
  SCAN_ARTIFACTS,
  SELFTEST_FILE,
  RECIPE_FILES,
  PLATFORMS,
  archOf,
  UNAVAILABLE_REASONS,
  sha256,
  sha256File,
  computeRecipeHashes,
  readUmbrelImage,
  readStorageFixtureImages,
  buildTargetPlan,
  splitInventory,
  normalizeFindings,
  countBySeverity,
  classifyFetchFailure,
  tidyDetail,
  unavailableResult,
  verifyEvidence,
};
