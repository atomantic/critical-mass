// @ts-check
/**
 * Every IPC request channel an engine registers must be classified for the
 * maintenance gate: either on the read-only/shutdown allowlist
 * (MAINTENANCE_SAFE_CHANNELS) or explicitly listed here as mutating. A new
 * channel that is neither fails this test instead of being silently refused
 * (or silently admitted) during a backup/restore window.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { IPC_CHANNELS } = require('../src/ipc/ipc-protocol');
const { MAINTENANCE_SAFE_CHANNELS } = require('../src/engine-maintenance');

/** Channels that mutate engine state/orders and are refused while a window is open. */
const MUTATING_CHANNELS = new Set([
  'REGIME_START', 'REGIME_RECALCULATE', 'REGIME_CANCEL_LADDER', 'REGIME_CLOSE', 'REGIME_CONVERT_DCA',
  'REGIME_DISMISS_FILLS', 'REGIME_DRY_RUN_RESET', 'REGIME_FORCE_REGIME', 'REGIME_MANUAL_TRADE',
  'REGIME_MANUAL_TRADE_BUY', 'REGIME_MANUAL_TRADE_CHECK', 'REGIME_MANUAL_TRADE_PAIR',
  'REGIME_MANUAL_TRADE_RESUME', 'REGIME_MANUAL_TRADE_RETRY', 'REGIME_PAUSE', 'REGIME_REBUILD_LADDER',
  'REGIME_RECONCILE_PLACEMENT_INTENT', 'REGIME_REOPEN', 'REGIME_RESET_CYCLE', 'REGIME_RESUME',
  'REGIME_RESUME_DRAWDOWN', 'REGIME_ROLLUP_ALL', 'REGIME_ROLLUP_BODY', 'REGIME_SET_BODY_TP',
  'REGIME_SET_BODY_TP_PRICE', 'REGIME_UPDATE_CONFIG',
].map((key) => IPC_CHANNELS[/** @type {keyof typeof IPC_CHANNELS} */ (key)]));

const ROOT = path.join(__dirname, '..');
const REGISTRATION_FILES = [
  'src/ipc/regime-ipc-handlers.js',
  'src/engine-lifecycle-handlers.js',
  'src/engine-recalculate-handler.js',
  'src/engine-backup-window.js',
  'engines/exchange-engine.js',
];

describe('IPC channel classification for the maintenance gate', () => {
  it('classifies every IPC_CHANNELS entry exactly once', () => {
    for (const channel of MUTATING_CHANNELS) assert.ok(channel, 'MUTATING_CHANNELS names a real IPC_CHANNELS key');
    for (const channel of Object.values(IPC_CHANNELS)) {
      const safe = MAINTENANCE_SAFE_CHANNELS.has(channel);
      const mutating = MUTATING_CHANNELS.has(channel);
      assert.ok(safe !== mutating, `${channel} must be in exactly one of the allowlist or the mutating set`);
    }
  });

  it('keeps every allowlisted channel in the IPC_CHANNELS table', () => {
    const table = new Set(Object.values(IPC_CHANNELS));
    for (const channel of MAINTENANCE_SAFE_CHANNELS) assert.ok(table.has(channel), `${channel} missing from IPC_CHANNELS`);
  });

  it('treats the read-only fills cycles query like its fills sibling', () => {
    assert.ok(MAINTENANCE_SAFE_CHANNELS.has(IPC_CHANNELS.REGIME_FILLS));
    assert.ok(MAINTENANCE_SAFE_CHANNELS.has(IPC_CHANNELS.REGIME_FILLS_CYCLES));
  });

  it('registers engine channels only through IPC_CHANNELS entries that are classified', () => {
    const registered = new Set();
    for (const file of REGISTRATION_FILES) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const m of source.matchAll(/(?:onRequest|wireManualTradeImport)\(\s*([^,\s)]+)/g)) {
        const arg = m[1];
        const entry = /^IPC_CHANNELS\.([A-Z_]+)$/.exec(arg);
        if (!entry) {
          // Non-table args: a variable (`channel` inside the wiring helper), or a
          // string literal that must not be an engine:/regime: channel.
          assert.ok(!/^['"`](?:engine|regime):/.test(arg), `${file}: hard-coded IPC channel ${arg}`);
          continue;
        }
        assert.ok(entry[1] in IPC_CHANNELS, `${file}: unknown IPC_CHANNELS.${entry[1]}`);
        registered.add(IPC_CHANNELS[/** @type {keyof typeof IPC_CHANNELS} */ (entry[1])]);
      }
    }
    assert.ok(registered.size > 20, 'scan found the registered channels');
    for (const channel of registered) {
      assert.ok(
        MAINTENANCE_SAFE_CHANNELS.has(channel) || MUTATING_CHANNELS.has(channel),
        `${channel} is registered by an engine but neither allowlisted nor listed as mutating`,
      );
    }
  });
});
