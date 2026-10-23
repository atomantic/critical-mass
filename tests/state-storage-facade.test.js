// @ts-check
// #1721: public facade and direct storage imports share persistence ownership.
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const migration = require('../src/migration');
const storage = require('../src/fund-state-storage');
const intents = require('../src/placement-intent-storage');
const quarantine = require('../src/state-file-quarantine');
const tracker = require('../src/state-tracker');
const trackerPath = require.resolve('../src/state-tracker');
const EXCHANGE = 'coinbase';
const PAIR = 'BTC-USDC';
let tmpRoot;
let activeRoot;

const reloadFacade = () => {
  delete require.cache[trackerPath];
  return require('../src/state-tracker');
};

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'state-storage-facade-'));
  activeRoot = tmpRoot;
  mock.method(migration, 'getExchangeDataDir', () => path.join(activeRoot, EXCHANGE));
});
afterEach(() => {
  mock.restoreAll();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete require.cache[trackerPath];
});

describe('state storage facade compatibility', () => {
  it('retains every existing public export and re-exports storage functions directly', () => {
    const expected = [
      'LIFECYCLE', 'closeDrainedEmptyPosition', 'loadState', 'saveState', 'createInitialState', 'migrateState',
      'checkAllocationRemaining', 'checkIfRanThisInterval', 'recordBuyFill', 'attachSellOrder',
      'markSellPlacementFailed', 'getFailedSellOrders', 'reopenFailedSell', 'updateAfterBuy', 'updateAfterSellFill',
      'updateAfterConsolidation', 'applyConsolidationRecovery', 'getPendingOrders', 'getStateFile',
      'initFibonacciState', 'updateAfterFibBuy', 'recordPendingDcaBuy', 'notePendingDcaBuyCheck',
      'retirePendingDcaBuy', 'isDcaBuyBooked', 'bookDcaBuy', 'updateAfterFibSellOrder',
      'settleFibSellAndCarryUncoveredBuys', 'updateAfterFibSellFill', 'creditFibPartialSell', 'getFibonacciCycleInfo',
      'getRegimeStateFile', 'createInitialRegimePositionState', 'createInitialRegimeState', 'loadRegimeState',
      'loadFundRegimeState', 'loadRegimeStateSafe', 'saveRegimeState', 'saveFundRegimeState',
      'getPlacementIntentsFile', 'PLACEMENT_INTENT_STATUS', 'PROCESS_INSTANCE_ID', 'loadPlacementIntents',
      'savePlacementIntents', 'recordPlacementIntent', 'updatePlacementIntent', 'markPlacementIntentUnresolved',
      'retainPlacementIntentInProcess', 'resolvePlacementIntent', 'deferPlacementIntentRemoval',
      'isBlockingPlacementIntent', 'getBlockingPlacementIntents', 'describePlacementIntents',
      'atomicWriteSync', 'quarantineFile', 'quarantineIfUnreadable',
    ];
    assert.deepEqual(Object.keys(tracker).sort(), expected.sort());
    for (const owner of [intents, quarantine]) {
      for (const [name, value] of Object.entries(owner)) assert.equal(tracker[name], value, name);
    }
    for (const name of ['getStateFile', 'saveState', 'getRegimeStateFile', 'saveRegimeState']) {
      assert.equal(tracker[name], storage[name], name);
    }
    assert.equal(tracker.atomicWriteSync, require('../src/durable-write').atomicWriteSync);
  });

  it('keeps domain initialization, migrations and allocation adjustment compatible without read-path writes', () => {
    const config = { totalAllocation: 100 };
    assert.deepEqual(tracker.loadState(config, EXCHANGE, PAIR), tracker.createInitialState(config));
    assert.equal(fs.existsSync(tracker.getStateFile(EXCHANGE, PAIR)), false);
    storage.saveState({ initialAllocation: 100, usdcFundSize: 25, totalDaysRun: 3 }, EXCHANGE, PAIR);
    const file = storage.getStateFile(EXCHANGE, PAIR);
    const before = fs.readFileSync(file, 'utf8');
    const state = reloadFacade().loadState({ totalAllocation: 150 }, EXCHANGE, PAIR);
    assert.equal(state.totalIntervalsRun, 3);
    assert.equal(state.totalDaysRun, undefined);
    assert.equal(state.usdcFundSize, 75);
    assert.equal(state.initialAllocation, 150);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });

  it('shares observed save versions across facade reloads and direct storage saves, per file', () => {
    const file = storage.getRegimeStateFile(EXCHANGE, PAIR);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ position: { _saveVersion: 7, realizedPnL: 1 }, regime: {} }));
    const state = tracker.loadFundRegimeState(EXCHANGE, PAIR);
    state.position.realizedPnL = 9;
    reloadFacade().saveFundRegimeState(EXCHANGE, PAIR, state);
    assert.equal(state.position.realizedPnL, 9, 'a duplicate empty version store would wrongly restore disk P&L');
    assert.equal(state.position._saveVersion, 8);
    state.position.realizedPnL = 10;
    storage.saveRegimeState(state.position, state.regime, EXCHANGE, null, null, PAIR);
    assert.equal(state.position.realizedPnL, 10);
    assert.equal(state.position._saveVersion, 9);
    const other = tracker.loadFundRegimeState(EXCHANGE, 'ETH-USDC');
    tracker.saveFundRegimeState(EXCHANGE, 'ETH-USDC', other);
    assert.equal(other.position._saveVersion, 1, 'versions belong to each resolved file');
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    disk.position._saveVersion = 20;
    disk.position.realizedPnL = 21;
    fs.writeFileSync(file, JSON.stringify(disk));
    tracker.saveFundRegimeState(EXCHANGE, PAIR, state);
    assert.equal(state.position.realizedPnL, 21, 'external protected-field edits still win');
    assert.equal(state.position._saveVersion, 21);
  });

  it('shares retained intent IDs and process identity through every entry point', () => {
    const intent = tracker.recordPlacementIntent({ exchange: EXCHANGE, pair: PAIR });
    const other = reloadFacade();
    assert.equal(other.PROCESS_INSTANCE_ID, intents.PROCESS_INSTANCE_ID);
    assert.equal(intents.isBlockingPlacementIntent(intent), false);
    intents.retainPlacementIntentInProcess(intent.id);
    assert.equal(other.isBlockingPlacementIntent(intent), true);
    assert.equal(tracker.describePlacementIntents(EXCHANGE, PAIR)[0].needsAttention, true);
    assert.equal(other.resolvePlacementIntent(EXCHANGE, PAIR, intent.id).id, intent.id);
    assert.equal(intents.isBlockingPlacementIntent(intent), false, 'resolution clears the same retained store');
    assert.equal(intents.resolvePlacementIntent(EXCHANGE, PAIR, intent.id), null, 'resolution stays exactly once');
  });

  it('shares deferred removals across facade reloads, retries failures and scopes retries to their fund', () => {
    const intent = tracker.recordPlacementIntent({ exchange: EXCHANGE, pair: PAIR });
    const file = intents.getPlacementIntentsFile(EXCHANGE, PAIR);
    const rename = fs.renameSync;
    const failingWrite = mock.method(fs, 'renameSync', (source, target) => {
      if (target === file) throw Object.assign(new Error('disposable disk full'), { code: 'ENOSPC' });
      return rename(source, target);
    });
    intents.retainPlacementIntentInProcess(intent.id);
    assert.throws(() => tracker.resolvePlacementIntent(EXCHANGE, PAIR, intent.id), /disposable disk full/);
    intents.deferPlacementIntentRemoval(EXCHANGE, PAIR, intent.id);
    const other = reloadFacade();
    assert.equal(other.getBlockingPlacementIntents(EXCHANGE, PAIR)[0].id, intent.id, 'failed retry remains queued and blocking');
    failingWrite.mock.restore();
    assert.deepEqual(other.getBlockingPlacementIntents(EXCHANGE, 'ETH-USDC'), []);
    assert.equal(intents.loadPlacementIntents(EXCHANGE, PAIR).length, 1, 'another fund cannot flush this removal');
    assert.deepEqual(other.getBlockingPlacementIntents(EXCHANGE, PAIR), []);
    assert.deepEqual(tracker.loadPlacementIntents(EXCHANGE, PAIR), []);
    assert.equal(tracker.isBlockingPlacementIntent(intent), false, 'successful retry clears shared retention');
  });

  it('resolves every storage path at call time and keeps path inspection read-only', () => {
    const before = [tracker.getStateFile(EXCHANGE, PAIR), tracker.getRegimeStateFile(EXCHANGE, PAIR), tracker.getPlacementIntentsFile(EXCHANGE, PAIR)];
    activeRoot = path.join(tmpRoot, 'changed');
    const after = [storage.getStateFile(EXCHANGE, PAIR), storage.getRegimeStateFile(EXCHANGE, PAIR), intents.getPlacementIntentsFile(EXCHANGE, PAIR)];
    for (let i = 0; i < after.length; i++) {
      assert.notEqual(after[i], before[i]);
      assert.ok(after[i].startsWith(activeRoot + path.sep));
      assert.equal(fs.existsSync(path.dirname(after[i])), false);
    }
    const other = reloadFacade();
    other.saveState(other.createInitialState({ totalAllocation: 10 }), EXCHANGE, PAIR);
    assert.equal(fs.existsSync(after[0]), true);
    assert.equal(fs.existsSync(before[0]), false);
  });
});
