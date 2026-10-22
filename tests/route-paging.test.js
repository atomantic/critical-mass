// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parsePaging, MAX_PAGE_LIMIT } = require('../src/routes/route-utils');
const registerSentinelRoutes = require('../src/routes/sentinel-routes');

describe('parsePaging', () => {
  it('defaults to a bounded first page when no paging params are present', () => {
    assert.deepEqual(parsePaging({}), { limit: MAX_PAGE_LIMIT, offset: 0 });
    assert.deepEqual(parsePaging({}, 100), { limit: 100, offset: 0 });
    assert.deepEqual(parsePaging({ limit: '9999' }, 100), { limit: MAX_PAGE_LIMIT, offset: 0 });
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

  it('returns the full envelope (items + alias) without paging params', () => {
    const all = [1, 2, 3, 4, 5].map((id) => ({ id }));
    assert.deepEqual(run(setup(), {}), { success: true, items: all, alerts: all, total: 5, limit: MAX_PAGE_LIMIT, offset: 0 });
  });
  it('returns a page with total', () => {
    const body = run(setup(), { limit: '2', offset: '1' });
    assert.deepEqual(body.items, [{ id: 2 }, { id: 3 }]);
    assert.deepEqual(body.alerts, body.items);
    assert.equal(body.total, 5);
  });
});
