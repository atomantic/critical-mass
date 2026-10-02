const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { apps } = require('../ecosystem.config.cjs');
const { SHUTDOWN_TIMEOUT_MS } = require('../src/gateway-shutdown');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const watchdogMs = Number(/const SHUTDOWN_WATCHDOG_MS = (\d+);/.exec(read('engines/coinbase-engine.js'))[1]);
const graceMs = (() => {
  const m = /stop_grace_period:\s*(\d+)(s|m)/.exec(read('docker-compose.yml'));
  return Number(m[1]) * (m[2] === 'm' ? 60000 : 1000);
})();
const deadlineFor = (app) => (app.name === 'critical-mass' ? SHUTDOWN_TIMEOUT_MS : watchdogMs);

describe('PM2 kill_timeout ordering', () => {
  const longRunning = apps.filter((a) => a.name !== 'critical-mass-ui');

  it('covers the gateway and every engine', () => {
    assert.ok(longRunning.length >= 4);
  });

  for (const app of longRunning) {
    it(`${app.name}: kill_timeout > in-process deadline and < docker stop_grace_period`, () => {
      assert.ok(Number.isFinite(app.kill_timeout), 'kill_timeout must be set');
      assert.ok(app.kill_timeout > deadlineFor(app));
      assert.ok(graceMs > app.kill_timeout);
    });
  }
});
