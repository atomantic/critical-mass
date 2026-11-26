const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const os = require('node:os');

const root = path.join(__dirname, '..');
const dockerWorkflow = fs.readFileSync(
  path.join(root, '.github/workflows/docker-build.yml'),
  'utf8',
);
const dockerCheckWorkflow = fs.readFileSync(
  path.join(root, '.github/workflows/docker-check.yml'),
  'utf8',
);
const releaseWorkflow = fs.readFileSync(
  path.join(root, '.github/workflows/release.yml'),
  'utf8',
);
const ciWorkflow = fs.readFileSync(
  path.join(root, '.github/workflows/ci.yml'),
  'utf8',
);
const releaseDocs = fs.readFileSync(
  path.join(root, 'docs/RELEASING.md'),
  'utf8',
);

test('Docker workflow accepts reusable and manual release-tag invocations', () => {
  assert.match(dockerWorkflow, /on:\n  workflow_call:\n    inputs:\n      release_tag:/);
  assert.match(dockerWorkflow, /\n  workflow_dispatch:\n    inputs:\n      release_tag:/);
  assert.doesNotMatch(dockerWorkflow, /\n  push:/);
  assert.match(dockerWorkflow, /ref: refs\/tags\/\$\{\{ inputs\.release_tag \}\}/);
});

test('Docker workflow validates the exact immutable source and publishes both architectures', () => {
  assert.match(dockerWorkflow, /name: Verify immutable release tag/);
  assert.match(dockerWorkflow, /refs\/tags\/\$\{RELEASE_TAG\}\^\{commit\}/);
  assert.match(dockerWorkflow, /TAG_COMMIT.*CHECKED_OUT_COMMIT/s);
  assert.match(dockerWorkflow, /arch: amd64\n            runner: ubuntu-latest/);
  assert.match(dockerWorkflow, /arch: arm64\n            runner: ubuntu-24\.04-arm/);
  assert.match(dockerWorkflow, /platforms: linux\/\$\{\{ matrix\.arch \}\}/);
  assert.match(dockerWorkflow, /outputs: type=image,[^\n]+push-by-digest=true,[^\n]+push=true/);
  assert.match(dockerWorkflow, /publish-manifest:\n    runs-on: ubuntu-latest\n    needs: build/);
  assert.doesNotMatch(dockerWorkflow, /setup-qemu|fetch-depth: 0/);
  assert.match(dockerWorkflow, /org\.opencontainers\.image\.revision=\$\{\{ steps\.source\.outputs\.revision \}\}/);
});

test('Docker packages permission is limited to digest and manifest publication jobs', () => {
  assert.match(dockerWorkflow, /^permissions: \{\}$/m);
  assert.equal((dockerWorkflow.match(/packages: write/g) || []).length, 2);
  assert.match(dockerWorkflow, /  build:[\s\S]*?permissions:\n      contents: read\n      packages: write/);
  assert.match(dockerWorkflow, /  publish-manifest:[\s\S]*?permissions:\n      packages: write/);
});

test('release workflow passes only newly-created version tags to publication', () => {
  assert.match(releaseWorkflow, /outputs:\n      release_tag: \$\{\{ steps\.package-version\.outputs\.release_tag \}\}\n      release_created: \$\{\{ steps\.tag-check\.outputs\.exists == 'false' \}\}/);
  assert.match(releaseWorkflow, /publish-image:\n    name: Publish release image\n    needs: release\n    if: \$\{\{ needs\.release\.result == 'success' && needs\.release\.outputs\.release_created == 'true' \}\}/);
  assert.match(releaseWorkflow, /uses: \.\/\.github\/workflows\/docker-build\.yml\n    with:\n      release_tag: \$\{\{ needs\.release\.outputs\.release_tag \}\}/);
  assert.match(releaseWorkflow, /publish-image:[\s\S]*?permissions:\n      contents: read\n      packages: write/);
  assert.equal((releaseWorkflow.match(/packages: write/g) || []).length, 1);
});

test('release runs only after CI succeeds on a main push, from the CI run head_sha', () => {
  assert.match(releaseWorkflow, /\non:\n  workflow_run:\n    workflows: \[CI\]\n    types: \[completed\]\n    branches: \[main\]\n/);
  assert.doesNotMatch(releaseWorkflow, /\n  push:/);
  assert.match(releaseWorkflow, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(releaseWorkflow, /github\.event\.workflow_run\.event == 'push'/);
  assert.match(releaseWorkflow, /github\.event\.workflow_run\.head_branch == 'main'/);
  assert.match(releaseWorkflow, /uses: actions\/checkout@[^\n]*\n        with:\n          ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.doesNotMatch(releaseWorkflow, /GITHUB_SHA|github\.sha/);
  assert.match(releaseWorkflow, /^permissions:\n  contents: read$/m);
  assert.equal((releaseWorkflow.match(/contents: write/g) || []).length, 1);
  assert.match(releaseWorkflow, /release:\n    runs-on: ubuntu-latest\n    # [^\n]*\n    if: [\s\S]*?permissions:\n      contents: write/);
  assert.match(releaseWorkflow, /workflows: \[CI\]/);
  assert.match(ciWorkflow, /^name: CI$/m);
});

test('CI keeps the required check name and cancels only superseded pull request runs', () => {
  assert.match(ciWorkflow, /\nconcurrency:\n  group: ci-\$\{\{ github\.event_name == 'pull_request' && github\.ref \|\| github\.sha \}\}\n  cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}\n/);
  assert.match(ciWorkflow, /  build:[\s\S]*?name: build \(26\.x\)[\s\S]*?needs: \[backend-tests, admin, typecheck\]\n    if: \$\{\{ always\(\) \}\}/);
  assert.equal((ciWorkflow.match(/node-version: 26\.x/g) || []).length, 3);
  assert.match(ciWorkflow, /  admin:[\s\S]*?cache-dependency-path: admin\/package-lock\.json/);
  const backendJob = ciWorkflow.match(/^  backend-tests:\n([\s\S]*?)(?=^  admin:)/m)?.[1];
  assert.ok(backendJob);
  assert.match(backendJob, /cache-dependency-path: package-lock\.json/);
  assert.match(backendJob, /run: npm ci\n\n      - name: Run backend tests\n        run: npm test/);
  assert.doesNotMatch(backendJob, /admin\/package-lock\.json|npm ci --prefix admin/);
  assert.match(ciWorkflow, /  typecheck:[\s\S]*?cache-dependency-path: package-lock\.json/);
  assert.doesNotMatch(ciWorkflow, /matrix:|\[skip ci\]|\bdev\b/);
  assert.match(releaseDocs, /workflow_run/);
});

test('release and registry login use the runner CLIs instead of third-party actions', () => {
  assert.doesNotMatch(releaseWorkflow, /softprops\//);
  assert.match(releaseWorkflow, /- name: Create Release\n        if: steps\.tag-check\.outputs\.exists == 'false'\n        env:\n          GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}\n          TAG: v\$\{\{ steps\.package-version\.outputs\.version \}\}\n          NOTES: \$\{\{ steps\.changelog\.outputs\.changelog \}\}\n          RELEASE_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}\n        run: \|\n          gh release create "\$TAG" --title "\$TAG" --notes "\$NOTES" --target "\$RELEASE_SHA"/);
  assert.doesNotMatch(releaseWorkflow, /gh release create[^\n]*(--draft|--prerelease)/);
  assert.doesNotMatch(dockerWorkflow, /docker\/login-action/);
  assert.match(dockerWorkflow, /REGISTRY_USER: \$\{\{ github\.repository_owner \}\}\n          REGISTRY_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}\n        run: echo "\$REGISTRY_TOKEN" \| docker login ghcr\.io -u "\$REGISTRY_USER" --password-stdin/);
  assert.ok(dockerWorkflow.indexOf('docker login ghcr.io') < dockerWorkflow.indexOf('docker/build-push-action'));
});

test('release documentation covers image verification and recovery', () => {
  assert.match(releaseDocs, /docker buildx imagetools inspect/);
  assert.match(releaseDocs, /linux\/amd64/);
  assert.match(releaseDocs, /linux\/arm64/);
  assert.match(releaseDocs, /Actions → Docker Build → Run workflow/);
  assert.match(releaseDocs, /immutable tag/);
});

function workflowScript(workflow, step) {
  const start = workflow.indexOf(`- name: ${step}\n`);
  assert.ok(start >= 0, `Found step ${step}`);
  const script = workflow.slice(start).match(/run: \|\n((?: {10}[^\n]*\n|\n)+)/);
  assert.ok(script, `Found shell script for ${step}`);
  return script[1].replace(/^ {10}/gm, '');
}

test('the required CI check fails for a non-success result in any dependency', () => {
  const script = workflowScript(ciWorkflow, 'Require all CI jobs to succeed');
  const success = { BACKEND: 'success', ADMIN: 'success', TYPECHECK: 'success' };
  const run = (env) => execFileSync('bash', ['-c', script], { env, stdio: 'pipe' });
  assert.doesNotThrow(() => run(success));
  for (const job of Object.keys(success)) {
    for (const result of ['failure', 'cancelled', 'skipped']) {
      assert.throws(() => run({ ...success, [job]: result }), { status: 1 });
    }
  }
});

const amd64Digest = 'sha256:' + 'a'.repeat(64);
const arm64Digest = 'sha256:' + 'b'.repeat(64);

function publishManifest(publishLatest, arm64Revision = 'release-sha') {
  const script = workflowScript(dockerWorkflow, 'Publish multi-arch manifest');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-'));
  try {
    for (const [arch, digest, revision] of [
      ['amd64', amd64Digest, 'release-sha'],
      ['arm64', arm64Digest, arm64Revision],
    ]) {
      const artifact = path.join(dir, `image-digest-${arch}`);
      fs.mkdirSync(artifact);
      fs.writeFileSync(path.join(artifact, 'image.txt'), `${digest} ${revision}\n`);
    }
    return execFileSync('bash', ['-c', 'docker() { printf "%s\\n" "$@"; }\n' + script], {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        IMAGE: 'ghcr.io/o/r',
        RELEASE_TAG: 'v1.2.3',
        PUBLISH_LATEST: publishLatest,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString().trim().split('\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('historical recovery publishes only the versioned tag; normal release also publishes latest', () => {
  for (const publishLatest of ['', 'false', 'true']) {
    assert.deepEqual(publishManifest(publishLatest), [
      'buildx', 'imagetools', 'create', '--tag', 'ghcr.io/o/r:v1.2.3',
      ...(publishLatest === 'true' ? ['--tag', 'ghcr.io/o/r:latest'] : []),
      `ghcr.io/o/r@${amd64Digest}`, `ghcr.io/o/r@${arm64Digest}`,
    ]);
  }
  assert.throws(() => publishManifest('true', 'different-sha'), /Release build revisions differ/);
  assert.match(dockerWorkflow, /publish_latest:\n        description: [^\n]*\n        required: false\n        default: false\n        type: boolean\n  workflow_dispatch:/);
  assert.doesNotMatch(dockerWorkflow.split('workflow_dispatch:')[1].split('permissions:')[0], /publish_latest/);
  assert.match(releaseWorkflow, /release_tag: \$\{\{ needs\.release\.outputs\.release_tag \}\}\n      publish_latest: \$\{\{ needs\.release\.outputs\.promote_latest == 'true' \}\}/);
  assert.match(releaseDocs, /leaves `latest` unchanged/);
});

test('Docker workflow fails unless both platforms are in the pushed manifest', () => {
  const step = dockerWorkflow.slice(dockerWorkflow.indexOf('- name: Verify multi-arch manifest'));
  assert.ok(step.length > 0);
  assert.match(step, /docker buildx imagetools inspect --raw "\$IMAGE_REF"/);
  assert.match(step, /for ARCH in amd64 arm64;/);
  assert.match(step, /exit 1/);
  // Must be the last step, after the push.
  assert.ok(dockerWorkflow.indexOf('docker/build-push-action') < dockerWorkflow.indexOf('Verify multi-arch manifest'));
  assert.match(dockerWorkflow, /Verify immutable release tag/);
});

test('Docker PR checks reuse the release amd64 cache and run all three smoke tests', () => {
  assert.match(dockerWorkflow, /arch: amd64[\s\S]*?cache: buildkit\n/);
  assert.match(dockerWorkflow, /arch: arm64[\s\S]*?cache: buildkit-arm64\n/);
  assert.match(dockerCheckWorkflow, /cache-from: \|\n\s+type=gha,scope=docker-check\n\s+type=gha\n/);
  assert.match(dockerCheckWorkflow, /cache-to: type=gha,mode=max,scope=docker-check/);
  for (const smoke of ['seed', 'storage', 'stop-order']) {
    assert.match(dockerCheckWorkflow, new RegExp(`npm run test:docker-${smoke}`));
  }
});

test('release tag lookup treats only a missing tag as permission to create one', () => {
  const script = workflowScript(releaseWorkflow, 'Check if tag exists');
  assert.match(script, /git ls-remote --exit-code --tags --refs origin "refs\/tags\/\$TAG"/);
  assert.doesNotMatch(releaseWorkflow, /fetch-depth: 0/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-tag-'));
  try {
    const out = path.join(dir, 'out');
    for (const [status, expected] of [[0, 'exists=true'], [2, 'exists=false'], [128, '']]) {
      fs.writeFileSync(out, '');
      const run = () => execFileSync('bash', ['-c', `git() { return ${status}; }\n${script}`], {
        env: { TAG: 'v1.2.3', GITHUB_OUTPUT: out },
        stdio: 'pipe',
      });
      if (status === 128) assert.throws(run, { status });
      else run();
      assert.equal(fs.readFileSync(out, 'utf8').trim(), expected);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('release fails before tagging when notes are missing, with no commit-list fallback', () => {
  const req = releaseWorkflow.indexOf('- name: Require release notes for new version');
  assert.ok(req > releaseWorkflow.indexOf('- name: Check if tag exists'));
  assert.ok(req < releaseWorkflow.indexOf('- name: Create Release'));
  assert.match(releaseWorkflow, /Require release notes for new version\n        if: steps\.tag-check\.outputs\.exists == 'false'/);
  assert.doesNotMatch(releaseWorkflow, /git log \$PREV_TAG|COMMIT_LOG/);
  assert.match(releaseDocs, /npm version X\.Y\.Z --no-git-tag-version/);
});

test('missing-notes step exits non-zero only for a new version without its notes file', () => {
  const m = releaseWorkflow.match(/- name: Require release notes for new version[\s\S]*?run: \|\n([\s\S]*?)\n\n      - name:/);
  assert.ok(m);
  const script = m[1].replace(/^ {10}/gm, '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-'));
  try {
    const run = () => execFileSync('bash', ['-c', script], { cwd: dir, env: { PATH: process.env.PATH, VERSION: '9.9.9' }, stdio: 'pipe' });
    assert.throws(run);
    fs.mkdirSync(path.join(dir, '.changelogs'));
    fs.writeFileSync(path.join(dir, '.changelogs/v9.9.9.md'), '# notes\n');
    assert.doesNotThrow(run);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const promoteScript = path.join(root, 'scripts/should-promote-latest.sh');
function promote(tag, existing) {
  return execFileSync('bash', [promoteScript, tag], {
    input: existing.join('\n') + '\n',
    env: { PATH: process.env.PATH },
  }).toString().trim();
}

test('latest is promoted only when the released version is the highest stable tag', () => {
  assert.equal(promote('v2.20.0', ['v2.19.2', 'v2.9.0', 'v1.0.0']), 'true');
  assert.equal(promote('v2.19.2', ['v2.20.0', 'v2.19.1']), 'false');
  assert.equal(promote('v2.9.0', ['v2.10.0']), 'false');
  assert.equal(promote('v2.10.0', ['v2.9.0']), 'true');
  assert.equal(promote('v1.0.0', []), 'true');
  assert.equal(promote('v1.0.0', ['v1.0.0']), 'true');
  assert.equal(promote('v2.20.0', ['v2.20.0', 'v2.19.2', 'v2.21.0-rc.1', 'nightly']), 'true');
  assert.equal(promote('v2.20.0-rc.1', ['v2.19.2']), 'false');
});

test('release promotes latest through the guard and keeps release creation unconditional', () => {
  const step = releaseWorkflow.slice(releaseWorkflow.indexOf('- name: Decide whether to promote latest'));
  assert.match(step, /if: steps\.tag-check\.outputs\.exists == 'false'/);
  assert.match(step, /git ls-remote --tags --refs origin/);
  assert.match(step, /scripts\/should-promote-latest\.sh "\$TAG"/);
  assert.ok(releaseWorkflow.indexOf('- name: Create Release') < releaseWorkflow.indexOf('- name: Decide whether to promote latest'));
  assert.match(releaseWorkflow, /promote_latest: \$\{\{ steps\.latest-check\.outputs\.promote \}\}/);
  assert.doesNotMatch(releaseWorkflow, /cancel-in-progress/);
});

test('release documentation explains the latest guard', () => {
  assert.match(releaseDocs, /highest stable/);
});
