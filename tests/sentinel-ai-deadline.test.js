// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { createSentinelService } = require('../src/sentinel/sentinel-service');

const makeItems = (n) => Array.from({ length: n }, (_, i) => ({
  guid: `g-${i}`,
  title: `Warning headline ${i}`,
  description: 'selloff underway',
  source: 'test',
  link: `https://example.com/${i}`,
  pubDate: new Date().toISOString(),
}));

const makeService = (items, classifyByAI, aiClassifyDeadlineMs = 50) => {
  const emitted = [];
  const io = { to: () => ({ emit: (...args) => emitted.push(args) }) };
  const service = createSentinelService(io, {
    readJSON: () => null,
    writeJSON: () => {},
    DATA_DIR: os.tmpdir(),
    getSentinelConfig: () => ({
      enabled: true,
      pollIntervalMs: 60_000,
      feeds: [{ name: 'test', url: 'https://example.com/feed' }],
      keywords: { critical: [], warning: ['selloff'], info: [] },
      aiClassification: { enabled: true, maxPerHour: 1000 },
    }),
    fetchAllFeeds: async () => items,
    classifyByAI,
    aiClassifyDeadlineMs,
  });
  return { service, emitted };
};

describe('Sentinel per-poll AI classification deadline', () => {
  it('emits every alert with keyword severity when the classifier never resolves', async () => {
    let calls = 0;
    const { service, emitted } = makeService(makeItems(5), () => { calls++; return new Promise(() => {}); });

    const started = Date.now();
    await service.forcePoll();

    assert.ok(Date.now() - started < 2000, 'poll must not wait on the hung classifier');
    assert.equal(calls, 5, 'each matched item still consumes its classification attempt');
    const alerts = emitted.filter(([e]) => e === 'sentinel:alert').map(([, a]) => a);
    assert.equal(alerts.length, 5);
    for (const a of alerts) {
      assert.equal(a.severity, 'warning');
      assert.equal(a.category, 'unknown');
      assert.equal(a.summary, 'selloff underway');
    }
    assert.equal(service.getAlerts().length, 5);
  });

  it('still applies AI severity and summary from a fast classifier', async () => {
    const { service, emitted } = makeService(makeItems(2), async () => ({
      category: 'regulatory',
      severity: 'critical',
      summary: 'AI summary',
      suggestedAction: 'Reduce risk',
    }));

    await service.forcePoll();

    const alerts = emitted.filter(([e]) => e === 'sentinel:alert').map(([, a]) => a);
    assert.equal(alerts.length, 2);
    for (const a of alerts) {
      assert.equal(a.severity, 'critical');
      assert.equal(a.category, 'regulatory');
      assert.equal(a.summary, 'AI summary');
    }
  });

  it('keeps AI results that finished and falls back only for the slow ones', async () => {
    const { service, emitted } = makeService(makeItems(2), (item) => (
      item.guid === 'g-0'
        ? Promise.resolve({ category: 'other', severity: 'critical', summary: 'fast', suggestedAction: null })
        : new Promise(() => {})
    ));

    await service.forcePoll();

    const alerts = emitted.filter(([e]) => e === 'sentinel:alert').map(([, a]) => a);
    assert.deepEqual(alerts.map(a => [a.severity, a.summary]), [['critical', 'fast'], ['warning', 'selloff underway']]);
  });
});
