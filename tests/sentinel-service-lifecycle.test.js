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
