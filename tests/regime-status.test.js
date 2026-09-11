// @ts-check
/**
 * Tests for src/regime-status.js — the canonical "regime engine not
 * running" status synthesizer (issue #357). Before this, the engine's
 * IPC handler, the HTTP gateway's offline fallback, and the Socket.IO
 * stream each rebuilt this payload independently and drifted; these
 * tests cover the shared helper's contract: P&L re-derivation from the
 * fill ledger, payload shape compatibility across modes, and edge-case
 * handling (missing/corrupt state, ledger failures).
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { buildStoppedRegimeStatus } = require('../src/regime-status');

// ---------------------------------------------------------------------------
// Unit tests: dependency-injected config/regimeState/fillLedger (no disk I/O)
// ---------------------------------------------------------------------------

/** Minimal fake fill ledger — override getDerivedRealizedPnL/getAllFills per test. */
const makeFakeLedger = ({ derived, fills = [] } = {}) => ({
  getDerivedRealizedPnL: () => derived || {
    realizedPnL: 0,
    realizedAssetPnL: 0,
    heldOpenBuyCostBasis: 0,
  },
  getAllFills: () => fills,
});

const makeRegimeState = (positionOverrides = {}) => ({
  position: {
    lifecycle: 'ACTIVE',
    celestialBodies: [],
    realizedPnL: -999, // deliberately stale/wrong — must be overwritten by derivation
    realizedAssetPnL: -999,
    heldAssetCostBasis: -999,
    ...positionOverrides,
  },
  regime: { mode: 'harvest', since: 12345 },
  isDryRun: false,
});

describe('buildStoppedRegimeStatus (issue #357)', () => {
  it('re-derives realizedPnL / realizedAssetPnL / heldAssetCostBasis from the fill ledger, overwriting stale persisted values', () => {
    const ledger = makeFakeLedger({
      derived: { realizedPnL: 4.2, realizedAssetPnL: 0.0001, heldOpenBuyCostBasis: 12.5 },
    });
    const status = buildStoppedRegimeStatus('coinbase', 'BTC-USD', {
      config: { productId: 'BTC-USD', maxUsdcDeployed: 10000 },
      regimeState: makeRegimeState(),
      fillLedger: ledger,
    });

    assert.equal(status.position.realizedPnL, 4.2);
    assert.equal(status.position.realizedAssetPnL, 0.0001);
    assert.equal(status.position.heldAssetCostBasis, 12.5);
  });

  it('falls back to the ledger\'s most recent fill price for market.lastPrice (stale:true) when no live market is supplied', () => {
    const ledger = makeFakeLedger({
      fills: [
        { price: 100000, timestamp: 1000 },
        { price: 105000, timestamp: 2000 }, // most recent — should win
        { price: 99000, timestamp: 500 },
      ],
    });
    const status = buildStoppedRegimeStatus('coinbase', 'BTC-USD', {
      config: { productId: 'BTC-USD' },
      regimeState: makeRegimeState(),
      fillLedger: ledger,
    });

    assert.deepEqual(status.market, { lastPrice: 105000, stale: true });
  });

  it('embeds a supplied live market snapshot as-is, without the stale flag', () => {
    const ledger = makeFakeLedger({ fills: [{ price: 999999, timestamp: 1 }] });
    const market = { lastPrice: 50000, bid: 49990, ask: 50010 };
    const status = buildStoppedRegimeStatus('coinbase', 'BTC-USD', {
      config: { productId: 'BTC-USD' },
      regimeState: makeRegimeState(),
      fillLedger: ledger,
      market,
    });

    assert.deepEqual(status.market, market);
  });

  it('embeds a supplied live regime snapshot instead of the persisted regime state', () => {
    const liveRegime = { mode: 'caution', since: 999 };
    const status = buildStoppedRegimeStatus('coinbase', 'BTC-USD', {
      config: { productId: 'BTC-USD' },
      regimeState: makeRegimeState(),
      fillLedger: makeFakeLedger(),
      regime: liveRegime,
    });

    assert.deepEqual(status.regime, liveRegime);
  });

  it('falls back to the persisted regime state when no live regime is supplied', () => {
    const status = buildStoppedRegimeStatus('coinbase', 'BTC-USD', {
      config: { productId: 'BTC-USD' },
      regimeState: makeRegimeState(),
      fillLedger: makeFakeLedger(),
    });

    assert.deepEqual(status.regime, { mode: 'harvest', since: 12345 });
  });

  it('sets health.mode + engineDown for ENGINE_DOWN (unreachable engine), but not for the default STOPPED (clean stop)', () => {
    const base = {
      config: { productId: 'BTC-USD' },
      regimeState: makeRegimeState(),
      fillLedger: makeFakeLedger(),
    };
    const stopped = buildStoppedRegimeStatus('coinbase', 'BTC-USD', base);
    const engineDown = buildStoppedRegimeStatus('coinbase', 'BTC-USD', { ...base, mode: 'ENGINE_DOWN' });

    assert.equal(stopped.health.mode, 'STOPPED');
    assert.equal(stopped.engineDown, undefined);
    assert.equal(engineDown.health.mode, 'ENGINE_DOWN');
    assert.equal(engineDown.engineDown, true);
  });

  it('produces shape-compatible payloads for STOPPED and ENGINE_DOWN modes (same keys, only health/engineDown differ)', () => {
    const base = {
      config: { productId: 'BTC-USD' },
      regimeState: makeRegimeState(),
      fillLedger: makeFakeLedger(),
    };
    const stopped = buildStoppedRegimeStatus('coinbase', 'BTC-USD', base);
    const engineDown = buildStoppedRegimeStatus('coinbase', 'BTC-USD', { ...base, mode: 'ENGINE_DOWN' });

    const stoppedKeys = Object.keys(stopped).filter(k => k !== 'health' && k !== 'engineDown').sort();
    const engineDownKeys = Object.keys(engineDown).filter(k => k !== 'health' && k !== 'engineDown').sort();
    assert.deepEqual(stoppedKeys, engineDownKeys);

    for (const key of ['isRunning', 'position', 'market', 'regime', 'pendingOrders', 'apy', 'lifecycle', 'celestial', 'isDryRun']) {
      assert.ok(key in stopped, `stopped payload missing ${key}`);
      assert.ok(key in engineDown, `engineDown payload missing ${key}`);
    }
  });

  it('passes getOrderStatus through to drop persisted TPs the WS feed already knows are closed', () => {
    const regimeState = makeRegimeState({
      celestialBodies: [
        { id: 'body-1', tier: 'MOON', tpOrderId: 'tp-closed', assetQty: 0.001, costBasis: 100, avgPrice: 100000, tpPrice: 105000 },
        { id: 'body-2', tier: 'MOON', tpOrderId: 'tp-open', assetQty: 0.001, costBasis: 100, avgPrice: 100000, tpPrice: 105000 },
      ],
    });
    const getOrderStatus = (orderId) => (orderId === 'tp-closed' ? 'filled' : null);

    const status = buildStoppedRegimeStatus('coinbase', 'BTC-USD', {
      config: { productId: 'BTC-USD' },
      regimeState,
      fillLedger: makeFakeLedger(),
      getOrderStatus,
    });

    const orderIds = status.pendingOrders.map(o => o.orderId);
    assert.ok(orderIds.includes('tp-open'), 'still-open TP must be surfaced');
    assert.ok(!orderIds.includes('tp-closed'), 'known-closed TP must be dropped, not shown as a phantom row');
  });

  it('handles a null/empty position gracefully: no crash, empty pendingOrders, empty apy, disabled-looking celestial', () => {
    const status = buildStoppedRegimeStatus('coinbase', 'BTC-USD', {
      config: { productId: 'BTC-USD' },
      regimeState: { position: null, regime: null, isDryRun: false },
      fillLedger: makeFakeLedger(),
    });

    assert.equal(status.position, null);
    assert.deepEqual(status.pendingOrders, []);
    assert.deepEqual(status.apy, {});
    assert.equal(status.celestial.bodiesActive, 0);
  });

  it('does not throw when the ledger derivation itself fails — logs and falls through with a status still returned', () => {
    const throwingLedger = {
      getDerivedRealizedPnL: () => { throw new Error('corrupt ledger'); },
      getAllFills: () => [],
    };
    const status = buildStoppedRegimeStatus('coinbase', 'BTC-USD', {
      config: { productId: 'BTC-USD' },
      regimeState: makeRegimeState(),
      fillLedger: throwingLedger,
    });

    assert.ok(status, 'a status object must still be returned');
    // Stale persisted values are left untouched since derivation failed
    assert.equal(status.position.realizedPnL, -999);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: real disk state via a temp data dir (no DI overrides),
// covering requireExistingState (the HTTP offline-route contract) and
// end-to-end P&L re-derivation through a real fill ledger.
// ---------------------------------------------------------------------------
describe('buildStoppedRegimeStatus — disk-backed (requireExistingState + real ledger)', () => {
  const migration = require('../src/migration');
  const stateTracker = require('../src/state-tracker');
  const fillLedgerModule = require('../src/fill-ledger');
  const originalGetExchangeDataDir = migration.getExchangeDataDir;
  const fillLedgerPath = require.resolve('../src/fill-ledger');

  /** @type {string|null} */
  let tmpDir = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-status-test-'));
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
    // Reset fill-ledger's module-level read-only cache so the next test's
    // tmpDir (a different path) is never confused with this one's.
    delete require.cache[fillLedgerPath];
  });

  it('returns null when requireExistingState is set and no regime-state.json exists yet (true IPC outage on a first-time fund)', () => {
    const status = buildStoppedRegimeStatus('coinbase', 'BTC-USD', { requireExistingState: true });
    assert.equal(status, null);
  });

  it('returns null when requireExistingState is set and regime-state.json is corrupt, instead of throwing', () => {
    const stateFile = stateTracker.getRegimeStateFile('coinbase', 'BTC-USD');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, '{ not valid json');

    const status = buildStoppedRegimeStatus('coinbase', 'BTC-USD', { requireExistingState: true });
    assert.equal(status, null);
  });

  it('propagates the corrupt-state error when requireExistingState is NOT set (callers that always expect a status, e.g. the engine IPC handler)', () => {
    const stateFile = stateTracker.getRegimeStateFile('coinbase', 'BTC-USD');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, '{ not valid json');

    assert.throws(() => buildStoppedRegimeStatus('coinbase', 'BTC-USD', {}));
  });

  it('end-to-end: re-derives realizedPnL from a real fill ledger on disk, overwriting the stale persisted position', () => {
    const position = {
      ...stateTracker.createInitialRegimePositionState(),
      lifecycle: stateTracker.LIFECYCLE.ACTIVE,
      realizedPnL: -1, // stale — the real fill ledger below says otherwise
      realizedAssetPnL: -1,
    };
    stateTracker.saveRegimeState(position, { mode: 'harvest' }, 'coinbase', null, null, 'BTC-USD');

    const { createFillLedger } = fillLedgerModule;
    const ledger = createFillLedger('coinbase', 'BTC-USD', 'BTC-USD');
    ledger.startNewCycle();
    ledger.ingestFill({
      tradeId: 'e2e-buy-1', orderId: 'e2e-buy-order', side: 'buy',
      price: '100000', size: '0.001', totalCommission: '0.10', rebate: '0',
      liquidityIndicator: 'TAKER', tradeTime: '2025-01-01T00:00:00Z',
    });
    ledger.annotateFillsByOrderId('e2e-buy-order', { sellOrderId: 'e2e-tp-order', bodyId: 'body-1' });
    ledger.ingestFill({
      tradeId: 'e2e-sell-1', orderId: 'e2e-tp-order', side: 'sell',
      price: '105000', size: '0.0009', totalCommission: '0.10', rebate: '0',
      liquidityIndicator: 'TAKER', tradeTime: '2025-01-01T01:00:00Z',
    });
    ledger.annotateFillsByOrderId('e2e-tp-order', { bodyPnl: 3.15, bodyHoldbackAsset: 0.0001, isBodyOwned: true });
    ledger.persist();

    const status = buildStoppedRegimeStatus('coinbase', 'BTC-USD', { mode: 'ENGINE_DOWN', requireExistingState: true });

    assert.ok(status, 'existing regime-state.json must produce a status, not null');
    assert.equal(status.position.realizedPnL, 3.15, 'realizedPnL must come from the ledger, not the stale persisted -1');
    assert.equal(status.position.realizedAssetPnL, 0.0001);
    assert.equal(status.market.lastPrice, 105000, 'market.lastPrice falls back to the ledger\'s most recent fill');
    assert.equal(status.market.stale, true);
    assert.equal(status.engineDown, true);
  });
});
