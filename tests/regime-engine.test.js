// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { cancelPartialFillOrder, resolveEntryBudget } = require('../src/regime-engine');

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
