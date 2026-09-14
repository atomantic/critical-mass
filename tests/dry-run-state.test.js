// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const migration = require('../src/migration');

/**
 * Reload the module fresh per test so its module-level `pendingStates` /
 * `lastSaveTime` start clean and don't bleed across cases, and point the data
 * directory at a throwaway tmp root through the `migration.getExchangeDataDir`
 * seam every other per-fund module is tested through. `LEGACY_STATE_FILE` is
 * repointed into the same tmp root: the legacy path is a real file in the app
 * root on any machine that has run the engine, so reading it would make these
 * cases depend on developer state, and writing it would clobber it.
 */
const setup = (t, now = 10_000) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dry-run-state-'));
  const originalGetExchangeDataDir = migration.getExchangeDataDir;
  migration.getExchangeDataDir = (exchange) => {
    const dir = path.join(tmpRoot, exchange);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  const modPath = require.resolve('../src/dry-run-state');
  delete require.cache[modPath];
  const mod = require('../src/dry-run-state');
  mod.LEGACY_STATE_FILE = path.join(tmpRoot, mod.STATE_FILENAME);

  t.after(() => {
    migration.getExchangeDataDir = originalGetExchangeDataDir;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete require.cache[modPath];
  });

  return {
    ...mod,
    tmpRoot,
    /** @returns {string} the per-fund state file path under the tmp data root */
    fileFor: (exchange, pair) => path.join(tmpRoot, exchange, pair, mod.STATE_FILENAME),
  };
};

const mkState = (tag) => ({
  isDryRun: true,
  executor: {},
  position: {},
  savedAt: 0,
  tag,
});

/** @returns {any} the persisted fund state, or undefined when the file is absent */
const readFund = (file) => {
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf8')).state ?? undefined;
};

const captureLogs = (fn) => {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = line => lines.push(line);
  console.warn = line => lines.push(line);
  console.error = line => lines.push(line);
  try {
    fn();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
  return lines;
};

const contextFor = (lines, prefix) => {
  const line = lines.find(candidate => candidate.startsWith(prefix));
  assert.ok(line, `missing log line starting with: ${prefix}`);
  const contextStart = line.lastIndexOf(' {');
  assert.notEqual(contextStart, -1, `missing structured context: ${line}`);
  return JSON.parse(line.slice(contextStart + 1));
};

describe('dry-run-state per-fund location (#531)', () => {
  it('persists each fund inside its own data directory, not the app root', (t) => {
    const { saveState, getStateFile, fileFor, LEGACY_STATE_FILE } = setup(t);

    saveState('coinbase', mkState('A'), 'BTC-USD');

    const file = fileFor('coinbase', 'BTC-USD');
    assert.equal(getStateFile('coinbase', 'BTC-USD'), file, 'the resolved path is the one written');
    assert.ok(fs.existsSync(file), `expected per-fund state at ${file}`);
    assert.equal(readFund(file).tag, 'A');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1, 'version envelope preserved');
    assert.equal(fs.existsSync(LEGACY_STATE_FILE), false, 'nothing is written to the legacy single-file location any more');
  });

  it('keeps two funds on the same exchange isolated', (t) => {
    const { saveState, forceSave, fileFor } = setup(t);

    saveState('coinbase', mkState('btc'), 'BTC-USD');
    forceSave('coinbase', mkState('eth'), 'ETH-USD');

    assert.equal(readFund(fileFor('coinbase', 'BTC-USD')).tag, 'btc');
    assert.equal(readFund(fileFor('coinbase', 'ETH-USD')).tag, 'eth');
  });

  it('loses no fund when two exchanges interleave saves (no cross-process merge)', (t) => {
    const { saveState, loadState, fileFor } = setup(t);

    // Interleave the way two engine processes would: each fund updates
    // repeatedly while the other is mid-debounce.
    saveState('coinbase', mkState('cb-1'), 'BTC-USD');   // immediate
    t.mock.timers.setTime(11_000);
    saveState('gemini', mkState('gm-1'), 'BTCUSD');      // debounce-queued
    saveState('coinbase', mkState('cb-2'), 'BTC-USD');   // debounce-queued
    t.mock.timers.setTime(15_000);
    saveState('gemini', mkState('gm-2'), 'BTCUSD');      // immediate -> flushes both
    t.mock.timers.setTime(16_000);
    saveState('coinbase', mkState('cb-3'), 'BTC-USD');   // debounce-queued
    t.mock.timers.tick(10_000);                          // debounce fires

    assert.equal(readFund(fileFor('coinbase', 'BTC-USD')).tag, 'cb-3');
    assert.equal(readFund(fileFor('gemini', 'BTCUSD')).tag, 'gm-2');
    assert.equal(loadState('coinbase', 'BTC-USD').tag, 'cb-3');
    assert.equal(loadState('gemini', 'BTCUSD').tag, 'gm-2');
  });

  it('writes atomically and leaves no .tmp residue', (t) => {
    const { saveState, forceSave, clearState, tmpRoot } = setup(t);

    saveState('coinbase', mkState('A'), 'BTC-USD');
    forceSave('coinbase', mkState('B'), 'BTC-USD');
    clearState('coinbase', 'BTC-USD');

    const stray = fs.readdirSync(path.join(tmpRoot, 'coinbase', 'BTC-USD'))
      .filter(name => name.endsWith('.tmp'));
    assert.deepEqual(stray, [], 'atomic writes must not leave temp files behind');
  });
});

describe('dry-run-state legacy root import (#531)', () => {
  const writeLegacy = (file, exchanges) => fs.writeFileSync(file, JSON.stringify({ exchanges, version: 1 }));

  it('imports the composite exchange::pair slot and leaves the legacy file in place', (t) => {
    const { loadState, fileFor, LEGACY_STATE_FILE } = setup(t);
    writeLegacy(LEGACY_STATE_FILE, { 'coinbase::BTC-USD': { ...mkState('composite'), savedAt: 9_000 } });

    const loaded = loadState('coinbase', 'BTC-USD');

    assert.equal(loaded.tag, 'composite');
    assert.equal(readFund(fileFor('coinbase', 'BTC-USD')).tag, 'composite', 'slot copied into the data dir');
    assert.ok(fs.existsSync(LEGACY_STATE_FILE), 'legacy file is the operator fallback — never deleted');
  });

  it('imports the bare legacy exchange slot', (t) => {
    const { loadState, fileFor, LEGACY_STATE_FILE } = setup(t);
    writeLegacy(LEGACY_STATE_FILE, { gemini: { ...mkState('bare'), savedAt: 9_000 } });

    assert.equal(loadState('gemini', 'BTCUSD').tag, 'bare');
    assert.equal(readFund(fileFor('gemini', 'BTCUSD')).tag, 'bare');
  });

  it('imports each fund into its own file and never crosses slots', (t) => {
    const { loadState, fileFor, LEGACY_STATE_FILE } = setup(t);
    writeLegacy(LEGACY_STATE_FILE, {
      'coinbase::BTC-USD': { ...mkState('cb'), savedAt: 9_000 },
      gemini: { ...mkState('gm'), savedAt: 9_000 },
    });

    assert.equal(loadState('coinbase', 'BTC-USD').tag, 'cb');
    assert.equal(loadState('gemini', 'BTCUSD').tag, 'gm');
    assert.equal(readFund(fileFor('coinbase', 'BTC-USD')).tag, 'cb');
    assert.equal(readFund(fileFor('gemini', 'BTCUSD')).tag, 'gm');
  });

  it('is idempotent and never overwrites state the engine already wrote', (t) => {
    const { loadState, saveState, fileFor, LEGACY_STATE_FILE } = setup(t);
    writeLegacy(LEGACY_STATE_FILE, { 'coinbase::BTC-USD': { ...mkState('legacy'), savedAt: 9_000 } });

    assert.equal(loadState('coinbase', 'BTC-USD').tag, 'legacy');
    saveState('coinbase', mkState('fresh'), 'BTC-USD');

    assert.equal(loadState('coinbase', 'BTC-USD').tag, 'fresh', 'a second read must not re-import');
    assert.equal(readFund(fileFor('coinbase', 'BTC-USD')).tag, 'fresh');
  });

  it('does not resurrect a cleared fund from the legacy file', (t) => {
    const { loadState, clearState, LEGACY_STATE_FILE } = setup(t);
    writeLegacy(LEGACY_STATE_FILE, { 'coinbase::BTC-USD': { ...mkState('legacy'), savedAt: 9_000 } });

    assert.equal(loadState('coinbase', 'BTC-USD').tag, 'legacy');
    clearState('coinbase', 'BTC-USD');

    assert.equal(loadState('coinbase', 'BTC-USD'), null, 'a reset fund stays reset');
  });

  it('leaves an unreadable legacy file in place rather than quarantining it', (t) => {
    const { loadState, LEGACY_STATE_FILE } = setup(t);
    fs.writeFileSync(LEGACY_STATE_FILE, '{ not json');

    const lines = captureLogs(() => assert.equal(loadState('coinbase', 'BTC-USD'), null));

    assert.ok(fs.existsSync(LEGACY_STATE_FILE), 'the fallback copy must survive');
    assert.equal(fs.readFileSync(LEGACY_STATE_FILE, 'utf8'), '{ not json');
    assert.ok(lines.some(line => line.startsWith('⚠️ Legacy dry-run state is unreadable')));
  });
});

describe('dry-run-state structured logging', () => {
  it('preserves the version-mismatch warning with version and file context', (t) => {
    const { loadState, fileFor } = setup(t);
    const stateFile = fileFor('coinbase', 'BTC-USD');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ version: 0, state: mkState('old') }));

    const lines = captureLogs(() => assert.equal(loadState('coinbase', 'BTC-USD'), null));

    assert.deepEqual(
      contextFor(lines, '⚠️ [coinbase::BTC-USD] Dry-run state version mismatch (0 vs 1), starting fresh'),
      {
        exchange: 'coinbase',
        pair: 'BTC-USD',
        fundKey: 'coinbase::BTC-USD',
        stateFile,
        actualVersion: 0,
        expectedVersion: 1,
      }
    );
  });

  it('quarantines an unreadable per-fund file without touching its neighbours', (t) => {
    const { loadState, saveState, fileFor } = setup(t);
    saveState('gemini', mkState('healthy'), 'BTCUSD');
    const stateFile = fileFor('coinbase', 'BTC-USD');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, '{ truncated');

    const lines = captureLogs(() => assert.equal(loadState('coinbase', 'BTC-USD'), null));

    assert.equal(fs.existsSync(stateFile), false, 'the corrupt file is moved aside');
    const quarantined = fs.readdirSync(path.dirname(stateFile)).filter(f => f.includes('.corrupt-'));
    assert.equal(quarantined.length, 1, 'corrupt payload kept for manual recovery');
    assert.ok(lines.some(line => line.startsWith('⚠️ [coinbase::BTC-USD] Dry-run state unreadable')));
    assert.equal(readFund(fileFor('gemini', 'BTCUSD')).tag, 'healthy', 'other funds are untouched');
  });

  it('discards a snapshot with no usable savedAt rather than throwing on it', (t) => {
    const { loadState, fileFor } = setup(t);
    const stateFile = fileFor('coinbase', 'BTC-USD');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const { savedAt, ...noTimestamp } = mkState('undated');
    fs.writeFileSync(stateFile, JSON.stringify({ version: 1, state: noTimestamp }));

    const lines = captureLogs(() => assert.equal(loadState('coinbase', 'BTC-USD'), null));

    assert.ok(lines.some(line => line.startsWith('⚠️ [coinbase::BTC-USD] Dry-run state has no usable savedAt timestamp')));
  });

  it('preserves the stale-state warning with numeric age and fund context', (t) => {
    const now = 8 * 24 * 60 * 60 * 1000;
    const { loadState, fileFor } = setup(t, now);
    const stateFile = fileFor('coinbase', 'BTC-USD');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ version: 1, state: { ...mkState('stale'), savedAt: 0 } }));

    const lines = captureLogs(() => assert.equal(loadState('coinbase', 'BTC-USD'), null));

    assert.deepEqual(
      contextFor(lines, '⚠️ [coinbase::BTC-USD] Dry-run state is 8.0 days old, discarding'),
      {
        exchange: 'coinbase',
        pair: 'BTC-USD',
        fundKey: 'coinbase::BTC-USD',
        stateFile,
        ageDays: 8,
        savedAt: 0,
      }
    );
  });
});

describe('dry-run-state saveState — immediate branch preserves queued funds (#159)', () => {
  it('does not drop a debounce-queued fund when another fund saves immediately', (t) => {
    const { saveState, fileFor } = setup(t);

    // 1) Immediate save of fund A (lastSaveTime was 0, now 10s past it).
    saveState('coinbase', mkState('A'), 'BTC-USD');

    // 2) Within the debounce window, queue a newer snapshot of fund A. This
    //    schedules a debounce timer and leaves fund A sitting in pendingStates.
    t.mock.timers.setTime(11_000);
    saveState('coinbase', mkState('A2'), 'BTC-USD');

    // 3) Once the debounce window has elapsed (relative to lastSaveTime=10_000),
    //    fund B takes the immediate branch while fund A is still queued.
    t.mock.timers.setTime(15_000);
    saveState('kraken', mkState('B'), 'ETH-USD');

    assert.ok(readFund(fileFor('kraken', 'ETH-USD')), 'fund B should be persisted');
    // The regression: fund A's queued snapshot must NOT be discarded.
    assert.equal(readFund(fileFor('coinbase', 'BTC-USD'))?.tag, 'A2', 'latest queued snapshot wins');
  });

  it('cancels the pending debounce timer so it cannot later flush an empty map', (t) => {
    const { saveState, fileFor } = setup(t);

    saveState('coinbase', mkState('A'), 'BTC-USD');     // immediate, lastSaveTime=10_000
    t.mock.timers.setTime(11_000);
    saveState('coinbase', mkState('A2'), 'BTC-USD');    // debounced -> timer at 16_000
    t.mock.timers.setTime(15_000);
    saveState('kraken', mkState('B'), 'ETH-USD');       // immediate -> should cancel timer

    const afterImmediate = [
      readFund(fileFor('coinbase', 'BTC-USD')),
      readFund(fileFor('kraken', 'ETH-USD')),
    ];

    // Fire any timers past the original debounce deadline; nothing should change
    // because the immediate branch already flushed and cancelled the timer.
    t.mock.timers.tick(5_000);

    assert.deepEqual([
      readFund(fileFor('coinbase', 'BTC-USD')),
      readFund(fileFor('kraken', 'ETH-USD')),
    ], afterImmediate, 'no stray debounced flush');
  });
});

describe('dry-run-state forceSave — preserves queued funds on shutdown (#159)', () => {
  it('does not drop a debounce-queued fund when another fund force-saves', (t) => {
    const { saveState, forceSave, fileFor } = setup(t);

    saveState('coinbase', mkState('A'), 'BTC-USD');     // immediate, lastSaveTime=10_000
    t.mock.timers.setTime(11_000);
    saveState('coinbase', mkState('A2'), 'BTC-USD');    // debounced -> A2 queued
    forceSave('kraken', mkState('B'), 'ETH-USD');       // shutdown path for fund B

    assert.ok(readFund(fileFor('kraken', 'ETH-USD')), 'force-saved fund B should be persisted');
    assert.equal(readFund(fileFor('coinbase', 'BTC-USD'))?.tag, 'A2', 'fund A queued snapshot should survive force save');
  });
});

describe('dry-run-state clearState — fences debounced snapshots', () => {
  it('does not resurrect a cleared fund when its pending timer fires', (t) => {
    const { saveState, clearState, loadState, fileFor } = setup(t);

    saveState('coinbase', mkState('old'), 'BTC-USD');
    t.mock.timers.setTime(11_000);
    saveState('coinbase', mkState('queued-old'), 'BTC-USD');

    clearState('coinbase', 'BTC-USD');
    t.mock.timers.tick(10_000);

    assert.equal(loadState('coinbase', 'BTC-USD'), null);
    assert.equal(readFund(fileFor('coinbase', 'BTC-USD')), undefined);
  });

  it('clears only the target while preserving another fund queued in the same debounce window', (t) => {
    const { saveState, clearState, fileFor } = setup(t);

    saveState('coinbase', mkState('initial'), 'BTC-USD');
    t.mock.timers.setTime(11_000);
    saveState('coinbase', mkState('clear-me'), 'BTC-USD');
    saveState('gemini', mkState('keep-me'), 'ETH-USD');

    clearState('coinbase', 'BTC-USD');
    t.mock.timers.tick(5_000);

    assert.equal(readFund(fileFor('coinbase', 'BTC-USD')), undefined);
    assert.equal(readFund(fileFor('gemini', 'ETH-USD')).tag, 'keep-me');
  });
});
