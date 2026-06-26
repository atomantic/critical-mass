// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { cancelPartialFillOrder, resolveEntryBudget, isBuyAlreadyCommitted, shouldSkipBuyRecommit, isStrandedDustBody } = require('../src/regime-engine');

describe('cancelPartialFillOrder', () => {
  const makeDeps = ({ cancelOrder, exchange = 'gemini' } = {}) => {
    const logs = [];
    const log = (msg) => logs.push(msg);
    return {
      deps: { adapter: { cancelOrder }, exchange, log },
      logs,
    };
  };

  it('reports cancelled when adapter confirms', async () => {
    const calls = [];
    const cancelOrder = async (orderId) => {
      calls.push(orderId);
      return { success: true };
    };
    const { deps, logs } = makeDeps({ cancelOrder });
    const result = await cancelPartialFillOrder(deps, 'order-123');
    assert.deepEqual(result, { cancelled: true });
    assert.deepEqual(calls, ['order-123']);
    assert.deepEqual(logs, []);
  });

  it('reports not-cancelled and logs when adapter returns success=false (already terminal)', async () => {
    // Models the race where the order fully filled between poll-detection and
    // cancel. Adapter returns { success: false }; caller should proceed to
    // getOrderFills which will see all fills now that the order is frozen.
    const cancelOrder = async () => ({ success: false });
    const { deps, logs } = makeDeps({ cancelOrder });
    const result = await cancelPartialFillOrder(deps, 'order-456');
    assert.deepEqual(result, { cancelled: false });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /did not confirm for partial TP order-456/);
    assert.match(logs[0], /likely already terminal/);
  });

  it('reports not-cancelled and captures error when adapter throws', async () => {
    // Models a network/adapter failure. We still want handleOrderFill to
    // proceed with the rest of its work — losing some additional fills is
    // better than failing the whole fill-handling path.
    const err = new Error('network timeout');
    const cancelOrder = async () => { throw err; };
    const { deps, logs } = makeDeps({ cancelOrder });
    const result = await cancelPartialFillOrder(deps, 'order-789');
    assert.equal(result.cancelled, false);
    assert.equal(result.error, err);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /cancelOrder failed for partial TP order-789/);
    assert.match(logs[0], /network timeout/);
    assert.match(logs[0], /old order may keep filling/);
  });

  it('treats a missing success field as failure (defensive)', async () => {
    // Adapter contract is { success: boolean }, but some implementations
    // could return an empty object on weird API responses. Anything that
    // is not strictly truthy on .success should be treated as not-cancelled
    // so the caller logs and proceeds, rather than silently assuming the
    // order is dead.
    const cancelOrder = async () => ({});
    const { deps, logs } = makeDeps({ cancelOrder });
    const result = await cancelPartialFillOrder(deps, 'order-abc');
    assert.equal(result.cancelled, false);
    assert.equal(logs.length, 1);
  });

  it('treats null adapter response as failure', async () => {
    const cancelOrder = async () => null;
    const { deps, logs } = makeDeps({ cancelOrder });
    const result = await cancelPartialFillOrder(deps, 'order-null');
    assert.equal(result.cancelled, false);
    assert.equal(logs.length, 1);
  });

  it('uses the provided exchange name in log messages', async () => {
    const cancelOrder = async () => ({ success: false });
    const { deps, logs } = makeDeps({ cancelOrder, exchange: 'coinbase' });
    await cancelPartialFillOrder(deps, 'order-cb');
    assert.match(logs[0], /\[coinbase\]/);
  });

  it('falls back to console.log when no log is injected', async () => {
    // Just verifies the default; we don't assert on stdout, only that the
    // function doesn't throw without an injected logger.
    const cancelOrder = async () => ({ success: true });
    const result = await cancelPartialFillOrder(
      { adapter: { cancelOrder }, exchange: 'gemini' },
      'order-default-log'
    );
    assert.equal(result.cancelled, true);
  });
});

describe('resolveEntryBudget', () => {
  const MIN = 10;

  it('places the full requested size when the wallet can cover it', () => {
    assert.deepEqual(resolveEntryBudget(100, 250, MIN), { action: 'place', sizeUsdc: 100 });
  });

  it('places at exactly the requested size when balance equals it', () => {
    assert.deepEqual(resolveEntryBudget(100, 100, MIN), { action: 'place', sizeUsdc: 100 });
  });

  it('skips (no cooldown) when the balance is unverifiable', () => {
    assert.deepEqual(resolveEntryBudget(100, null, MIN), { action: 'skip' });
  });

  it('trims to the available balance when it is below the requested size but above the minimum', () => {
    assert.deepEqual(resolveEntryBudget(100, 67.056, MIN), { action: 'place', sizeUsdc: 67.05 });
  });

  it('floors the trimmed size so it never rounds above the real balance', () => {
    // 67.059 must not become 67.06 (which exceeds the wallet) — Math.round would.
    const { sizeUsdc } = resolveEntryBudget(100, 67.059, MIN);
    assert.ok(sizeUsdc <= 67.059, `trimmed size ${sizeUsdc} must not exceed balance 67.059`);
    assert.equal(sizeUsdc, 67.05);
  });

  it('signals cooldown when the wallet cannot fund even the minimum order', () => {
    assert.deepEqual(resolveEntryBudget(100, 5, MIN), { action: 'cooldown' });
  });

  it('signals cooldown on a fully drained wallet', () => {
    assert.deepEqual(resolveEntryBudget(100, 0, MIN), { action: 'cooldown' });
  });
});

describe('isBuyAlreadyCommitted (issue #131)', () => {
  it('is false when no body owns the orderId', () => {
    const bodies = [{ sourceOrderIds: ['other-1'], buyOrders: [{ orderId: 'other-1' }] }];
    assert.equal(isBuyAlreadyCommitted(bodies, 'buy-x'), false);
  });

  it('is true when a body lists the orderId in sourceOrderIds', () => {
    const bodies = [{ sourceOrderIds: ['buy-x'], buyOrders: [] }];
    assert.equal(isBuyAlreadyCommitted(bodies, 'buy-x'), true);
  });

  it('is true when a body lists the orderId in buyOrders', () => {
    const bodies = [{ sourceOrderIds: [], buyOrders: [{ orderId: 'buy-x' }] }];
    assert.equal(isBuyAlreadyCommitted(bodies, 'buy-x'), true);
  });

  it('handles missing/empty bodies and missing constituent arrays', () => {
    assert.equal(isBuyAlreadyCommitted(undefined, 'buy-x'), false);
    assert.equal(isBuyAlreadyCommitted([], 'buy-x'), false);
    assert.equal(isBuyAlreadyCommitted([{}], 'buy-x'), false);
  });

  it('detects the orderId across multiple bodies', () => {
    const bodies = [
      { sourceOrderIds: ['a'], buyOrders: [{ orderId: 'a' }] },
      { sourceOrderIds: ['b', 'buy-x'], buyOrders: [{ orderId: 'b' }, { orderId: 'buy-x' }] },
    ];
    assert.equal(isBuyAlreadyCommitted(bodies, 'buy-x'), true);
  });
});

describe('shouldSkipBuyRecommit (issue #131 — advancing-partial guard, codex P1)', () => {
  const committed = [{ sourceOrderIds: ['buy-x'], buyOrders: [{ orderId: 'buy-x' }] }];

  it('SKIPS a retry: body already owns the orderId AND no new fills ingested', () => {
    assert.equal(shouldSkipBuyRecommit(0, committed, 'buy-x'), true);
  });

  it('does NOT skip an advancing partial: body owns the orderId but NEW fills were ingested', () => {
    // This is the codex P1 regression: an advancing partial buy fill brings new
    // trade rows and must process even though the first partial created a body.
    assert.equal(shouldSkipBuyRecommit(2, committed, 'buy-x'), false);
  });

  it('does NOT skip the first fill of a brand-new order (no body owns it yet)', () => {
    assert.equal(shouldSkipBuyRecommit(0, committed, 'buy-new'), false);
    assert.equal(shouldSkipBuyRecommit(1, [], 'buy-new'), false);
  });

  // cycleBuys-counts-once contract (codex P2): the handler increments cycleBuys
  // only when the order is NOT already owned. isBuyAlreadyCommitted is the gate.
  it('an advancing partial is recognized as already-owned (so cycleBuys is not re-counted)', () => {
    // First partial created the body → order is owned. The advancing partial
    // still processes (shouldSkipBuyRecommit false because new fills arrived),
    // but isBuyAlreadyCommitted is true so the inline guard suppresses cycleBuys++.
    assert.equal(isBuyAlreadyCommitted(committed, 'buy-x'), true);
    assert.equal(shouldSkipBuyRecommit(3, committed, 'buy-x'), false);
  });
});

describe('isStrandedDustBody (issue #189)', () => {
  const MIN = 0.001;       // exchange min order size (e.g. ETH)
  const INC = 0.00000001;  // base increment

  it('flags a positive-qty body that rounds below the exchange minimum and has no TP', () => {
    assert.equal(isStrandedDustBody({ assetQty: 0.000525, tpOrderId: null }, MIN, INC), true);
  });

  it('does NOT flag a body that already has a resting TP, even if below min', () => {
    assert.equal(isStrandedDustBody({ assetQty: 0.000525, tpOrderId: 'order-123' }, MIN, INC), false);
  });

  it('does NOT flag a body at or above the exchange minimum', () => {
    assert.equal(isStrandedDustBody({ assetQty: 0.001, tpOrderId: null }, MIN, INC), false);
    assert.equal(isStrandedDustBody({ assetQty: 0.05, tpOrderId: null }, MIN, INC), false);
  });

  it('does NOT flag an empty/zero/negative-qty body (would churn a neighbour TP for nothing)', () => {
    assert.equal(isStrandedDustBody({ assetQty: 0, tpOrderId: null }, MIN, INC), false);
    assert.equal(isStrandedDustBody({ assetQty: -1, tpOrderId: null }, MIN, INC), false);
    assert.equal(isStrandedDustBody({ tpOrderId: null }, MIN, INC), false); // assetQty undefined
  });

  it('flags a qty that is >= min raw but falls below min AFTER increment rounding', () => {
    // 0.0013 >= min 0.001, but floor to a 0.0007 increment → 0.0007 < min.
    assert.equal(isStrandedDustBody({ assetQty: 0.0013, tpOrderId: null }, MIN, 0.0007), true);
  });

  it('does NOT flag a body sitting exactly at the minimum under a decimal increment (float-floor #195)', () => {
    // 0.29 at increment 0.01: a naive Math.floor(0.29/0.01)*0.01 under-floors to
    // 0.28 (float error), which would misclassify an at-minimum sellable body as
    // dust. floorToIncrement snaps 0.29 back to 0.29, so it is NOT dust.
    assert.equal(isStrandedDustBody({ assetQty: 0.29, tpOrderId: null }, 0.29, 0.01), false);
    // And a genuinely sub-min qty under the same decimal increment IS dust.
    assert.equal(isStrandedDustBody({ assetQty: 0.005, tpOrderId: null }, 0.29, 0.01), true);
  });

  it('handles a null body safely', () => {
    assert.equal(isStrandedDustBody(null, MIN, INC), false);
  });
});
