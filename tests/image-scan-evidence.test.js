// @ts-check
// Contract for the container-image vulnerability scans (issue #1951).
//
// Runs the real scan driver and evidence verifier against stub Syft/Grype
// executables, so it needs no registry, scanner install, vulnerability database
// or network. It pins the guarantees the audit relies on: every target is either
// scanned with inventories + findings or unavailable with a reason (never a
// silent empty result), and stored evidence is rejected when stale or when it no
// longer describes the checked-in recipes and the pinned Umbrel image.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const evidence = require('../scripts/lib/image-scan-evidence');
const { scanTarget } = require('../scripts/image-security-scan');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const NOW = new Date('2026-11-16T12:00:00Z');
const DAY = 86_400_000;

// Stub scanners. Behavior is driven by environment variables so each test picks
// the failure it wants without rewriting the executables.
const STUB_SYFT = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('syft 1.55.0'); process.exit(0); }
if (process.env.STUB_SYFT_STDERR) { process.stderr.write(process.env.STUB_SYFT_STDERR); process.exit(1); }
const out = args.find((a) => a.startsWith('syft-json=')).slice('syft-json='.length);
const platformIdx = args.indexOf('--platform');
const arch = process.env.STUB_ARCH || (platformIdx === -1 ? 'amd64' : args[platformIdx + 1].split('/')[1]);
const artifacts = JSON.parse(process.env.STUB_ARTIFACTS);
fs.writeFileSync(out, JSON.stringify({
  artifacts,
  source: { type: 'image', metadata: { manifestDigest: 'sha256:' + 'a'.repeat(64), imageID: 'sha256:' + 'b'.repeat(64), repoDigests: [], tags: [], os: 'linux', architecture: arch } },
  distro: { name: 'alpine', version: '3.23' },
  descriptor: { name: 'syft', version: '1.55.0' },
}));
`;
const STUB_GRYPE = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'version') { console.log(JSON.stringify({ application: 'grype', version: '0.121.0' })); process.exit(0); }
if (args[0] === 'db' && args[1] === 'update') process.exit(0);
if (args[0] === 'db' && args[1] === 'status') {
  console.log(JSON.stringify({ schemaVersion: 'v6.1.10', built: process.env.STUB_DB_BUILT === 'none' ? '' : '2026-11-16T06:30:54Z', valid: process.env.STUB_DB_BUILT !== 'none' }));
  process.exit(0);
}
if (process.env.STUB_GRYPE_FAIL) { process.stderr.write('grype exploded'); process.exit(1); }
const out = args[args.indexOf('--file') + 1];
fs.writeFileSync(out, JSON.stringify({ matches: JSON.parse(process.env.STUB_MATCHES || '[]') }));
`;

const ARTIFACTS = [
  { type: 'apk', name: 'musl', version: '1.2.5-r1', purl: 'pkg:apk/alpine/musl@1.2.5-r1', locations: [{ path: '/lib/apk/db/installed' }] },
  { type: 'npm', name: 'pm2', version: '7.1.2', purl: 'pkg:npm/pm2@7.1.2', locations: [{ path: '/opt/pm2/node_modules/pm2/package.json' }] },
  { type: 'npm', name: 'pm2-logrotate', version: '3.0.1', purl: 'pkg:npm/pm2-logrotate@3.0.1', locations: [{ path: '/opt/pm2-home/modules/pm2-logrotate/package.json' }] },
];
const MATCHES = [
  { vulnerability: { id: 'CVE-2099-0001', severity: 'High', fix: { state: 'fixed', versions: ['1.2.5-r2'] } }, artifact: { name: 'musl', version: '1.2.5-r1', type: 'apk' } },
  { vulnerability: { id: 'CVE-2099-0002', severity: 'Negligible', fix: { state: 'not-fixed', versions: [] } }, artifact: { name: 'pm2', version: '7.1.2', type: 'npm' } },
];

describe('image scan evidence', () => {
  /** @type {string} */ let work;
  /** @type {NodeJS.ProcessEnv} */ let env;

  before(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'image-scan-test-'));
    for (const [name, body] of [['syft', STUB_SYFT], ['grype', STUB_GRYPE]]) {
      fs.writeFileSync(path.join(work, name), body, { mode: 0o755 });
    }
    env = {
      ...process.env,
      IMAGE_SCAN_SYFT_BIN: path.join(work, 'syft'),
      IMAGE_SCAN_GRYPE_BIN: path.join(work, 'grype'),
      IMAGE_SCAN_SKIP_DB_UPDATE: '1',
      GITHUB_SHA: 'c'.repeat(40),
      STUB_ARTIFACTS: JSON.stringify(ARTIFACTS),
      STUB_MATCHES: JSON.stringify(MATCHES),
    };
  });
  after(() => fs.rmSync(work, { recursive: true, force: true }));

  const plan = () => evidence.buildTargetPlan(ROOT);
  const target = (id) => plan().find((t) => t.id === id);
  const scan = (id, over = {}, envOver = {}) => {
    const outDir = path.join(work, `out-${id}-${Math.random().toString(36).slice(2)}`);
    const t = { ...target(id), ...over.target };
    const result = scanTarget({ target: t, outDir, source: over.source, upstreamFailure: over.upstreamFailure, now: NOW, env: { ...env, ...envOver } });
    return { result, outDir };
  };

  describe('target plan', () => {
    it('covers each recipe target on both published architectures, derived from the checked-in files', () => {
      const ids = plan().map((t) => t.id).sort();
      assert.deepEqual(ids, [
        'builder-amd64', 'builder-arm64', 'fixture-alpine-amd64', 'fixture-alpine-arm64', 'fixture-node-amd64', 'fixture-node-arm64',
        'runtime-amd64', 'runtime-arm64', 'umbrel-amd64', 'umbrel-arm64',
      ]);
      const umbrel = evidence.readUmbrelImage(ROOT);
      assert.equal(target('umbrel-arm64').source, `registry:${umbrel.reference}@${umbrel.digest}`);
      assert.match(target('fixture-alpine-amd64').source, /^registry:alpine:/);
      assert.deepEqual(target('runtime-arm64').requirePackages, ['npm:pm2', 'npm:pm2-logrotate']);
    });

    it('marks the builder stage unavailable on arm64 instead of silently omitting it', () => {
      assert.match(target('builder-arm64').unsupportedReason, /BUILDPLATFORM/);
      const { result, outDir } = scan('builder-arm64');
      assert.equal(result.status, 'unavailable');
      assert.equal(result.unavailableReason, 'architecture_unsupported');
      assert.equal(result.expectedUnavailable, true);
      assert.equal(fs.existsSync(path.join(outDir, 'findings.json')), false);
    });
  });

  describe('scan driver', () => {
    it('writes attributable inventories and all-severity findings for a built image', () => {
      const { result, outDir } = scan('runtime-amd64', { source: 'oci-archive:/dev/null' });
      assert.equal(result.status, 'scanned');
      assert.equal(result.inventory.osPackages, 1);
      assert.equal(result.inventory.appPackages, 2);
      assert.deepEqual(result.inventory.requiredPackagesFound, ['npm:pm2', 'npm:pm2-logrotate']);
      assert.deepEqual(result.findings, { total: 2, bySeverity: { High: 1, Negligible: 1 } });
      assert.equal(result.image.manifestDigest, `sha256:${'a'.repeat(64)}`);
      assert.equal(result.scanner.grype.db.built, '2026-11-16T06:30:54Z');
      assert.equal(result.scanner.syft.version, '1.55.0');
      assert.equal(result.sourceCommit, 'c'.repeat(40));
      assert.deepEqual(result.recipe, evidence.computeRecipeHashes(ROOT));
      for (const [name, hash] of Object.entries(result.artifacts)) {
        assert.equal(evidence.sha256File(path.join(outDir, name)), hash, name);
      }
      const osInv = JSON.parse(fs.readFileSync(path.join(outDir, 'os-inventory.json'), 'utf8'));
      const appInv = JSON.parse(fs.readFileSync(path.join(outDir, 'app-inventory.json'), 'utf8'));
      assert.deepEqual(osInv.map((p) => p.name), ['musl']);
      assert.deepEqual(appInv.map((p) => p.name), ['pm2', 'pm2-logrotate']);
    });

    it('records the pinned digest the Umbrel image was requested by', () => {
      const { result } = scan('umbrel-amd64');
      assert.equal(result.image.requestedDigest, evidence.readUmbrelImage(ROOT).digest);
    });

    /** Every unavailable outcome must be unmistakable: named reason, no findings anywhere. */
    const assertUnavailable = ({ result, outDir }, reason) => {
      assert.equal(result.status, 'unavailable');
      assert.equal(result.unavailableReason, reason);
      assert.equal(result.expectedUnavailable, false);
      assert.equal('findings' in result, false);
      assert.equal(fs.existsSync(path.join(outDir, 'findings.json')), false);
      assert.equal(fs.existsSync(path.join(outDir, 'result.json')), true);
    };

    it('reports a registry authentication refusal as unavailable', () => {
      assertUnavailable(scan('umbrel-amd64', {}, { STUB_SYFT_STDERR: 'GET https://ghcr.io/v2/: UNAUTHORIZED: authentication required' }), 'authentication_failed');
    });

    it('reports an unknown image as unavailable', () => {
      assertUnavailable(scan('umbrel-amd64', {}, { STUB_SYFT_STDERR: 'MANIFEST_UNKNOWN: manifest unknown' }), 'image_not_found');
    });

    it('reports a platform the image does not publish as unavailable', () => {
      assertUnavailable(scan('umbrel-arm64', {}, { STUB_SYFT_STDERR: 'no child with platform linux/arm64 in index' }), 'architecture_mismatch');
      assertUnavailable(scan('umbrel-arm64', {}, { STUB_ARCH: 'amd64' }), 'architecture_mismatch');
    });

    it('reports a failed upstream build as unavailable', () => {
      assertUnavailable(scan('runtime-arm64', { upstreamFailure: 'docker buildx build finished with outcome failure' }), 'build_failed');
    });

    it('reports a missing or broken scanner as unavailable', () => {
      assertUnavailable(scan('umbrel-amd64', {}, { IMAGE_SCAN_SYFT_BIN: path.join(work, 'missing-syft') }), 'scanner_unavailable');
      assertUnavailable(scan('umbrel-amd64', {}, { STUB_GRYPE_FAIL: '1' }), 'scanner_failed');
      assertUnavailable(scan('umbrel-amd64', {}, { STUB_DB_BUILT: 'none' }), 'scanner_database_unavailable');
    });

    it('treats an empty or incomplete inventory as unavailable rather than zero findings', () => {
      assertUnavailable(scan('runtime-amd64', { source: 'oci-archive:/dev/null' }, { STUB_ARTIFACTS: '[]' }), 'inventory_failed');
      const noRotate = JSON.stringify(ARTIFACTS.filter((a) => a.name !== 'pm2-logrotate'));
      const r = scan('runtime-amd64', { source: 'oci-archive:/dev/null' }, { STUB_ARTIFACTS: noRotate });
      assertUnavailable(r, 'inventory_failed');
      assert.match(r.result.detail, /package npm:pm2-logrotate/);
      const osOnly = JSON.stringify(ARTIFACTS.filter((a) => a.type === 'apk'));
      assertUnavailable(scan('umbrel-amd64', {}, { STUB_ARTIFACTS: osOnly }), 'inventory_failed');
    });
  });

  describe('currency verification', () => {
    /** Scan every planned target into one evidence directory, as the aggregate job sees it. */
    const buildEvidence = (when = NOW) => {
      const dir = fs.mkdtempSync(path.join(work, 'evidence-'));
      for (const t of plan()) {
        scanTarget({
          target: t,
          outDir: path.join(dir, t.id),
          source: t.build ? 'oci-archive:/dev/null' : undefined,
          now: when,
          env: { ...env, STUB_ARCH: evidence.archOf(t.platform) },
        });
      }
      return dir;
    };
    const verify = (dir, now = NOW) => evidence.verifyEvidenceDir({ evidenceRoot: dir, root: ROOT, now });
    const patchResult = (dir, id, mutate) => {
      const file = path.join(dir, id, 'result.json');
      const r = JSON.parse(fs.readFileSync(file, 'utf8'));
      mutate(r);
      fs.writeFileSync(file, JSON.stringify(r));
    };

    it('accepts complete, fresh evidence for the current recipes', () => {
      const verdict = verify(buildEvidence());
      assert.deepEqual(verdict.problems, []);
      assert.equal(verdict.current, true);
    });

    it('rejects evidence older than 14 days but accepts it at the boundary', () => {
      const dir = buildEvidence();
      assert.equal(verify(dir, new Date(NOW.getTime() + 14 * DAY)).current, true);
      const stale = verify(dir, new Date(NOW.getTime() + 14 * DAY + 1000));
      assert.equal(stale.current, false);
      assert.match(stale.problems[0], /older than 14 days/);
    });

    it('rejects evidence stamped in the future', () => {
      const verdict = verify(buildEvidence(new Date(NOW.getTime() + DAY)));
      assert.equal(verdict.current, false);
      assert.ok(verdict.problems.some((p) => /in the future/.test(p)));
    });

    it('rejects evidence produced from different recipe files', () => {
      const dir = buildEvidence();
      patchResult(dir, 'runtime-amd64', (r) => { r.recipe.Dockerfile = '0'.repeat(64); });
      const verdict = verify(dir);
      assert.equal(verdict.current, false);
      assert.deepEqual(verdict.problems, ['[runtime-amd64] recipe hash mismatch for Dockerfile']);
    });

    it('rejects evidence for a different Umbrel image digest', () => {
      const dir = buildEvidence();
      patchResult(dir, 'umbrel-arm64', (r) => { r.image.requestedDigest = `sha256:${'9'.repeat(64)}`; });
      const verdict = verify(dir);
      assert.equal(verdict.current, false);
      assert.match(verdict.problems[0], /\[umbrel-arm64\] scanned image digest .* does not match umbrel\/docker-compose\.yml/);
    });

    it('rejects a missing target, unavailable coverage and an unexpected unavailable marker', () => {
      const dir = buildEvidence();
      fs.rmSync(path.join(dir, 'fixture-node-arm64'), { recursive: true });
      patchResult(dir, 'umbrel-amd64', (r) => {
        r.status = 'unavailable';
        r.unavailableReason = 'authentication_failed';
        delete r.findings;
      });
      patchResult(dir, 'builder-arm64', (r) => { r.expectedUnavailable = false; });
      const problems = verify(dir).problems;
      assert.ok(problems.includes('[fixture-node-arm64] no evidence recorded for this target'));
      assert.ok(problems.includes('[umbrel-amd64] coverage unavailable: authentication_failed'));
      assert.ok(problems.includes('[builder-arm64] coverage unavailable: architecture_unsupported'));
    });

    it('rejects evidence whose recorded inventory is empty or whose files were altered', () => {
      const dir = buildEvidence();
      patchResult(dir, 'runtime-amd64', (r) => { r.inventory.osPackages = 0; });
      fs.appendFileSync(path.join(dir, 'umbrel-amd64', 'findings.json'), ' ');
      const problems = verify(dir).problems;
      assert.ok(problems.includes('[runtime-amd64] OS inventory is empty'));
      assert.ok(problems.includes('[umbrel-amd64] artifact findings.json is missing or does not match its recorded hash'));
    });

    it('rejects unreadable result files', () => {
      const dir = buildEvidence();
      fs.writeFileSync(path.join(dir, 'runtime-arm64', 'result.json'), '{');
      assert.equal(verify(dir).current, false);
    });

    it('exposes the verdict through the audit CLI exit status', () => {
      const dir = buildEvidence(new Date());
      const cli = path.join(ROOT, 'scripts/verify-image-scan-evidence.js');
      const ok = spawnSync(process.execPath, [cli, dir], { encoding: 'utf8' });
      assert.equal(ok.status, 0, ok.stdout + ok.stderr);
      assert.equal(JSON.parse(ok.stdout).current, true);
      const stale = spawnSync(process.execPath, [cli, dir, '--now', new Date(Date.now() + 15 * DAY).toISOString()], { encoding: 'utf8' });
      assert.equal(stale.status, 1);
      assert.equal(JSON.parse(stale.stdout).current, false);
    });
  });

  describe('workflow and tooling contract', () => {
    const workflow = read('.github/workflows/image-security.yml');

    it('runs on a schedule and manually with least-privilege permissions', () => {
      assert.match(workflow, /on:\n  schedule:\n(?:    #[^\n]*\n)*    - cron: '[^']+'\n  workflow_dispatch:/);
      assert.match(workflow, /^permissions: \{\}$/m);
      assert.doesNotMatch(workflow, /packages: write|contents: write/);
      assert.doesNotMatch(workflow, /pull_request/);
    });

    it('pins every action to a full commit SHA', () => {
      const uses = [...workflow.matchAll(/uses:\s+(\S+)/g)].map((m) => m[1]);
      assert.ok(uses.length >= 6);
      for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, u);
    });

    it('builds both Dockerfile stages and scans the digest-pinned Umbrel image through the shared plan', () => {
      assert.match(workflow, /matrix: \$\{\{ fromJSON\(needs\.plan\.outputs\.matrix\) \}\}/);
      assert.match(workflow, /--output "type=oci,dest=\$RUNNER_TEMP\/image\.tar"/);
      assert.match(workflow, /--upstream-failure/);
      assert.doesNotMatch(workflow, /ghcr\.io\/atomantic\/critical-mass:v/);
    });

    it('runs the detection and unavailable-coverage controls and aggregates evidence even after failures', () => {
      assert.match(workflow, /image-security-scan\.js selftest/);
      assert.match(workflow, /aggregate:\n[\s\S]*?needs: \[plan, scan, selftest\]\n    if: always\(\)/);
      assert.match(workflow, /name: image-security-evidence/);
    });

    it('installs the scanner versions and hashes pinned in the install script', () => {
      const script = read('scripts/install-image-scanners.sh');
      assert.match(script, /^SYFT_VERSION="\d+\.\d+\.\d+"$/m);
      assert.match(script, /^GRYPE_VERSION="\d+\.\d+\.\d+"$/m);
      assert.equal((script.match(/echo [0-9a-f]{64} ;;/g) ?? []).length, 8);
      assert.match(script, /Checksum mismatch/);
    });

    it('documents the maintainer workflow', () => {
      const docs = read('docs/IMAGE_SECURITY.md');
      for (const needle of ['verify-image-scan-evidence.js', 'install-image-scanners.sh', '14 days', 'unavailable', 'native PM2']) {
        assert.ok(docs.includes(needle), `docs/IMAGE_SECURITY.md should mention ${needle}`);
      }
    });
  });
});
