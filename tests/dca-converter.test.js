// @ts-check
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { categorizeOrders } = require('../src/dca-converter');

// issue #106 follow-up — a DCA→regime conversion must not silently drop
// 'awaiting_sell' / 'sell_failed' rows. Those represent a REAL filled buy whose
// sell is pending or failed (asset held with an open obligation), so they
// belong in the `pending` bucket alongside open-sell positions, not dropped.
describe('categorizeOrders (issue #106 follow-up)', () => {
  it('buckets pending and filled as before', () => {
    const { pending, filled, skipped } = categorizeOrders([
      { status: 'pending', orderId: 's1', buyQuantity: 0.01 },
      { status: 'filled', orderId: 's2', buyQuantity: 0.02 },
    ]);
    assert.equal(pending.length, 1);
    assert.equal(filled.length, 1);
    assert.equal(skipped, 0);
  });

  it('treats awaiting_sell and sell_failed as pending (real held positions)', () => {
    const { pending, filled, skipped } = categorizeOrders([
      { status: 'awaiting_sell', orderId: null, buyOrderId: 'b1', buyQuantity: 0.03 },
      { status: 'sell_failed', orderId: null, buyOrderId: 'b2', buyQuantity: 0.04, sellFailedReason: 'x' },
    ]);
    assert.equal(pending.length, 2, 'both must be migrated as pending, not dropped');
    assert.equal(filled.length, 0);
    assert.equal(skipped, 0);
    assert.deepEqual(pending.map(o => o.buyOrderId).sort(), ['b1', 'b2']);
  });

  it('skips consolidated source orders and counts truly-unknown statuses as skipped', () => {
    const { pending, filled, skipped } = categorizeOrders([
      { status: 'pending', consolidatedInto: 'merged-1', buyQuantity: 0.01 },
      { status: 'some_future_status', orderId: 'x', buyQuantity: 0.05 },
    ]);
    assert.equal(pending.length, 0);
    assert.equal(filled.length, 0);
    assert.equal(skipped, 2, 'consolidated + unknown both counted as skipped');
  });
});

// issue #414 — the DCA→Regime converter was never updated for the per-fund
// (multi-pair) data layout:
//   1. backupConversionFiles read `data/<exchange>/` while every write went to
//      `data/<exchange>/<pair>/`, so the advertised safety backup copied
//      nothing on any migrated install.
//   2. previewConversion/executeConversion/mergeToRegime took only `exchange`,
//      so converting a non-default fund rewrote the DEFAULT fund's ledger.
describe('dca-converter fund routing (issue #414)', () => {
  const DCA_CONVERTER = require.resolve('../src/dca-converter');
  const STATE_TRACKER = require.resolve('../src/state-tracker');
  const FILL_LEDGER = require.resolve('../src/fill-ledger');

  const migration = require('../src/migration');
  const configUtils = require('../src/config-utils');

  const EXCHANGE = 'coinbase';
  const DEFAULT_PAIR = 'BTC-USDC';
  const OTHER_PAIR = 'ETH-USDC';

  /** @type {string} */
  let tmpDir;
  /** @type {Array<{exchange: string, pair: string|undefined, enabled: boolean}>} */
  let enabledCalls;
  /** @type {Object} */
  let originals;
  /** @type {typeof import('../src/dca-converter')} */
  let converter;

  const fundDir = (pair) => path.join(tmpDir, EXCHANGE, pair);

  /** Write the post-migration layout: every per-fund file under <exchange>/<pair>/. */
  const seedFund = (pair, { orders = [] } = {}) => {
    const dir = fundDir(pair);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
      orders,
      totalAllocated: 1000,
      initialAllocation: 0,
      usdcFundSize: 0,
      assetReserves: 0,
    }));
    fs.writeFileSync(path.join(dir, 'fill-ledger.json'), '[]');
    fs.writeFileSync(path.join(dir, 'regime-state.json'), JSON.stringify({
      position: { celestialBodies: [], totalAsset: 0, totalCostBasis: 0, _saveVersion: 1 },
      regime: { currentRegime: 'calm' },
    }));
    return dir;
  };

  const sampleOrders = (suffix) => ([
    {
      status: 'filled',
      orderId: `sell-done-${suffix}`,
      buyOrderId: `buy-done-${suffix}`,
      buyQuantity: 0.01,
      buyPrice: 50000,
      buyUSDC: 500,
      buyFees: 1,
      buyCostBasis: 501,
      sellQuantity: 0.01,
      sellPrice: 52000,
      sellFees: 1,
      createdAt: '2025-01-01T00:00:00.000Z',
      filledAt: '2025-01-02T00:00:00.000Z',
    },
    {
      status: 'pending',
      orderId: `sell-open-${suffix}`,
      buyOrderId: `buy-open-${suffix}`,
      buyQuantity: 0.02,
      buyPrice: 48000,
      buyUSDC: 960,
      buyFees: 2,
      buyCostBasis: 962,
      sellPrice: 51000,
      createdAt: '2025-02-01T00:00:00.000Z',
    },
  ]);

  const backupsIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter(f => f.includes('.backup-dca-convert-'));

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'critical-mass-dca-fund-'));
    enabledCalls = [];

    originals = {
      getExchangeDataDir: migration.getExchangeDataDir,
      getDefaultPair: configUtils.getDefaultPair,
      getFundConfig: configUtils.getFundConfig,
      getRegimeConfig: configUtils.getRegimeConfig,
      setExchangeEnabled: configUtils.setExchangeEnabled,
      loadRawConfig: configUtils.loadRawConfig,
    };

    migration.getExchangeDataDir = (exchange) => {
      const dir = path.join(tmpDir, exchange);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    configUtils.getDefaultPair = () => DEFAULT_PAIR;
    configUtils.getFundConfig = (_exchange, pair) => ({ productId: pair || DEFAULT_PAIR });
    configUtils.getRegimeConfig = () => ({ maxUsdcDeployed: 500 });
    // Never touch the real config.json from a test.
    configUtils.setExchangeEnabled = (exchange, enabledOrPair, maybeEnabled) => {
      enabledCalls.push(typeof enabledOrPair === 'string'
        ? { exchange, pair: enabledOrPair, enabled: maybeEnabled }
        : { exchange, pair: undefined, enabled: enabledOrPair });
      return {};
    };
    configUtils.loadRawConfig = () => ({ totalAllocation: 0 });

    // These modules destructure their collaborators at require time, so they
    // must be re-required AFTER the stubs are installed.
    for (const mod of [STATE_TRACKER, FILL_LEDGER, DCA_CONVERTER]) delete require.cache[mod];
    converter = require('../src/dca-converter');
  });

  afterEach(() => {
    migration.getExchangeDataDir = originals.getExchangeDataDir;
    configUtils.getDefaultPair = originals.getDefaultPair;
    configUtils.getFundConfig = originals.getFundConfig;
    configUtils.getRegimeConfig = originals.getRegimeConfig;
    configUtils.setExchangeEnabled = originals.setExchangeEnabled;
    configUtils.loadRawConfig = originals.loadRawConfig;
    for (const mod of [STATE_TRACKER, FILL_LEDGER, DCA_CONVERTER]) delete require.cache[mod];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('backupConversionFiles resolves the per-fund directory, not the exchange directory', () => {
    seedFund(DEFAULT_PAIR);

    const { backupSuffix, backedUpFiles } = converter.backupConversionFiles(EXCHANGE, DEFAULT_PAIR);

    assert.match(backupSuffix, /^\.backup-dca-convert-\d+$/);
    assert.deepEqual(backedUpFiles, ['state.json', 'fill-ledger.json', 'regime-state.json']);
    for (const file of backedUpFiles) {
      assert.equal(
        fs.readFileSync(path.join(fundDir(DEFAULT_PAIR), file + backupSuffix), 'utf8'),
        fs.readFileSync(path.join(fundDir(DEFAULT_PAIR), file), 'utf8'),
      );
    }
    assert.deepEqual(backupsIn(path.join(tmpDir, EXCHANGE)), [], 'nothing must be written at the exchange level');
  });

  it('backupConversionFiles defaults to the exchange default pair when no pair is given', () => {
    seedFund(DEFAULT_PAIR);
    const { backedUpFiles } = converter.backupConversionFiles(EXCHANGE);
    assert.equal(backedUpFiles.length, 3);
    assert.equal(backupsIn(fundDir(DEFAULT_PAIR)).length, 3);
  });

  it('backupConversionFiles throws rather than returning an empty backup', () => {
    fs.mkdirSync(fundDir(OTHER_PAIR), { recursive: true });
    assert.throws(
      () => converter.backupConversionFiles(EXCHANGE, OTHER_PAIR),
      /refusing to convert without a rollback backup/,
    );
  });

  it('executeConversion backs up the per-fund files on a migrated install', () => {
    seedFund(DEFAULT_PAIR, { orders: sampleOrders('a') });

    const result = converter.executeConversion(EXCHANGE);

    assert.equal(result.success, true);
    assert.deepEqual(result.backedUpFiles, ['state.json', 'fill-ledger.json', 'regime-state.json']);
    for (const file of ['fill-ledger.json', 'regime-state.json']) {
      assert.ok(
        fs.existsSync(path.join(fundDir(DEFAULT_PAIR), file + result.backupDir)),
        `${file} must be backed up inside data/${EXCHANGE}/${DEFAULT_PAIR}/`,
      );
    }
    assert.deepEqual(backupsIn(path.join(tmpDir, EXCHANGE)), []);

    // The backup is a genuine rollback point: it predates the rewrite.
    assert.equal(fs.readFileSync(path.join(fundDir(DEFAULT_PAIR), `fill-ledger.json${result.backupDir}`), 'utf8'), '[]');
    const ledger = JSON.parse(fs.readFileSync(path.join(fundDir(DEFAULT_PAIR), 'fill-ledger.json'), 'utf8'));
    assert.ok(ledger.length > 0, 'conversion must have written synthetic fills');
  });

  it('executeConversion on a non-default pair leaves the default fund byte-identical', () => {
    seedFund(DEFAULT_PAIR, { orders: sampleOrders('btc') });
    seedFund(OTHER_PAIR, { orders: sampleOrders('eth') });

    const before = ['fill-ledger.json', 'regime-state.json', 'state.json'].map(
      f => fs.readFileSync(path.join(fundDir(DEFAULT_PAIR), f)),
    );

    const result = converter.executeConversion(EXCHANGE, OTHER_PAIR);
    assert.equal(result.success, true);

    const after = ['fill-ledger.json', 'regime-state.json', 'state.json'].map(
      f => fs.readFileSync(path.join(fundDir(DEFAULT_PAIR), f)),
    );
    assert.deepEqual(after, before, 'the running default fund must not be touched');
    assert.deepEqual(backupsIn(fundDir(DEFAULT_PAIR)), []);

    // ...and the requested fund IS converted.
    const ledger = JSON.parse(fs.readFileSync(path.join(fundDir(OTHER_PAIR), 'fill-ledger.json'), 'utf8'));
    assert.ok(ledger.some(f => f.orderId === 'buy-open-eth'), 'requested pair must receive the synthetic fills');
    assert.equal(backupsIn(fundDir(OTHER_PAIR)).length, 3);

    // The DCA engine disabled must be the converted fund, not the default one.
    assert.deepEqual(enabledCalls, [{ exchange: EXCHANGE, pair: OTHER_PAIR, enabled: false }]);
  });

  it('executeConversion throws without disabling the engine when there is nothing to back up', () => {
    seedFund(DEFAULT_PAIR, { orders: sampleOrders('btc') });
    fs.mkdirSync(fundDir(OTHER_PAIR), { recursive: true });

    assert.throws(
      () => converter.executeConversion(EXCHANGE, OTHER_PAIR),
      /refusing to convert without a rollback backup/,
    );
    assert.deepEqual(enabledCalls, [], 'DCA engine must stay enabled');
    assert.deepEqual(fs.readdirSync(fundDir(OTHER_PAIR)), [], 'no state may be written');
    assert.deepEqual(backupsIn(fundDir(DEFAULT_PAIR)), []);
  });

  it('mergeToRegime backs up and merges into the requested fund only', () => {
    seedFund(DEFAULT_PAIR, { orders: sampleOrders('btc') });
    seedFund(OTHER_PAIR, { orders: sampleOrders('eth') });

    const before = fs.readFileSync(path.join(fundDir(DEFAULT_PAIR), 'regime-state.json'));

    const result = converter.mergeToRegime(EXCHANGE, OTHER_PAIR);

    assert.equal(result.success, true);
    assert.equal(result.backedUpFiles.length, 3);
    assert.equal(backupsIn(fundDir(OTHER_PAIR)).length, 3);
    assert.deepEqual(backupsIn(fundDir(DEFAULT_PAIR)), []);
    assert.deepEqual(fs.readFileSync(path.join(fundDir(DEFAULT_PAIR), 'regime-state.json')), before);

    const merged = JSON.parse(fs.readFileSync(path.join(fundDir(OTHER_PAIR), 'regime-state.json'), 'utf8'));
    assert.equal(merged.position.celestialBodies.length, 1, 'the one pending order becomes one body');
    // mergeToRegime is non-destructive — it must not disable any DCA fund.
    assert.deepEqual(enabledCalls, []);
  });

  it('mergeToRegime throws when there is nothing to back up', () => {
    fs.mkdirSync(fundDir(OTHER_PAIR), { recursive: true });
    assert.throws(
      () => converter.mergeToRegime(EXCHANGE, OTHER_PAIR),
      /refusing to convert without a rollback backup/,
    );
  });

  it('previewConversion reads the requested pair, not the default pair', () => {
    seedFund(DEFAULT_PAIR, { orders: sampleOrders('btc') });
    seedFund(OTHER_PAIR, { orders: [] });

    const preview = converter.previewConversion(EXCHANGE, OTHER_PAIR);

    assert.equal(preview.productId, OTHER_PAIR);
    assert.equal(preview.pending, 0);
    assert.equal(preview.filled, 0);
    assert.deepEqual(converter.previewConversion(EXCHANGE, DEFAULT_PAIR).sellOrderIds, ['sell-open-btc']);
  });

  // issue #692 — mergeToRegime's ingestion loop had drifted from
  // executeConversion's: it never called startNewCycle() before the pending
  // buys and never stamped sellOrderId on a filled order's buy fill. Per
  // CLAUDE.md, cycles are atomic buy(n)->sell(1); mixing a completed pair
  // into the same cycle as still-open pending buys left the completed
  // trade's sell unpaired (realizedPnL zeroed) and made the low sell-ratio
  // cycle look "active" to recalculateCycles(). Both loops now share
  // ingestDcaOrdersIntoLedger.
  describe('mergeToRegime keeps cycles atomic and pairs P&L correctly (issue #692)', () => {
    const mergeOrders = () => ([
      {
        status: 'filled',
        orderId: 'sell-done',
        buyOrderId: 'buy-done',
        buyQuantity: 0.01,
        buyPrice: 50100,
        buyUSDC: 501,
        buyFees: 0,
        buyCostBasis: 501,
        sellQuantity: 0.01,
        sellPrice: 51380,
        sellFees: 0,
        createdAt: '2025-01-01T00:00:00.000Z',
        filledAt: '2025-01-02T00:00:00.000Z',
      },
      {
        status: 'pending',
        orderId: 'sell-open',
        buyOrderId: 'buy-open',
        buyQuantity: 0.02,
        buyPrice: 48100,
        buyUSDC: 962,
        buyFees: 0,
        buyCostBasis: 962,
        sellPrice: 51000,
        createdAt: '2025-02-01T00:00:00.000Z',
      },
    ]);

    /** Rewrite ONLY state.json's orders — unlike seedFund(), this leaves the
     * fill ledger and regime state from a prior merge call untouched, so a
     * second mergeToRegime call can be checked for idempotent re-ingestion. */
    const reseedOrders = (pair, orders) => {
      fs.writeFileSync(path.join(fundDir(pair), 'state.json'), JSON.stringify({
        orders,
        totalAllocated: 1000,
        initialAllocation: 0,
        usdcFundSize: 0,
        assetReserves: 0,
      }));
    };

    it("does not mix a completed DCA trade into the pending buys' cycle, pairs its realized P&L, and is idempotent on re-run", () => {
      seedFund(DEFAULT_PAIR, { orders: mergeOrders() });

      const result = converter.mergeToRegime(EXCHANGE, DEFAULT_PAIR);
      assert.equal(result.success, true);
      assert.equal(result.summary.filledOrders, 1);
      assert.equal(result.summary.pendingOrders, 1);

      const ledger = JSON.parse(fs.readFileSync(path.join(fundDir(DEFAULT_PAIR), 'fill-ledger.json'), 'utf8'));
      const doneBuy = ledger.find(f => f.tradeId === 'dca-convert-buy-buy-done');
      const doneSell = ledger.find(f => f.tradeId === 'dca-convert-sell-sell-done');
      const openBuy = ledger.find(f => f.tradeId === 'dca-convert-buy-buy-open');
      assert.ok(doneBuy && doneSell && openBuy, 'all three synthetic fills must be ingested');

      // Cycles are atomic buy(n)->sell(1) (CLAUDE.md) — the pending buy's
      // cycle must differ from the completed pair's cycle.
      assert.equal(doneBuy.cycleId, doneSell.cycleId, 'the completed buy and its sell share one cycle');
      assert.notEqual(openBuy.cycleId, doneBuy.cycleId, "the pending buy must not land in the completed trade's cycle");
      assert.equal(doneBuy.sellOrderId, 'sell-done', 'the filled buy must be linked to its own sell for cycle-pair accounting');

      // computeRealizedFromCyclePairs (the P&L source of truth) must pair the
      // completed trade instead of leaving its sell unpaired.
      delete require.cache[FILL_LEDGER];
      const { createFillLedger } = require('../src/fill-ledger');
      const freshLedger = createFillLedger(EXCHANGE, DEFAULT_PAIR, DEFAULT_PAIR, { quiet: true });
      const pairs = freshLedger.computeRealizedFromCyclePairs();
      assert.equal(pairs.realizedPnL, 12.8);
      assert.equal(pairs.heldOpenBuyCostBasis, 962);
      assert.equal(pairs.unpairedSellQty, 0);

      // Re-run the merge over the SAME still-'filled'/'pending' DCA orders
      // (as if triggered again before/without the DCA-state cleanup step).
      // Every synthetic fill's tradeId already exists in the ledger, so
      // ingestFill reports ingested:false for all of them — filledIngested
      // must reflect that, not double-count the duplicate ingest attempt.
      reseedOrders(DEFAULT_PAIR, mergeOrders());
      const second = converter.mergeToRegime(EXCHANGE, DEFAULT_PAIR);
      assert.equal(second.summary.filledOrders, 0, 'a duplicate merge must not recount already-ingested filled orders');
    });
  });
});
