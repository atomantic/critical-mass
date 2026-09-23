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
 * Isolation (claude review finding on a follow-up commit): both the adapter
 * and `backtest-engine.js` resolve the SAME default path — `<repo
 * root>/data/coinbase-keys.json` — when no explicit `keysPath` is supplied,
 * and neither exposes a way to inject one for this call. An earlier version
 * of this test called that default path unmocked, relying on it happening to
 * be absent in this worktree; on a machine where this live-trading app has
 * real Coinbase keys configured (the normal deployment state — see this
 * repo's CLAUDE.md), that would have read real credentials into process
 * memory. Every test below instead intercepts `fs.existsSync`/`readFileSync`
 * scoped EXACTLY to that one resolved path — real content is never read
 * (existence is forced false, or fed fake content), regardless of what
 * actually exists on the machine running the suite. Every other path passes
 * straight through to the real fs so the rest of the test run is unaffected.
 */
const fs = require('fs');
const path = require('path');
const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const backtestEngine = require('../src/backtest-engine');

// Matches both src/adapters/coinbase/api.js's `resolvedKeysPath` default
// (path.join(__dirname, '..', '..', '..', 'data', 'coinbase-keys.json') from
// src/adapters/coinbase/) and this file's own path.join to the same target.
const DEFAULT_KEYS_PATH = path.join(__dirname, '..', 'data', 'coinbase-keys.json');

const realExistsSync = fs.existsSync;
const realReadFileSync = fs.readFileSync;

describe('backtest-engine loadCredentials (issue #688)', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('delegates to the Coinbase adapter\'s resolvedKeysPath, not an independent root keys.json read', () => {
    const fakeKeys = JSON.stringify({ name: 'fake-key-name', privateKey: 'fake-private-key-not-real-and-long-enough-to-pass-validation' });
    mock.method(fs, 'existsSync', (p, ...rest) => (p === DEFAULT_KEYS_PATH ? true : realExistsSync(p, ...rest)));
    mock.method(fs, 'readFileSync', (p, ...rest) => (p === DEFAULT_KEYS_PATH ? fakeKeys : realReadFileSync(p, ...rest)));

    const creds = backtestEngine.loadCredentials();

    // This is exactly what the adapter's own loadCredentials() would return
    // for this file content — proving delegation, not a coincidence, since
    // the OLD hardcoded `require('../keys.json')` path (a different file,
    // never faked here) would have thrown MODULE_NOT_FOUND instead.
    assert.deepEqual(creds, {
      apiKey: 'fake-key-name',
      apiSecret: 'fake-private-key-not-real-and-long-enough-to-pass-validation',
    });
  });

  it('surfaces the adapter\'s "not configured" error instead of a MODULE_NOT_FOUND require crash', () => {
    // Force the default path absent regardless of the machine's real state
    // — the assertion must never depend on, or read, real on-disk content.
    mock.method(fs, 'existsSync', (p, ...rest) => (p === DEFAULT_KEYS_PATH ? false : realExistsSync(p, ...rest)));

    assert.throws(
      () => backtestEngine.loadCredentials(),
      /API keys not configured/,
      'should surface the adapter\'s handled error, not a require() crash',
    );
  });
});
