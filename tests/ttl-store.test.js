// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createTtlStore } = require('../src/ttl-store');

describe('TTL store', () => {
  it('expires entries and remains compatible with Map snapshots', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const store = createTtlStore(100);
    const value = { tpOrderId: 'tp-1' };
    store.add('tp-1', value);

    assert.equal(store.has('tp-1'), true);
    assert.equal(store.get('tp-1'), value);
    assert.deepEqual([...new Map(store)], [['tp-1', value]]);
    assert.equal(store.size, 1);

    t.mock.timers.tick(99);
    assert.equal(store.has('tp-1'), true);
    t.mock.timers.tick(1);
    assert.equal(store.has('tp-1'), false);
    assert.equal(store.size, 0);
    assert.equal(store.pendingTimerCount, 0);
  });

  it('re-adding a key restarts its expiry window', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const store = createTtlStore(100);
    store.add('fill', 'first');
    t.mock.timers.tick(99);
    store.add('fill', 'second');

    t.mock.timers.tick(1);
    assert.equal(store.get('fill'), 'second');
    t.mock.timers.tick(99);
    assert.equal(store.has('fill'), false);
  });

  it('delete cancels the key timer', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const store = createTtlStore(100);
    store.add('fill', 'first');
    t.mock.timers.tick(50);
    assert.equal(store.delete('fill'), true);
    store.add('fill', 'second');

    t.mock.timers.tick(50);
    assert.equal(store.get('fill'), 'second', 'the deleted entry timer cannot remove a later re-add');
    t.mock.timers.tick(50);
    assert.equal(store.has('fill'), false);
  });

  it('clear cancels all timers and entries', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const store = createTtlStore(100);
    store.add('one');
    store.add('two');
    store.clear();

    assert.equal(store.size, 0);
    assert.equal(store.pendingTimerCount, 0);
    t.mock.timers.tick(1000);
    assert.deepEqual([...store], []);
  });
});
