// @ts-check
/**
 * Tests for issue #687 — PUT /api/sentinel/config only filtered top-level
 * keys and never value-checked them, so a string "enabled", a ~1ms
 * pollIntervalMs, a negative maxAlerts, or a non-array feeds (which also
 * silently skipped the SSRF check) all persisted verbatim and were handed
 * straight to the running poller/alert-trim logic in sentinel-service.js.
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
  const app = createFakeApp();
  registerSentinelRoutes(app, {
    sentinelService: {
      getStatus: () => ({}),
      stop: () => {},
      start: () => {},
    },
    getSentinelConfig: () => ({ feeds: [] }),
    updateSentinelConfig: (updates) => { updatedWith = updates; },
  });
  return { app, getUpdatedWith: () => updatedWith };
};

const invoke = async (app, body) => {
  const res = createRes();
  await app.handlers['PUT /api/sentinel/config']({ body }, res);
  return res;
};

describe('PUT /api/sentinel/config value-validates every key (issue #687)', () => {
  it('rejects a ~1ms pollIntervalMs', async () => {
    const { app, getUpdatedWith } = setup();
    const res = await invoke(app, { pollIntervalMs: 1 });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.equal(getUpdatedWith(), null, 'must never persist an unvalidated config');
  });

  it('rejects a pollIntervalMs above the 24h ceiling', async () => {
    const { app, getUpdatedWith } = setup();
    const res = await invoke(app, { pollIntervalMs: 999999999999 });
    assert.equal(res.statusCode, 400);
    assert.equal(getUpdatedWith(), null);
  });

  it('rejects a string "enabled"', async () => {
    const { app, getUpdatedWith } = setup();
    const res = await invoke(app, { enabled: 'no' });
    assert.equal(res.statusCode, 400);
    assert.equal(getUpdatedWith(), null, 'a truthy string must never reach updateSentinelConfig');
  });

  it('rejects a negative maxAlerts', async () => {
    const { app, getUpdatedWith } = setup();
    const res = await invoke(app, { maxAlerts: -5 });
    assert.equal(res.statusCode, 400);
    assert.equal(getUpdatedWith(), null);
  });

  it('rejects a non-integer maxAlerts', async () => {
    const { app, getUpdatedWith } = setup();
    const res = await invoke(app, { maxAlerts: 12.5 });
    assert.equal(res.statusCode, 400);
    assert.equal(getUpdatedWith(), null);
  });

  it('rejects a non-array feeds instead of silently skipping the SSRF check', async () => {
    const { app, getUpdatedWith } = setup();
    const res = await invoke(app, { feeds: { url: 'http://169.254.169.254/latest/meta-data/' } });
    assert.equal(res.statusCode, 400);
    assert.equal(getUpdatedWith(), null, 'a non-array feeds object must never reach updateSentinelConfig');
  });

  it('rejects a non-boolean aiClassification.enabled', async () => {
    const { app, getUpdatedWith } = setup();
    const res = await invoke(app, { aiClassification: { enabled: 'yes' } });
    assert.equal(res.statusCode, 400);
    assert.equal(getUpdatedWith(), null);
  });

  it('rejects an unbounded aiClassification.maxPerHour', async () => {
    const { app, getUpdatedWith } = setup();
    const res = await invoke(app, { aiClassification: { maxPerHour: 1000000000 } });
    assert.equal(res.statusCode, 400);
    assert.equal(getUpdatedWith(), null);
  });

  it('rejects a keywords category that is not an array of strings', async () => {
    const { app, getUpdatedWith } = setup();
    const res = await invoke(app, { keywords: { critical: 'rate cut' } });
    assert.equal(res.statusCode, 400);
    assert.equal(getUpdatedWith(), null);
  });

  it('accepts a fully valid body and still persists it', async () => {
    const { app, getUpdatedWith } = setup();
    const res = await invoke(app, {
      enabled: true,
      pollIntervalMs: 300000,
      maxAlerts: 250,
      aiClassification: { enabled: true, maxPerHour: 20 },
      keywords: { critical: ['rate cut'], warning: ['inflation'] },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.deepEqual(getUpdatedWith(), {
      enabled: true,
      pollIntervalMs: 300000,
      maxAlerts: 250,
      aiClassification: { enabled: true, maxPerHour: 20 },
      keywords: { critical: ['rate cut'], warning: ['inflation'] },
    });
  });
});
