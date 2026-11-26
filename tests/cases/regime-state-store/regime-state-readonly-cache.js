// @ts-check
/**
 * Read-only parsed regime-state cache used by the stopped-fund status builder
 * (issue #1976). Covers: no re-read/re-parse while the file is unchanged,
 * operator edits showing up, payload equality with the uncached path, cache
 * entries never being mutated, no participation in optimistic locking, and
 * bounded/evicted entries.
 */
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const fundPaths = require('../../../src/fund-paths');
const store = require('../../../src/regime-state-store');
const storage = require('../../../src/fund-state-storage');
const { buildStoppedRegimeStatus } = require('../../../src/regime-status');

const EX = 'coinbase';
const PAIR = 'BTC-USD';

const makeLedger = () => ({
  getDerivedRealizedPnL: () => ({ realizedPnL: 4.2, realizedAssetPnL: 0.0001, heldOpenBuyCostBasis: 12.5 }),
  getAllFills: () => [{ price: 100000, timestamp: 1000 }],
});
const config = { productId: PAIR, maxUsdcDeployed: 10000 };

const build = (extra = {}) => buildStoppedRegimeStatus(EX, PAIR, {
  config, fillLedger: makeLedger(), market: { lastPrice: 101000 }, ...extra,
});

describe('read-only regime-state cache (issue #1976)', () => {
  const originalGetExchangeDataDir = fundPaths.getExchangeDataDir;
  /** @type {string} */
  let tmpDir;
  /** @type {string} */
  let stateFile;

  const writeState = (overrides = {}, regime = { mode: 'HARVEST', since: 5 }) => {
    const position = {
      ...store.createInitialRegimePositionState(),
      celestialBodies: [{ id: 'b1', tier: 'MOON', tpOrderId: 'tp-1', assetQty: 0.001, costBasis: 100, avgPrice: 100000, tpPrice: 105000 }],
      ...overrides,
    };
    fs.writeFileSync(stateFile, JSON.stringify({ position, regime }, null, 2));
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-ro-cache-'));
    fundPaths.getExchangeDataDir = (exchange) => {
      const dir = path.join(tmpDir, exchange);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    stateFile = store.getRegimeStateFile(EX, PAIR);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    store.evictFundRegimeStateReadOnly(EX, PAIR);
  });

  afterEach(() => {
    mock.restoreAll();
    store.evictFundRegimeStateReadOnly(EX, PAIR);
    fundPaths.getExchangeDataDir = originalGetExchangeDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does no readFileSync/JSON.parse of the state file while it is unchanged', () => {
    writeState();
    build(); // warm
    const readSpy = mock.method(fs, 'readFileSync');
    const parseSpy = mock.method(JSON, 'parse');
    for (let i = 0; i < 5; i++) build();
    const stateReads = readSpy.mock.calls.filter((c) => String(c.arguments[0]) === stateFile);
    assert.equal(stateReads.length, 0);
    assert.equal(parseSpy.mock.calls.length, 0);
  });

  it('shows an operator edit that changes the size on the next build', () => {
    writeState({ lifecycle: 'active' });
    assert.equal(build().position.lifecycle, 'active');
    writeState({ lifecycle: 'draining', lifecycleReason: 'operator edit' });
    const status = build();
    assert.equal(status.position.lifecycle, 'draining');
    assert.equal(status.lifecycle.lifecycleReason, 'operator edit');
  });

  it('shows a same-size rewrite even when mtime is restored (ctime/inode signature)', () => {
    writeState({ lifecycleReason: 'aaaa' });
    assert.equal(build().position.lifecycleReason, 'aaaa');
    const before = fs.statSync(stateFile);
    writeState({ lifecycleReason: 'bbbb' });
    fs.utimesSync(stateFile, before.atime, before.mtime);
    assert.equal(fs.statSync(stateFile).size, before.size);
    assert.equal(build().position.lifecycleReason, 'bbbb');
  });

  it('re-reads after the max age even when the stat signature is unchanged', () => {
    writeState();
    const domain = {
      createInitialRegimePositionState: store.createInitialRegimePositionState,
      createInitialRegimeState: store.createInitialRegimeState,
      migrateLegacyPositionFields: () => {},
      migrateRegimePosition: () => {},
    };
    const t0 = 1_000_000;
    storage.loadRegimeStateReadOnly(EX, PAIR, domain, { now: t0 });
    const readSpy = mock.method(fs, 'readFileSync');
    storage.loadRegimeStateReadOnly(EX, PAIR, domain, { now: t0 + 9_000 });
    assert.equal(readSpy.mock.calls.length, 0);
    storage.loadRegimeStateReadOnly(EX, PAIR, domain, { now: t0 + 11_000 });
    assert.equal(readSpy.mock.calls.length, 1);
  });

  it('emits a payload deep-equal to the uncached load path', () => {
    writeState({ lifecycle: 'draining', realizedPnL: -999 }, { mode: 'TREND', since: 9 });
    const cachedStatus = build();
    const uncachedStatus = build({ regimeState: store.loadFundRegimeState(EX, PAIR) });
    assert.deepEqual(cachedStatus, uncachedStatus);
    assert.deepEqual(build(), uncachedStatus); // and again from the warm cache
  });

  it('two builds from one cache entry are equal, and mutating a result never leaks into the next', () => {
    writeState();
    const first = build();
    const snapshot = structuredClone(first);
    first.position.realizedPnL = 123456;
    first.position.celestialBodies[0].costBasis = 99999;
    first.position.celestialBodies.push({ id: 'evil', tier: 'MOON' });
    first.regime.mode = 'MUTATED';
    const second = build();
    assert.deepEqual(second, snapshot);
    const third = build();
    assert.deepEqual(third, second);
  });

  it('does not mutate a caller-supplied regimeState', () => {
    const regimeState = { position: { lifecycle: 'active', celestialBodies: [], realizedPnL: -999 }, regime: null, isDryRun: false };
    const before = structuredClone(regimeState);
    build({ regimeState });
    assert.deepEqual(regimeState, before);
  });

  it('never records a save version: saveRegimeState still sees the disk edit as external', () => {
    writeState({ _saveVersion: 5, celestialBodies: [{ id: 'disk-body', tier: 'MOON' }] });
    // Read-only read must not register version 5 for this file.
    build();
    const position = { ...store.createInitialRegimePositionState(), celestialBodies: [{ id: 'mem-body', tier: 'MOON' }] };
    storage.saveRegimeState(position, store.createInitialRegimeState(), EX, null, null, PAIR);
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    // myVersion stayed 0 < diskVersion 5 -> protected fields merged from disk, version 6.
    assert.equal(saved.position._saveVersion, 6);
    assert.deepEqual(saved.position.celestialBodies, [{ id: 'disk-body', tier: 'MOON' }]);
  });

  it('does not disturb a version recorded by the normal load path', () => {
    writeState({ _saveVersion: 5, celestialBodies: [{ id: 'disk-body', tier: 'MOON' }] });
    store.loadFundRegimeState(EX, PAIR); // engine-style load records version 5
    // Operator-style bump on disk would normally be seen as external; a read-only read must not overwrite 5.
    build();
    const position = { ...store.createInitialRegimePositionState(), celestialBodies: [{ id: 'mem-body', tier: 'MOON' }] };
    storage.saveRegimeState(position, store.createInitialRegimeState(), EX, null, null, PAIR);
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(saved.position._saveVersion, 6);
    assert.deepEqual(saved.position.celestialBodies, [{ id: 'mem-body', tier: 'MOON' }]); // 5 == 5 -> no merge
  });

  it('keeps one entry per fund file, never caches a missing file, and drops entries on evict/removal', () => {
    const base = storage.readOnlyRegimeCacheSize();
    build(); // no file yet
    assert.equal(storage.readOnlyRegimeCacheSize(), base);
    writeState();
    build();
    build();
    assert.equal(storage.readOnlyRegimeCacheSize(), base + 1);
    assert.equal(store.evictFundRegimeStateReadOnly(EX, PAIR), true);
    assert.equal(storage.readOnlyRegimeCacheSize(), base);
    build();
    assert.equal(storage.readOnlyRegimeCacheSize(), base + 1);
    fs.rmSync(stateFile); // fund removed
    build();
    assert.equal(storage.readOnlyRegimeCacheSize(), base);
  });

  it('sweeps entries of funds nobody polls any more when another fund loads', () => {
    const domain = {
      createInitialRegimePositionState: store.createInitialRegimePositionState,
      createInitialRegimeState: store.createInitialRegimeState,
      migrateLegacyPositionFields: () => {},
      migrateRegimePosition: () => {},
    };
    writeState();
    const otherFile = store.getRegimeStateFile(EX, 'ETH-USD');
    fs.mkdirSync(path.dirname(otherFile), { recursive: true });
    fs.writeFileSync(otherFile, JSON.stringify({ position: {}, regime: {} }));
    const t0 = 5_000_000;
    storage.loadRegimeStateReadOnly(EX, 'ETH-USD', domain, { now: t0 });
    const base = storage.readOnlyRegimeCacheSize();
    storage.loadRegimeStateReadOnly(EX, PAIR, domain, { now: t0 + 30_000 });
    assert.equal(storage.readOnlyRegimeCacheSize(), base + 1); // ETH still fresh enough
    storage.loadRegimeStateReadOnly(EX, PAIR, domain, { now: t0 + 61_000 }); // PAIR reload: max-age expired -> insert
    assert.equal(storage.readOnlyRegimeCacheSize(), 1); // abandoned ETH entry swept
    store.evictFundRegimeStateReadOnly(EX, 'ETH-USD');
  });

  it('does not cache a corrupt file and recovers once it is repaired', () => {
    fs.writeFileSync(stateFile, '{ not json');
    assert.throws(() => build(), /corrupted/);
    assert.equal(storage.readOnlyRegimeCacheSize(), 0);
    writeState();
    assert.equal(build().isRunning, false);
  });
});
