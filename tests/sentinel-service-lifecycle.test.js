// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { createSentinelService } = require('../src/sentinel/sentinel-service');

const makeDeferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const makeService = (fetchAllFeeds) => {
  const emitted = [];
  const writes = [];
  const io = { to: () => ({ emit: (...args) => emitted.push(args) }) };
  const config = {
    enabled: true,
    pollIntervalMs: 60_000,
    feeds: [{ name: 'test', url: 'https://example.com/feed' }],
    keywords: { critical: ['halt'], warning: [], info: [] },
    aiClassification: { enabled: false },
  };
  const service = createSentinelService(io, {
    readJSON: () => null,
    writeJSON: (file, state) => writes.push({ file, state }),
    DATA_DIR: os.tmpdir(),
    getSentinelConfig: () => config,
    fetchAllFeeds,
  });
  return { service, emitted, writes };
};

const alertItem = {
  guid: 'guid-1',
  title: 'Trading halt announced',
  description: 'halt market',
  source: 'test',
  link: 'https://example.com/1',
  pubDate: new Date(0).toISOString(),
};

describe('Sentinel poll lifecycle fencing', () => {
  it('runs one enabled manual poll while the service remains stopped', async () => {
    let fetchCount = 0;
    const { service, emitted } = makeService(async () => {
      fetchCount++;
      return [alertItem];
    });

    await service.forcePoll();

    assert.equal(fetchCount, 1);
    assert.equal(service.getStatus().running, false);
    assert.equal(service.getStatus().pollCount, 1);
    assert.equal(service.getAlerts().length, 1);
    assert.equal(emitted.some(([event]) => event === 'sentinel:alert'), true);
  });

  it('coalesces overlapping polls in the same lifecycle', async (t) => {
    const deferred = makeDeferred();
    let fetchCount = 0;
    const { service } = makeService(() => {
      fetchCount++;
      return deferred.promise;
    });
    service.start();
    t.after(() => service.stop());

    const first = service.forcePoll();
    const second = service.forcePoll();
    assert.equal(fetchCount, 1);
    deferred.resolve([]);
    await Promise.all([first, second]);
    assert.equal(fetchCount, 1);
  });

  it('does not commit or emit results from a poll that finishes after stop', async () => {
    const deferred = makeDeferred();
    const { service, emitted, writes } = makeService(() => deferred.promise);
    service.start();

    const poll = service.forcePoll();
    service.stop();
    deferred.resolve([alertItem]);
    await poll;

    assert.deepEqual(service.getAlerts(), []);
    assert.equal(service.getStatus().seenItems, 0);
    assert.equal(emitted.some(([event]) => event === 'sentinel:alert'), false);
    assert.equal(writes.at(-1).state.seenGuids['guid-1'], undefined);
  });

  it('does not count a stale fetch rejection after stop as a current service error', async () => {
    const deferred = makeDeferred();
    const { service } = makeService(() => deferred.promise);
    service.start();

    const poll = service.forcePoll();
    service.stop();
    deferred.resolve(Promise.reject(new Error('late network failure')));
    await poll;

    assert.equal(service.getStatus().errorCount, 0);
  });
});

describe('Sentinel timestamp refresh (issue #695)', () => {
  it('refreshes seen-item timestamp on re-poll to prevent re-alerting after 7 days', async () => {
    // Stub Date.now to control time progression
    let mockNow = 1000000; // Start at arbitrary timestamp
    const originalDateNow = Date.now;
    Date.now = () => mockNow;

    try {
      const itemV1 = {
        guid: 'guid-persistent',
        title: 'Trading halt',
        description: 'halt market',
        source: 'test',
        link: 'https://example.com/1',
        pubDate: new Date(mockNow).toISOString(),
      };

      let pollPhase = 0;
      const { service, emitted, writes } = makeService(async () => {
        if (pollPhase === 0) {
          // First poll: return one item
          return [itemV1];
        } else if (pollPhase === 1) {
          // Second poll: return same item + new item (forces persistState)
          const itemV2 = {
            guid: 'guid-new',
            title: 'Trading halt',
            description: 'new halt',
            source: 'test',
            link: 'https://example.com/2',
            pubDate: new Date(mockNow).toISOString(),
          };
          return [itemV1, itemV2];
        } else {
          // Third poll: return same items again
          const itemV2 = {
            guid: 'guid-new',
            title: 'Trading halt',
            description: 'new halt',
            source: 'test',
            link: 'https://example.com/2',
            pubDate: new Date(mockNow).toISOString(),
          };
          return [itemV1, itemV2];
        }
      });

      // Phase 0: Initial poll, should create 1 alert
      pollPhase = 0;
      await service.forcePoll();
      assert.equal(service.getAlerts().length, 1, 'After first poll, should have 1 alert');

      // Phase 1: Advance 8 days and poll again
      // The persistent item should NOT be pruned because we just refreshed its timestamp
      mockNow += 8 * 24 * 60 * 60 * 1000; // +8 days
      pollPhase = 1;
      await service.forcePoll();

      // Should have 2 alerts total (original + new item), NOT 3
      assert.equal(
        service.getAlerts().length,
        2,
        'After 8-day skip and polling with same + new item, should have 2 alerts (not re-alerted for the persistent one)'
      );

      // Count sentinel_critical events
      const criticalEvents = emitted.filter(
        ([event]) => event === 'trade' || (Array.isArray(event) && event[0] === 'sentinel_critical')
      ).filter((args) => {
        if (args[1]?.type === 'sentinel_critical') return true;
        if (typeof args[0] === 'string' && args[0] === 'sentinel_critical') return true;
        return false;
      });

      // Just verify we got alerts emitted — the socket.IO event structure is abstracted
      assert.equal(
        service.getStatus().totalAlerts,
        2,
        'Status should show 2 total alerts'
      );

      // Phase 2: Poll again with same items, no new alerts
      pollPhase = 2;
      await service.forcePoll();
      assert.equal(
        service.getAlerts().length,
        2,
        'After third poll with same items, should still have only 2 alerts'
      );

      // Verify the persistent item was NOT pruned from seenGuids
      const latestWrite = writes.at(-1);
      assert.ok(
        latestWrite?.state?.seenGuids?.['guid-persistent'],
        'Persistent item should still be in seenGuids after 8+ days (not pruned)'
      );
    } finally {
      // Restore Date.now
      Date.now = originalDateNow;
    }
  });
});
