// @ts-check
// Packaging contract for the Umbrel manifests (issue #915).
//
// The Umbrel proxy routes dashboard traffic to APP_PORT, but the image it
// selects is pinned separately. The August 2026 port migration (5563 -> 5570)
// updated APP_PORT without moving the pinned image, so the manifests routed to
// a port that the selected release never listened on. This suite ties the three
// moving parts together offline: the gateway port in ecosystem.config.cjs, the
// Dockerfile's exposed port, and the version/port/digest recorded in both Umbrel
// manifests. It reads checked-in files only — no registry, network, credentials
// or exchange calls.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PORTS } = require('../ecosystem.config.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const IMAGE_REPOSITORY = 'ghcr.io/atomantic/critical-mass';
// First published release whose gateway listens on PORTS.API (5570). Every
// earlier tag listens on 5563 and cannot serve the Umbrel proxy.
const MIN_RELEASE_FOR_GATEWAY_PORT = '2.24.0';

const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/** @param {string} text @param {RegExp} re @param {string} what */
function capture(text, re, what) {
  const m = text.match(re);
  assert.ok(m, `expected to find ${what}`);
  return m[1];
}

/** @param {string} a @param {string} b */
function compareSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function loadContract() {
  const compose = read('umbrel/docker-compose.yml');
  const app = read('umbrel/umbrel-app.yml');
  const dockerfile = read('Dockerfile');

  const image = capture(compose, /^\s*image:\s*(\S+)\s*$/m, 'web image in umbrel/docker-compose.yml');
  const imageMatch = image.match(/^([^:@]+):v(\d+\.\d+\.\d+)@(sha256:[0-9a-f]{64})$/);
  assert.ok(imageMatch, `image must be pinned as ${IMAGE_REPOSITORY}:vX.Y.Z@sha256:<digest>, got ${image}`);

  return {
    imageRepository: imageMatch[1],
    imageVersion: imageMatch[2],
    imageDigest: imageMatch[3],
    appPort: Number(capture(compose, /^\s*APP_PORT:\s*(\d+)\s*$/m, 'APP_PORT in umbrel/docker-compose.yml')),
    manifestVersion: capture(app, /^version:\s*"?(\d+\.\d+\.\d+)"?\s*$/m, 'version in umbrel/umbrel-app.yml'),
    manifestPort: Number(capture(app, /^port:\s*(\d+)\s*$/m, 'port in umbrel/umbrel-app.yml')),
    exposedPort: Number(capture(dockerfile, /^EXPOSE\s+(\d+)\s*$/m, 'EXPOSE in Dockerfile')),
    composeOverridesPort: /^\s*-\s*PORT=/m.test(compose),
  };
}

describe('Umbrel packaging contract', () => {
  const contract = loadContract();

  it('selects an immutable release image from the project registry, pinned by digest', () => {
    assert.equal(contract.imageRepository, IMAGE_REPOSITORY);
    assert.match(contract.imageDigest, /^sha256:[0-9a-f]{64}$/);
  });

  it('records the same application version in both Umbrel manifests', () => {
    assert.equal(contract.manifestVersion, contract.imageVersion,
      'umbrel-app.yml version must match the docker-compose.yml image tag');
  });

  it('selects a release whose gateway listens on the current API port', () => {
    assert.ok(compareSemver(contract.imageVersion, MIN_RELEASE_FOR_GATEWAY_PORT) >= 0,
      `v${contract.imageVersion} predates the gateway port migration; select >= v${MIN_RELEASE_FOR_GATEWAY_PORT}`);
  });

  it('routes the Umbrel proxy to the gateway port the image exposes and listens on', () => {
    assert.equal(contract.exposedPort, PORTS.API, 'Dockerfile EXPOSE must match ecosystem.config.cjs PORTS.API');
    assert.equal(contract.appPort, PORTS.API, 'app_proxy APP_PORT must match the gateway port');
    assert.equal(contract.manifestPort, PORTS.API, 'umbrel-app.yml port must match the gateway port');
    assert.equal(contract.composeOverridesPort, false,
      'docker-compose.yml must not override PORT; the proxy contract relies on the image default');
  });
});
