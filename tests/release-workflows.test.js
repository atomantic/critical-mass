const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const dockerWorkflow = fs.readFileSync(
  path.join(root, '.github/workflows/docker-build.yml'),
  'utf8',
);
const releaseWorkflow = fs.readFileSync(
  path.join(root, '.github/workflows/release.yml'),
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
  assert.match(dockerWorkflow, /ref: \$\{\{ inputs\.release_tag \}\}/);
});

test('Docker workflow validates the exact immutable source and publishes both architectures', () => {
  assert.match(dockerWorkflow, /name: Verify immutable release tag/);
  assert.match(dockerWorkflow, /refs\/tags\/\$\{RELEASE_TAG\}\^\{commit\}/);
  assert.match(dockerWorkflow, /TAG_COMMIT.*CHECKED_OUT_COMMIT/s);
  assert.match(dockerWorkflow, /platforms: linux\/amd64,linux\/arm64/);
  assert.match(dockerWorkflow, /org\.opencontainers\.image\.revision=\$\{\{ steps\.source\.outputs\.revision \}\}/);
});

test('Docker packages permission is limited to the publication job', () => {
  assert.match(dockerWorkflow, /^permissions: \{\}$/m);
  assert.equal((dockerWorkflow.match(/packages: write/g) || []).length, 1);
  assert.match(dockerWorkflow, /build-and-push:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      packages: write/);
});

test('release workflow passes only newly-created version tags to publication', () => {
  assert.match(releaseWorkflow, /outputs:\n      release_tag: \$\{\{ steps\.package-version\.outputs\.release_tag \}\}\n      release_created: \$\{\{ steps\.tag-check\.outputs\.exists == 'false' \}\}/);
  assert.match(releaseWorkflow, /publish-image:\n    name: Publish release image\n    needs: release\n    if: \$\{\{ needs\.release\.result == 'success' && needs\.release\.outputs\.release_created == 'true' \}\}/);
  assert.match(releaseWorkflow, /uses: \.\/\.github\/workflows\/docker-build\.yml\n    with:\n      release_tag: \$\{\{ needs\.release\.outputs\.release_tag \}\}/);
  assert.match(releaseWorkflow, /publish-image:[\s\S]*?permissions:\n      contents: read\n      packages: write/);
  assert.equal((releaseWorkflow.match(/packages: write/g) || []).length, 1);
});

test('release documentation covers image recovery and source verification', () => {
  assert.match(releaseDocs, /docker buildx imagetools inspect/);
  assert.match(releaseDocs, /linux\/amd64/);
  assert.match(releaseDocs, /linux\/arm64/);
  assert.match(releaseDocs, /org\.opencontainers\.image\.revision/);
  assert.match(releaseDocs, /docker pull --platform/);
  assert.match(releaseDocs, /Actions → Docker Build → Run workflow/);
  assert.match(releaseDocs, /immutable tag/);
});
