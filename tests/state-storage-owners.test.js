// #1721 / #1974: the DCA, regime and placement-intent state owners share persistence ownership
// with direct storage imports. The former state-tracker facade no longer exists.
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fundPaths = require('../src/fund-paths');
const storage = require('../src/fund-state-storage');
const intents = require('../src/placement-intent-storage');
const quarantine = require('../src/state-file-quarantine');
const dcaState = require('../src/dca-state');
const regimeStateStore = require('../src/regime-state-store');
const dcaStatePath = require.resolve('../src/dca-state');
const regimeStateStorePath = require.resolve('../src/regime-state-store');
const EXCHANGE = 'coinbase';
const PAIR = 'BTC-USDC';
let tmpRoot;
let activeRoot;

const reloadDcaState = () => {
  delete require.cache[dcaStatePath];
  return require('../src/dca-state');
};
const reloadRegimeStateStore = () => {
  delete require.cache[regimeStateStorePath];
  return require('../src/regime-state-store');
};

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'state-storage-owners-'));
  activeRoot = tmpRoot;
  mock.method(fundPaths, 'getExchangeDataDir', () => path.join(activeRoot, EXCHANGE));
});
afterEach(() => {
  mock.restoreAll();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete require.cache[dcaStatePath];
  delete require.cache[regimeStateStorePath];
});

describe('state storage owners', () => {
  it('splits every former facade export across the DCA, regime and storage owners without overlap', () => {
    const dcaExpected = [
      'loadState', 'saveState', 'createInitialState', 'migrateState',
      'checkAllocationRemaining', 'checkIfRanThisInterval', 'recordBuyFill', 'findAwaitingSellOrder', 'attachSellOrder',
      'markSellPlacementFailed', 'getFailedSellOrders', 'reopenFailedSell', 'updateAfterBuy', 'updateAfterSellFill',
      'updateAfterConsolidation', 'applyConsolidationRecovery', 'getPendingOrders', 'getStateFile',
      'initFibonacciState', 'updateAfterFibBuy', 'recordPendingDcaBuy', 'notePendingDcaBuyCheck',
      'retirePendingDcaBuy', 'isDcaBuyBooked', 'bookDcaBuy', 'updateAfterFibSellOrder',
      'settleFibSellAndCarryUncoveredBuys', 'updateAfterFibSellFill', 'creditFibPartialSell', 'settleFibCancelledSell',
      'getFibCycleSold', 'settleCancelledSell', 'getFibonacciCycleInfo',
    ];
    const regimeExpected = [
      'LIFECYCLE', 'closeDrainedEmptyPosition',
      'getRegimeStateFile', 'createInitialRegimePositionState', 'createInitialRegimeState', 'loadRegimeState',
      'loadFundRegimeState', 'loadRegimeStateSafe', 'saveRegimeState', 'saveFundRegimeState',
    ];
    assert.deepEqual(Object.keys(dcaState).sort(), dcaExpected.sort());
    assert.deepEqual(Object.keys(regimeStateStore).sort(), regimeExpected.sort());
    for (const name of ['getStateFile', 'saveState']) {
      assert.equal(dcaState[name], storage[name], name);
    }
    for (const name of ['getRegimeStateFile', 'saveRegimeState']) {
      assert.equal(regimeStateStore[name], storage[name], name);
    }
    assert.equal(typeof quarantine.quarantineFile, 'function');
    assert.equal(typeof quarantine.quarantineIfUnreadable, 'function');
    assert.equal(require('../src/durable-write').atomicWriteSync.name, 'atomicWriteSync');
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'src', 'state-tracker.js')), false, 'the facade module is gone');
  });

  it('keeps domain initialization, migrations and allocation adjustment without read-path writes', () => {
    const config = { totalAllocation: 100 };
    assert.deepEqual(dcaState.loadState(config, EXCHANGE, PAIR), dcaState.createInitialState(config));
    assert.equal(fs.existsSync(dcaState.getStateFile(EXCHANGE, PAIR)), false);
    storage.saveState({ initialAllocation: 100, usdcFundSize: 25, totalDaysRun: 3 }, EXCHANGE, PAIR);
    const file = storage.getStateFile(EXCHANGE, PAIR);
    const before = fs.readFileSync(file, 'utf8');
    const state = reloadDcaState().loadState({ totalAllocation: 150 }, EXCHANGE, PAIR);
    assert.equal(state.totalIntervalsRun, 3);
    assert.equal(state.totalDaysRun, undefined);
    assert.equal(state.usdcFundSize, 75);
    assert.equal(state.initialAllocation, 150);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });

  it('shares observed save versions across regime store reloads and direct storage saves, per file', () => {
    const file = storage.getRegimeStateFile(EXCHANGE, PAIR);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ position: { _saveVersion: 7, realizedPnL: 1 }, regime: {} }));
    const state = regimeStateStore.loadFundRegimeState(EXCHANGE, PAIR);
    state.position.realizedPnL = 9;
    reloadRegimeStateStore().saveFundRegimeState(EXCHANGE, PAIR, state);
    assert.equal(state.position.realizedPnL, 9, 'a duplicate empty version store would wrongly restore disk P&L');
    assert.equal(state.position._saveVersion, 8);
    state.position.realizedPnL = 10;
    storage.saveRegimeState(state.position, state.regime, EXCHANGE, null, null, PAIR);
    assert.equal(state.position.realizedPnL, 10);
    assert.equal(state.position._saveVersion, 9);
    const other = regimeStateStore.loadFundRegimeState(EXCHANGE, 'ETH-USDC');
    regimeStateStore.saveFundRegimeState(EXCHANGE, 'ETH-USDC', other);
    assert.equal(other.position._saveVersion, 1, 'versions belong to each resolved file');
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    disk.position._saveVersion = 20;
    disk.position.realizedPnL = 21;
    fs.writeFileSync(file, JSON.stringify(disk));
    regimeStateStore.saveFundRegimeState(EXCHANGE, PAIR, state);
    assert.equal(state.position.realizedPnL, 21, 'external protected-field edits still win');
    assert.equal(state.position._saveVersion, 21);
  });

  it('shares retained intent IDs and process identity through the single placement-intent store', () => {
    const intent = intents.recordPlacementIntent({ exchange: EXCHANGE, pair: PAIR });
    assert.equal(intents.isBlockingPlacementIntent(intent), false);
    intents.retainPlacementIntentInProcess(intent.id);
    assert.equal(intents.isBlockingPlacementIntent(intent), true);
    assert.equal(intents.describePlacementIntents(EXCHANGE, PAIR)[0].needsAttention, true);
    assert.equal(intents.resolvePlacementIntent(EXCHANGE, PAIR, intent.id).id, intent.id);
    assert.equal(intents.isBlockingPlacementIntent(intent), false, 'resolution clears the same retained store');
    assert.equal(intents.resolvePlacementIntent(EXCHANGE, PAIR, intent.id), null, 'resolution stays exactly once');
  });

  it('keeps deferred removals queued across failures and scopes retries to their fund', () => {
    const intent = intents.recordPlacementIntent({ exchange: EXCHANGE, pair: PAIR });
    const file = intents.getPlacementIntentsFile(EXCHANGE, PAIR);
    const rename = fs.renameSync;
    const failingWrite = mock.method(fs, 'renameSync', (source, target) => {
      if (target === file) throw Object.assign(new Error('disposable disk full'), { code: 'ENOSPC' });
      return rename(source, target);
    });
    intents.retainPlacementIntentInProcess(intent.id);
    assert.throws(() => intents.resolvePlacementIntent(EXCHANGE, PAIR, intent.id), /disposable disk full/);
    intents.deferPlacementIntentRemoval(EXCHANGE, PAIR, intent.id);
    assert.equal(intents.getBlockingPlacementIntents(EXCHANGE, PAIR)[0].id, intent.id, 'failed retry remains queued and blocking');
    failingWrite.mock.restore();
    assert.deepEqual(intents.getBlockingPlacementIntents(EXCHANGE, 'ETH-USDC'), []);
    assert.equal(intents.loadPlacementIntents(EXCHANGE, PAIR).length, 1, 'another fund cannot flush this removal');
    assert.deepEqual(intents.getBlockingPlacementIntents(EXCHANGE, PAIR), []);
    assert.deepEqual(intents.loadPlacementIntents(EXCHANGE, PAIR), []);
    assert.equal(intents.isBlockingPlacementIntent(intent), false, 'successful retry clears shared retention');
  });

  it('resolves every storage path at call time and keeps path inspection read-only', () => {
    const before = [dcaState.getStateFile(EXCHANGE, PAIR), regimeStateStore.getRegimeStateFile(EXCHANGE, PAIR), intents.getPlacementIntentsFile(EXCHANGE, PAIR)];
    activeRoot = path.join(tmpRoot, 'changed');
    const after = [storage.getStateFile(EXCHANGE, PAIR), storage.getRegimeStateFile(EXCHANGE, PAIR), intents.getPlacementIntentsFile(EXCHANGE, PAIR)];
    for (let i = 0; i < after.length; i++) {
      assert.notEqual(after[i], before[i]);
      assert.ok(after[i].startsWith(activeRoot + path.sep));
      assert.equal(fs.existsSync(path.dirname(after[i])), false);
    }
    const other = reloadDcaState();
    other.saveState(other.createInitialState({ totalAllocation: 10 }), EXCHANGE, PAIR);
    assert.equal(fs.existsSync(after[0]), true);
    assert.equal(fs.existsSync(before[0]), false);
  });
});
