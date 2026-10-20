// @ts-check
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// issue #1232 — characterization of loadRegimeState's legacy BTC-named field renames.
// Old key names are built by concatenation so refactoring scripts do not rename them.
const old = (prefix, suffix) => prefix + suffix;

const stateTrackerPath = require.resolve('../src/state-tracker');
const migration = require('../src/migration');
const originalGetExchangeDataDir = migration.getExchangeDataDir;

/** @type {string|null} */
let tmpDir = null;

const freshModule = () => {
  delete require.cache[stateTrackerPath];
  return require('../src/state-tracker');
};

const writeState = (st, data) => {
  const file = st.getRegimeStateFile('cb', 'BTC-USD');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
};

describe('loadRegimeState legacy field renames (issue #1232)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-tracker-renames-'));
    migration.getExchangeDataDir = (exchange) => {
      const dir = path.join(tmpDir, exchange);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
  });

  afterEach(() => {
    migration.getExchangeDataDir = originalGetExchangeDataDir;
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
    delete require.cache[stateTrackerPath];
  });

  it('renames every legacy key to its asset-agnostic name with identical values', () => {
    const st = freshModule();
    writeState(st, {
      position: {
        [old('total', 'BTC')]: 1.5,
        [old('realizedBtc', 'PnL')]: 12.25,
        [old('maxBtc', 'Exposure')]: 3.5,
        [old('btcOn', 'Order')]: 0.75,
        ladderStep: 4,
        celestialState: {
          [old('bodiesRealizedBtc', 'PnL')]: 0.5,
          bodiesCompleted: 2,
        },
        celestialBodies: [
          { id: 'b1', [old('btc', 'Qty')]: 0.2, [old('btcOn', 'Order')]: 0.1 },
          { id: 'b2', assetQty: 0.3, assetOnOrder: 0.25 },
        ],
      },
    });

    const { position } = st.loadRegimeState('cb', 'BTC-USD');

    assert.equal(position.totalAsset, 1.5);
    assert.equal(position.realizedAssetPnL, 12.25);
    assert.equal(position.maxAssetExposure, 3.5);
    assert.equal(position.assetOnOrder, 0.75);
    assert.equal(position.cycleBuys, 4);
    for (const key of [old('total', 'BTC'), old('realizedBtc', 'PnL'), old('maxBtc', 'Exposure'), old('btcOn', 'Order'), 'ladderStep']) {
      assert.equal(key in position, false, `${key} should be gone`);
    }

    assert.equal(position.celestialState.bodiesRealizedAssetPnL, 0.5);
    assert.equal(position.celestialState.bodiesCompleted, 2);
    assert.equal(old('bodiesRealizedBtc', 'PnL') in position.celestialState, false);

    const [b1, b2] = position.celestialBodies;
    assert.equal(b1.assetQty, 0.2);
    assert.equal(b1.assetOnOrder, 0.1);
    assert.equal(old('btc', 'Qty') in b1, false);
    assert.equal(old('btcOn', 'Order') in b1, false);
    assert.deepEqual(b2, { id: 'b2', assetQty: 0.3, assetOnOrder: 0.25 });
  });

  it('loads a file with no legacy keys unchanged', () => {
    const st = freshModule();
    const position = {
      totalAsset: 2,
      realizedAssetPnL: 1,
      maxAssetExposure: 5,
      assetOnOrder: 0.5,
      cycleBuys: 3,
      celestialState: { bodiesRealizedAssetPnL: 0.25, bodiesCompleted: 1 },
      celestialBodies: [{ id: 'b1', assetQty: 0.4, assetOnOrder: 0.3 }],
    };
    writeState(st, { position: JSON.parse(JSON.stringify(position)) });

    const loaded = st.loadRegimeState('cb', 'BTC-USD').position;

    for (const [key, value] of Object.entries(position)) {
      assert.deepEqual(loaded[key], value, key);
    }
  });
});
