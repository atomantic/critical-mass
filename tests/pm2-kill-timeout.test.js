const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { apps } = require('../ecosystem.config.cjs');
const { SHUTDOWN_TIMEOUT_MS } = require('../src/gateway-shutdown');
const { FILL_DRAIN_MS } = require('../src/engine-locks');
const {
  DEFAULT_IPC_DRAIN_TIMEOUT_MS, DEFAULT_PROCESS_DRAIN_TIMEOUT_MS,
  DEFAULT_START_JOIN_TIMEOUT_MS, DEFAULT_SHUTDOWN_WATCHDOG_MS,
} = require('../src/engine-shutdown');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const watchdogMs = Number(/const SHUTDOWN_WATCHDOG_MS = (\d+);/.exec(read('engines/exchange-engine.js'))[1]);
const graceMs = (() => {
  const m = /stop_grace_period:\s*(\d+)(s|m)/.exec(read('docker-compose.yml'));
  return Number(m[1]) * (m[2] === 'm' ? 60000 : 1000);
})();
const deadlineFor = (app) => (app.name === 'critical-mass' ? SHUTDOWN_TIMEOUT_MS : watchdogMs);

describe('PM2 kill_timeout ordering', () => {
  it('engine watchdog outlasts the in-flight fill drain', () => {
    assert.ok(watchdogMs > FILL_DRAIN_MS);
  });

  it('engine shutdown budget (bounded steps + shared stop() drain) fits inside the watchdog', () => {
    // IPC drain + fund-start join + market-start join, then stop()'s single
    // flash-cancel/fill-drain budget, then the process-wide write drain.
    const worstCaseMs = DEFAULT_IPC_DRAIN_TIMEOUT_MS + 2 * DEFAULT_START_JOIN_TIMEOUT_MS
      + FILL_DRAIN_MS + DEFAULT_PROCESS_DRAIN_TIMEOUT_MS;
    assert.ok(worstCaseMs < watchdogMs, `${worstCaseMs}ms of bounded steps must fit in the ${watchdogMs}ms watchdog`);
    assert.equal(DEFAULT_SHUTDOWN_WATCHDOG_MS, watchdogMs, 'coordinator default and engine literal agree');
  });

  const longRunning = apps.filter((a) => a.name !== 'critical-mass-ui');

  it('covers the gateway and every engine', () => {
    assert.ok(longRunning.length >= 4);
  });

  it('docker stop_grace_period covers the ordered gateway-then-engine stop', () => {
    const gateway = apps.find((a) => a.name === 'critical-mass');
    const engineKill = Math.max(...longRunning.filter((a) => a !== gateway).map((a) => a.kill_timeout));
    assert.ok(graceMs > gateway.kill_timeout + engineKill);
  });

  it('entrypoint runs pm2-runtime as a child and stops the stack in order on SIGTERM', () => {
    const entrypoint = read('docker-entrypoint.sh');
    assert.doesNotMatch(entrypoint, /^exec pm2-runtime/m);
    assert.match(entrypoint, /trap stop_stack TERM INT/);
    assert.match(entrypoint, /node \/app\/scripts\/pm2-stack\.js stop/);
    assert.ok(entrypoint.indexOf('pm2-stack.js stop') < entrypoint.indexOf('kill -TERM "$PM2_PID"'));
    assert.match(read('Dockerfile'), /COPY scripts\/pm2-stack\.js/);
    assert.match(read('.dockerignore'), /^!scripts\/pm2-stack\.js$/m);
  });

  for (const app of longRunning) {
    it(`${app.name}: kill_timeout > in-process deadline and < docker stop_grace_period`, () => {
      assert.ok(Number.isFinite(app.kill_timeout), 'kill_timeout must be set');
      assert.ok(app.kill_timeout > deadlineFor(app));
      assert.ok(graceMs > app.kill_timeout);
    });
  }
});
