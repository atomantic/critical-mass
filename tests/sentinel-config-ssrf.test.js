// @ts-check
/**
 * Tests for issue #215-A — PUT /api/sentinel/config must reject feed URLs
 * that point at private/reserved addresses (cloud metadata, loopback,
 * engine IPC ports, etc.) at config-write time, before they are ever
 * persisted or handed to the feed poller.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const registerSentinelRoutes = require('../src/routes/sentinel-routes');

const createFakeApp = () => {
  const handlers = {};
  const register = (method) => (route, handler) => { handlers[`${method} ${route}`] = handler; };
  return { handlers, get: register('GET'), put: register('PUT'), post: register('POST'), delete: register('DELETE') };
};

const createRes = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
});

const setup = () => {
  let updatedWith = null;
  let started = false;
  const app = createFakeApp();
  registerSentinelRoutes(app, {
    sentinelService: {
      getStatus: () => ({}),
      stop: () => { started = false; },
      start: () => { started = true; },
    },
    getSentinelConfig: () => ({ feeds: [] }),
    updateSentinelConfig: (updates) => { updatedWith = updates; },
  });
  return { app, getUpdatedWith: () => updatedWith, wasStarted: () => started };
};

const invoke = async (app, body) => {
  const res = createRes();
  await app.handlers['PUT /api/sentinel/config']({ body }, res);
  return res;
};

describe('PUT /api/sentinel/config rejects unsafe feed URLs (issue #215-A)', () => {
  it('rejects a feed pointing at cloud metadata', async () => {
    const { app, getUpdatedWith } = setup();
    const res = await invoke(app, { feeds: [{ name: 'evil', url: 'http://169.254.169.254/latest/meta-data/' }] });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.equal(getUpdatedWith(), null, 'must not persist config containing an unsafe feed URL');
  });

  it('rejects a feed pointing at loopback / engine IPC ports', async () => {
    const { app, getUpdatedWith } = setup();
    const res = await invoke(app, { feeds: [{ name: 'internal', url: 'http://127.0.0.1:5571/' }] });
    assert.equal(res.statusCode, 400);
    assert.equal(getUpdatedWith(), null);
  });

  it('rejects a non-string feed url', async () => {
    const { app } = setup();
    const res = await invoke(app, { feeds: [{ name: 'bad', url: 12345 }] });
    assert.equal(res.statusCode, 400);
  });

  it('rejects if any one feed in a multi-feed array is unsafe', async () => {
    const { app, getUpdatedWith } = setup();
    const res = await invoke(app, {
      feeds: [
        { name: 'ok', url: 'http://1.1.1.1/rss' },
        { name: 'evil', url: 'http://169.254.169.254/' },
      ],
    });
    assert.equal(res.statusCode, 400);
    assert.equal(getUpdatedWith(), null);
  });

  it('accepts a config update with safe feed URLs and persists it', async () => {
    const { app, getUpdatedWith, wasStarted } = setup();
    const res = await invoke(app, { feeds: [{ name: 'ok', url: 'http://1.1.1.1/rss' }] });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.ok(getUpdatedWith(), 'expected updateSentinelConfig to have been called');
    assert.equal(getUpdatedWith().feeds[0].url, 'http://1.1.1.1/rss');
    assert.equal(wasStarted(), true, 'service should be restarted after a successful config update');
  });

  it('accepts a config update that has no feeds key at all', async () => {
    const { app, getUpdatedWith } = setup();
    const res = await invoke(app, { enabled: false });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(getUpdatedWith(), { enabled: false });
  });
});
