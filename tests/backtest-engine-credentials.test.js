// @ts-check
/**
 * issue #688 — backtest-engine.js's Coinbase `loadCredentials()` hardcoded
 * `require('../keys.json')`, a second, independent read of the same legacy
 * root file the adapter and migration code use. `src/migration.js`'s
 * `migrateKeys()` now renames that root file to `keys.json.migrated` after a
 * one-time migration (see tests/migration-keys.test.js), so on any migrated
 * install this hardcoded require would throw `MODULE_NOT_FOUND` on every
 * Coinbase backtest candle fetch. `loadCredentials()` now delegates to the
 * Coinbase adapter (`getAdapter('coinbase').loadCredentials()`), the single
 * source of truth for this credential everywhere else in the app.
 *
 * No test here writes any file — the worktree has no root `keys.json` and
 * none is created, so the "not configured" test exercises the real adapter
 * against its default (absent) path.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const backtestEngine = require('../src/backtest-engine');
const { getAdapter } = require('../src/adapters');

describe('backtest-engine loadCredentials (issue #688)', () => {
  it('delegates to the same Coinbase adapter instance getAdapter(\'coinbase\') returns, not an independent root keys.json read', () => {
    // Both throw the adapter's own "not configured" error (proving the same
    // code path), and neither is the MODULE_NOT_FOUND a hardcoded
    // require('../keys.json') would throw once migration.js renames the
    // legacy root file away.
    let fromAdapter;
    let fromBacktestEngine;
    try { getAdapter('coinbase').loadCredentials(); } catch (err) { fromAdapter = err.message; }
    try { backtestEngine.loadCredentials(); } catch (err) { fromBacktestEngine = err.message; }

    assert.ok(fromAdapter, 'expected getAdapter(\'coinbase\').loadCredentials() to throw in this worktree (no keys configured)');
    assert.equal(fromBacktestEngine, fromAdapter, 'backtest-engine must surface the identical adapter error, proving it delegates rather than reading its own file');
  });

  it('surfaces the adapter\'s "not configured" error instead of a MODULE_NOT_FOUND require crash', () => {
    // No mock installed: exercises the REAL Coinbase adapter, whose default
    // keys path (data/coinbase-keys.json) does not exist in this worktree.
    // Before the fix, this call went through `require('../keys.json')`
    // instead — throwing Cannot find module '../keys.json' rather than a
    // handled "not configured" error, on any install where the migration
    // had renamed the legacy root file away.
    assert.throws(
      () => backtestEngine.loadCredentials(),
      /API keys not configured/,
      'should surface the adapter\'s handled error, not a require() crash',
    );
  });
});
