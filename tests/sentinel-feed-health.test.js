// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { createSentinelService } = require('../src/sentinel/sentinel-service');

const makeService = (fetchAllFeeds, feeds = [{ name: 'a', url: 'https://u:secret@example.com/a' }]) => {
  const config = {
    enabled: true,
    pollIntervalMs: 60_000,
    feeds,
    keywords: { critical: ['halt'], warning: [], info: [] },
    aiClassification: { enabled: false },
  };
  const io = { to: () => ({ emit: () => {} }) };
  const service = createSentinelService(io, {
    readJSON: () => null,
    writeJSON: () => {},
    DATA_DIR: os.tmpdir(),
    getSentinelConfig: () => config,
    fetchAllFeeds,
  });
  return { service, config };
};

const item = { guid: 'g1', title: 'Trading halt', description: 'halt', source: 'a', link: 'https://example.com/1', pubDate: new Date(0).toISOString() };
const result = (items, enabled, succeeded, categories = []) => ({
  items, enabled, succeeded, failed: enabled - succeeded,
  failures: categories.map((category, i) => ({ feed: `f${i}`, category })),
});

describe('Sentinel feed acquisition health', () => {
  it('reports unavailable when every enabled feed fails, without success timestamps', async () => {
    const { service } = makeService(async () => result([], 2, 0, ['network', 'http']));
    await service.forcePoll();
    const s = service.getStatus();
    assert.equal(s.feedState, 'unavailable');
    assert.ok(s.lastPollAt);
    assert.equal(s.lastSuccessfulFetchAt, null);
    assert.equal(s.lastFullySuccessfulPollAt, null);
    assert.equal(s.failedPollCount, 1);
    assert.equal(s.feedFailureCount, 2);
    assert.equal(s.errorCount, 0);
    assert.equal(JSON.stringify(s).includes('secret'), false);
  });

  it('reports degraded on partial failure, keeps successful items, then recovers', async () => {
    let mode = 'partial';
    const { service } = makeService(async () => (mode === 'partial' ? result([item], 2, 1, ['http']) : result([], 2, 2)));
    await service.forcePoll();
    let s = service.getStatus();
    assert.equal(s.feedState, 'degraded');
    assert.equal(s.failedFeeds, 1);
    assert.equal(s.succeededFeeds, 1);
    assert.ok(s.lastSuccessfulFetchAt);
    assert.equal(s.lastFullySuccessfulPollAt, null);
    assert.equal(s.failedPollCount, 0);
    assert.equal(service.getAlerts().length, 1);

    mode = 'ok';
    await service.forcePoll();
    s = service.getStatus();
    assert.equal(s.feedState, 'healthy');
    assert.equal(s.failedFeeds, 0);
    assert.equal(s.feedFailureCount, 1);
    assert.ok(s.lastFullySuccessfulPollAt);
    assert.equal(service.getAlerts().length, 1);
  });

  it('treats valid empty feeds as healthy', async () => {
    const { service } = makeService(async () => result([], 1, 1));
    await service.forcePoll();
    assert.equal(service.getStatus().feedState, 'healthy');
  });

  it('exposes disabled and no-enabled-feeds as non-outage states', () => {
    const { service, config } = makeService(async () => result([], 0, 0), [{ name: 'a', url: 'https://example.com', enabled: false }]);
    assert.equal(service.getStatus().feedState, 'no-feeds');
    config.enabled = false;
    assert.equal(service.getStatus().feedState, 'disabled');
  });
});
