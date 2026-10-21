// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parsePaging, MAX_PAGE_LIMIT } = require('../src/routes/route-utils');
const registerSentinelRoutes = require('../src/routes/sentinel-routes');

describe('parsePaging', () => {
  it('returns null when no paging params are present', () => {
    assert.equal(parsePaging({}), null);
  });
  it('bounds limit and offset', () => {
    assert.deepEqual(parsePaging({ limit: '99999' }), { limit: MAX_PAGE_LIMIT, offset: 0 });
    assert.deepEqual(parsePaging({ limit: '10', offset: '5' }), { limit: 10, offset: 5 });
    assert.deepEqual(parsePaging({ limit: 'x', offset: '-3' }), { limit: MAX_PAGE_LIMIT, offset: 0 });
  });
});

describe('GET /api/sentinel/alerts paging', () => {
  const setup = () => {
    /** @type {Record<string, Function>} */
    const handlers = {};
    const all = [1, 2, 3, 4, 5].map((id) => ({ id }));
    registerSentinelRoutes(
      { get: (p, fn) => { handlers[p] = fn; }, post() {}, put() {}, patch() {}, delete() {} },
      { sentinelService: { getAlerts: () => all }, getSentinelConfig: () => ({}), updateSentinelConfig: () => ({}) },
    );
    return handlers['/api/sentinel/alerts'];
  };
  const run = (handler, query) => { let body; handler({ query }, { json: (b) => { body = b; } }); return body; };

  it('keeps the legacy shape without paging params', () => {
    assert.deepEqual(run(setup(), {}), { success: true, alerts: [1, 2, 3, 4, 5].map((id) => ({ id })) });
  });
  it('returns a page with total', () => {
    const body = run(setup(), { limit: '2', offset: '1' });
    assert.deepEqual(body.alerts, [{ id: 2 }, { id: 3 }]);
    assert.equal(body.total, 5);
  });
});
