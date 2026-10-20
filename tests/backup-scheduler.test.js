const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createBackupScheduler, MIN_DELAY_MS, MAINTENANCE_RETRY_MS } = require('../src/backup-scheduler');

const HOUR = 3600000;
const harness = ({ archiveNewest = null, fundNewest = null, runs = {}, config = {} } = {}) => {
  let clock = 1_000_000_000_000;
  const pending = [];
  const logs = [];
  const calls = [];
  const state = { archiveNewest, fundNewest, config: { enabled: true, intervalMs: 24 * HOUR, fundStateIntervalMs: HOUR, ...config } };
  const mk = (name, intervalKey, newestKey, startupOffsetMs) => ({
    label: name, failLabel: name, intervalKey, startupOffsetMs,
    newest: () => state[newestKey],
    run: async () => { calls.push(name); return (runs[name] ? runs[name]() : { success: true }); },
  });
  const scheduler = createBackupScheduler({
    getConfig: () => state.config,
    now: () => clock,
    setTimer: (fn, ms) => { const t = { fn, at: clock + ms, ms, live: true }; pending.push(t); return t; },
    clearTimer: (t) => { t.live = false; },
    log: (level, msg) => logs.push([level, msg]),
    kinds: { archive: mk('archive', 'intervalMs', 'archiveNewest'), fundState: mk('fundState', 'fundStateIntervalMs', 'fundNewest', 120000) },
  });
  const live = (i) => pending.filter((t) => t.live)[i];
  const flush = () => new Promise((r) => setImmediate(r));
  return { scheduler, state, logs, calls, pending, live, flush, now: () => clock, advance: (ms) => { clock += ms; } };
};

describe('backup scheduler', () => {
  it('derives the archive due time from disk, not boot time', () => {
    const h = harness();
    h.state.archiveNewest = h.now() - 23 * HOUR;
    h.scheduler.reschedule();
    assert.equal(h.live(0).ms, HOUR);
    h.state.archiveNewest = h.now() - 30 * HOUR;
    h.scheduler.reschedule();
    assert.equal(h.pending.filter((t) => t.live)[0].ms, MIN_DELAY_MS);
  });

  it('keeps the due time across repeated restarts and settings saves', () => {
    const h = harness();
    h.state.archiveNewest = h.now() - 10 * HOUR;
    h.scheduler.reschedule();
    const first = h.live(0).at;
    h.advance(0);
    h.scheduler.reschedule();
    h.scheduler.reschedule();
    assert.equal(h.pending.filter((t) => t.live)[0].at, first);
  });

  it('arms 60s with no artifact and offsets only the first fund-state arm', () => {
    const h = harness();
    h.scheduler.reschedule();
    const [archive, fund] = h.pending.filter((t) => t.live);
    assert.equal(archive.ms, MIN_DELAY_MS);
    assert.equal(fund.ms, MIN_DELAY_MS + 120000);
    h.scheduler.reschedule();
    assert.equal(h.pending.filter((t) => t.live)[1].ms, MIN_DELAY_MS);
  });

  it('retries a maintenance-locked run in 60s without logging an error', async () => {
    const h = harness({ runs: { fundState: () => ({ success: false, code: 'maintenance-in-progress', error: 'busy' }) } });
    h.scheduler.reschedule();
    h.pending.filter((t) => t.live)[1].fn();
    await h.flush();
    assert.deepEqual(h.calls, ['fundState']);
    assert.equal(h.logs.filter(([l]) => l === 'ERROR').length, 0);
    assert.equal(h.pending.filter((t) => t.live).at(-1).ms, MAINTENANCE_RETRY_MS);
  });

  it('re-arms a full interval after a success even with no new artifact', async () => {
    const h = harness();
    h.scheduler.reschedule();
    h.pending.filter((t) => t.live)[0].fn();
    await h.flush();
    assert.equal(h.pending.filter((t) => t.live).at(-1).ms, 24 * HOUR);
  });

  it('logs real failures and retries sooner than the interval', async () => {
    const h = harness({ runs: { archive: () => ({ success: false, error: 'disk full' }) } });
    h.scheduler.reschedule();
    h.pending.filter((t) => t.live)[0].fn();
    await h.flush();
    assert.equal(h.logs.filter(([l]) => l === 'ERROR').length, 1);
    assert.ok(h.pending.filter((t) => t.live).at(-1).ms < 24 * HOUR);
  });

  it('arms nothing when disabled and stop() clears timers', () => {
    const h = harness({ config: { enabled: false } });
    h.scheduler.reschedule();
    assert.equal(h.pending.length, 0);
    h.state.config.enabled = true;
    h.scheduler.reschedule();
    h.scheduler.stop();
    assert.equal(h.pending.filter((t) => t.live).length, 0);
  });
});
