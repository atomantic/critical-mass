// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createPositionSizer } = require('../src/position-sizer');
const celestialHierarchy = require('../src/celestial-hierarchy');
const { floorToIncrement } = require('../src/shared-utils');
const { roundAsset, roundPrice } = require('../src/volatility-utils');
const { isStrandedDustBody } = require('../src/regime-engine');

// Exercise the private production closure without starting an engine or loading
// fund state. Only its external effects are replaced with in-memory doubles.
const engineSource = fs.readFileSync(require.resolve('../src/regime-engine'), 'utf8');
const start = engineSource.indexOf('  const placeBodyTp = async (body) => {');
const end = engineSource.indexOf('\n  };', start) + '\n  };'.length;
const placementSource = engineSource.slice(start, end);

const makeHarness = (assetQty, baseMinSize = '0.29') => {
  const config = { holdbackRatio: 0.5, feeRate: 0.001, tpMaxPercent: 5 };
  const body = {
    id: 'test-body', tier: 'satellite', assetQty, avgPrice: 100,
    costBasis: assetQty * 100, tpOrderId: null, sourceOrderIds: ['buy-1'],
  };
  const calls = [];
  const events = [];
  const annotations = [];
  const inFlight = new Set();
  const positionSizer = createPositionSizer('test', config);
  const placeBodyTp = vm.runInNewContext(placementSource + '\nplaceBodyTp;', {
    config, positionSizer, celestialHierarchy, floorToIncrement, roundAsset, roundPrice,
    productDetails: { baseMinSize, baseIncrement: '0.01' },
    priceIncrement: 0.01, calculateDynamicTpPercent: () => 1,
    tpPlacementInFlight: inFlight, dustWaitLoggedQty: new Map(),
    exchange: 'test', baseCurrency: 'TEST', fmtPrice: String,
    logger: { info() {}, warn() {} },
    positionState: { celestialBodies: [body] },
    orderExecutor: {
      placeBodyTpOrder: async (...args) => {
        calls.push(args);
        return { success: true, orderId: 'tp-1' };
      },
    },
    fillLedger: { annotateFillsByOrderIds: (...args) => annotations.push(args) },
    tradeEvents: { emitTradeEvent: (...args) => events.push(args[3]) },
  });
  return { body, calls, events, annotations, inFlight, placeBodyTp, positionSizer };
};

describe('body TP minimum rounding agrees with dust classification', () => {
  it('places the exact-minimum full body with zero holdback', async () => {
    const h = makeHarness(0.29);
    assert.equal(isStrandedDustBody(h.body, 0.29, 0.01), false);
    assert.equal(await h.placeBodyTp(h.body), true);
    assert.deepEqual(h.calls, [[0.29, 101, 'test-body', 100]]);
    assert.equal(h.events[0].holdbackQty, 0);
    assert.equal(h.body.assetOnOrder, 0.29);
    assert.equal(h.body.tpOrderId, 'tp-1');
    assert.equal(h.annotations.length, 1);
    assert.equal(h.inFlight.size, 0);
  });

  it('keeps genuine sub-minimum and sub-tick bodies unplaced and eligible as dust', async () => {
    for (const quantity of [0.28, 0.28999999]) {
      const h = makeHarness(quantity);
      assert.equal(isStrandedDustBody(h.body, 0.29, 0.01), true);
      assert.equal(await h.placeBodyTp(h.body), false);
      assert.equal(h.calls.length, 0);
      assert.equal(h.events.length, 0);
      assert.equal(h.annotations.length, 0);
      assert.equal(h.body.tpOrderId, null);
      assert.equal(h.inFlight.size, 0);
    }
  });

  it('retains holdback when the proposed sell is exactly the minimum', async () => {
    const h = makeHarness(0.29144279);
    const expected = h.positionSizer.calculateTakeProfitSize(h.body.assetQty, 100, 101, 1);
    assert.equal(expected.sellQty, 0.29);
    assert.equal(isStrandedDustBody(h.body, 0.29, 0.01), false);
    assert.equal(await h.placeBodyTp(h.body), true);
    assert.deepEqual(h.calls, [[expected.sellQty, 101, 'test-body', 100]]);
    assert.equal(h.events[0].holdbackQty, expected.holdbackQty);
    assert.ok(h.events[0].holdbackQty > 0);
  });

  it('retains normal above-minimum holdback and leaves adapter quantity flooring intact', async () => {
    const h = makeHarness(0.4);
    const expected = h.positionSizer.calculateTakeProfitSize(0.4, 100, 101, 1);
    assert.equal(isStrandedDustBody(h.body, 0.29, 0.01), false);
    assert.equal(await h.placeBodyTp(h.body), true);
    assert.deepEqual(h.calls, [[expected.sellQty, 101, 'test-body', 100]]);
    assert.equal(h.events[0].holdbackQty, expected.holdbackQty);
    assert.ok(h.events[0].holdbackQty > 0);
    assert.equal(floorToIncrement(h.calls[0][0], 0.01), 0.39);
  });
});
