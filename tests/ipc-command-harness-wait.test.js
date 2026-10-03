const { test } = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { until } = require('./helpers/ipc-command-harness');

test('real-I/O wait allows delayed reconnect timers to fire', { timeout: 2000 }, async () => {
  let connected = false;
  const start = performance.now();
  const reconnect = setTimeout(() => { connected = true; }, 30);
  try {
    await until(() => connected, 'delayed reconnect', 1000);
    assert.equal(connected, true);
    assert.ok(performance.now() - start >= 20, 'wait must survive more than ten milliseconds');
  } finally {
    clearTimeout(reconnect);
  }
});

test('real-I/O wait rejects a condition that never becomes true at its deadline', { timeout: 2000 }, async () => {
  const start = performance.now();
  await assert.rejects(until(() => false, 'missing connection', 25), /timed out waiting for missing connection/);
  assert.ok(performance.now() - start >= 25, 'deadline is elapsed time rather than event-loop turns');
});

test('real-I/O wait resolves an already satisfied condition without polling', async () => {
  let calls = 0;
  await until(() => { calls++; return true; }, 'ready', 0);
  assert.equal(calls, 1);
});
