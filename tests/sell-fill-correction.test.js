// @ts-check
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const migration = require('../src/migration');
const configUtils = require('../src/config-utils');
const state = require('../src/state-tracker');
const { createClosedTrades } = require('../src/closed-trades');

const EXCHANGE = 'sell-correction-test';
const PAIR = 'BTC-USDC';
const originalGetExchangeDataDir = migration.getExchangeDataDir;
const originalGetRegimeConfig = configUtils.getRegimeConfig;
const originalUpdateRegimeConfig = configUtils.updateRegimeConfig;
const originalRename = fs.renameSync;
let root;
let config;

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7,
  `expected ${expected}, got ${actual}`);

const createLedger = () => {
  delete require.cache[require.resolve('../src/fill-ledger')];
  return require('../src/fill-ledger').createFillLedger(EXCHANGE, PAIR, PAIR);
};

const correctedFill = (tradeId, price, netFee) => ({
  tradeId,
  orderId: 'sell',
  side: 'sell',
  size: 0.01,
  price,
  fee: netFee,
  netFee,
});

const position = () => state.loadRegimeState(EXCHANGE, PAIR).position;

const audit = () => {
  const closed = createClosedTrades(EXCHANGE, PAIR);
  closed.load();
  return closed.getAll().find(trade => trade.sellOrderId === 'sell');
};

const seedBookedSell = () => {
  const ledger = createLedger();
  const cycleId = ledger.startNewCycle();
  ledger.ingestFill({ tradeId: 'buy-fill', orderId: 'buy', side: 'buy', size: 0.02,
    price: 1748, netFee: 0 });
  ledger.annotateFillsByOrderId('buy', { isBodyOwned: true, bodyId: 'body', sellOrderId: 'sell' });
  ledger.recordBuyConsumption('buy', 'sell', 0.02);
  const synthetic = ledger.ingestFill({ tradeId: 'synthetic-sell', orderId: 'sell', side: 'sell',
    size: 0.02, price: 2000, fee: 0.04, netFee: 0.04,
    syntheticCoverage: { orderId: 'sell', cumulativeQuantity: 0.02, cumulativeQuote: 40, cumulativeFees: 0.04 },
  }).fill;
  ledger.commitSellBooking('sell', { isBodyOwned: true, bodyId: 'body', bodyPnl: 5,
    bodyCostBasis: 34.96, bodyBtcQty: 0.02, bodyHoldbackAsset: 0 },
  { soldSize: 0.02, bookedTradeIds: [synthetic.tradeId] });
  ledger.claimCapitalCredit('sell', 0.02);
  ledger.persist();

  state.saveRegimeState({ activeCycleId: cycleId, realizedPnL: 5, realizedAssetPnL: 0,
    heldAssetCostBasis: 0, celestialBodies: [], appliedSellCorrections: [] }, {}, EXCHANGE, null, null, PAIR);
  const closed = createClosedTrades(EXCHANGE, PAIR);
  closed.record({ sellOrderId: 'sell', timestamp: 1, qtySold: 0.02, sellProceeds: 39.96,
    sellFees: 0.04, costBasis: 34.96, pnl: 5, buyAvgPrice: 1748, holdbackAsset: 0,
    buyOrderIds: ['buy'], source: 'live' });
  return ledger;
};

describe('terminal sell economic reconciliation (#837)', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sell-correction-'));
    migration.getExchangeDataDir = exchange => path.join(root, exchange);
    config = { ...originalGetRegimeConfig(EXCHANGE, PAIR), maxUsdcDeployed: 1000 };
    configUtils.getRegimeConfig = () => ({ ...config });
    configUtils.updateRegimeConfig = (_exchange, _pair, updates) => { config = { ...config, ...updates }; };
  });

  afterEach(() => {
    fs.renameSync = originalRename;
    migration.getExchangeDataDir = originalGetExchangeDataDir;
    configUtils.getRegimeConfig = originalGetRegimeConfig;
    configUtils.updateRegimeConfig = originalUpdateRegimeConfig;
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it('applies rising then falling proceeds and fee corrections once across reloads', () => {
    let ledger = seedBookedSell();
    ledger.ingestFill(correctedFill('actual-a', 2050, 0.02));
    near(ledger.getSellBooking('sell').bodyPnl, 5.5);
    near(position().realizedPnL, 5.5);
    near(config.maxUsdcDeployed, 1000.5);
    near(audit().sellProceeds, 40.46);

    ledger = createLedger();
    ledger.ingestFill(correctedFill('actual-b', 1950, 0.03));
    ledger.resumeSellCorrections();
    near(ledger.getSellBooking('sell').bodyPnl, 4.99);
    near(ledger.getSellBooking('sell').bodyCostBasis, 34.96);
    near(ledger.getSellBooking('sell').bodyBtcQty, 0.02);
    near(ledger.getSellBooking('sell').bodyHoldbackAsset, 0);
    near(position().realizedPnL, 4.99);
    near(config.maxUsdcDeployed, 999.99);
    near(audit().sellProceeds, 39.95);
    near(audit().sellFees, 0.05);
    near(audit().pnl, 4.99);
    assert.deepEqual(ledger.getBuyOrderConsumption('buy').consumedBy, { sell: 0.02 });
    assert.equal(ledger.getFillsForOrder('sell').reduce((sum, row) => sum + row.size, 0), 0.02);
    near(ledger.getFillsForOrder('sell').reduce((sum, row) => sum + row.quoteAmount, 0), 40);
    near(ledger.getFillsForOrder('sell').reduce((sum, row) => sum + row.netFee, 0), 0.05);
    assert.ok(ledger.getFillsForOrder('sell').every(row => row.capitalCreditedSize === 0.02));
    assert.equal(ledger.ingestFill(correctedFill('actual-a', 2050, 0.02)).ingested, false);
    assert.equal(ledger.ingestFill(correctedFill('actual-b', 1950, 0.03)).ingested, false);
    near(config.maxUsdcDeployed, 999.99);
    near(audit().pnl, 4.99);
  });

  it('leaves a real excess tranche unbooked and its capital-credit watermark available', () => {
    const ledger = seedBookedSell();
    const result = ledger.ingestFill({ tradeId: 'crossing-sell', orderId: 'sell', side: 'sell',
      size: 0.03, price: 2100, fee: 0.06, netFee: 0.06 });
    assert.equal(result.newQuantity, 0.01);
    assert.deepEqual(result.bookableFills.map(fill => fill.tradeId), ['crossing-sell']);
    near(ledger.getSellBooking('sell').bodyPnl, 7);
    near(config.maxUsdcDeployed, 1002);
    const rows = ledger.getFillsForOrder('sell');
    const covered = rows.find(row => row.tradeId === 'synthetic-sell');
    const excess = rows.find(row => row.tradeId === 'crossing-sell');
    near(covered.quoteAmount, 42);
    assert.equal(covered.capitalCreditedSize, 0.02);
    assert.equal(excess.capitalCredited, undefined);
    assert.equal(excess.bodyBooked, undefined);
    assert.deepEqual(ledger.getUnbookedSellFills('sell').map(fill => fill.tradeId), ['crossing-sell']);

    assert.equal(ledger.claimCapitalCredit('sell', 0.03), true,
      'the new quantity remains eligible for its own capital credit');
    assert.ok(ledger.getFillsForOrder('sell').every(row => row.capitalCreditedSize === 0.03));
  });

  it('reconciles a manual sell import through the persisted accounting handler', async () => {
    const ledger = seedBookedSell();
    const { createManualTradeStore } = require('../src/manual-trades');
    const { createManualTradeImporter } = require('../src/manual-trade-import');
    const store = createManualTradeStore(EXCHANGE, PAIR);
    const importer = createManualTradeImporter({ exchange: EXCHANGE, pair: PAIR, store,
      fillLedger: ledger,
      adapter: { getOrderFills: async () => [{ tradeId: 'manual-actual', orderId: 'sell', side: 'sell',
        size: 0.02, price: 2100, commission: 0.06, totalCommission: 0.06, netFee: 0.06,
        tradeTime: new Date().toISOString() }] },
    });

    const result = await importer.importSell({ sellOrderId: 'sell' });
    assert.equal(result.success, true);
    near(ledger.getSellBooking('sell').bodyPnl, 6.98);
    near(position().realizedPnL, 6.98);
    near(config.maxUsdcDeployed, 1001.98);
    near(audit().pnl, 6.98);
    assert.equal(ledger.getRecordedSizeForOrder('sell'), 0.02);
  });

  for (const target of ['regime-state', 'config', 'closed-trades', 'journal-status']) {
    it(`resumes exactly once after a ${target} publication failure`, () => {
      let ledger = seedBookedSell();
      const actual = { tradeId: `actual-${target}`, orderId: 'sell', side: 'sell',
        size: 0.02, price: 2100, fee: 0.06, netFee: 0.06 };
      let injected = false;
      if (target === 'config') {
        configUtils.updateRegimeConfig = (_exchange, _pair, updates) => {
          if (!injected && updates.appliedSellCorrections) {
            injected = true;
            throw new Error('injected config fault');
          }
          config = { ...config, ...updates };
        };
      } else {
        let ledgerWrites = 0;
        fs.renameSync = (from, to) => {
          const dest = String(to);
          const fail = target === 'regime-state' ? dest.endsWith('regime-state.json')
            : target === 'closed-trades' ? dest.endsWith('closed-trades.json')
              : dest.endsWith('fill-ledger.json') && ++ledgerWrites === 2;
          if (!injected && fail) {
            injected = true;
            throw new Error(`injected ${target} fault`);
          }
          return originalRename(from, to);
        };
      }

      assert.throws(() => ledger.ingestFill(actual), new RegExp(`injected ${target} fault`));
      assert.equal(injected, true);
      fs.renameSync = originalRename;
      configUtils.updateRegimeConfig = (_exchange, _pair, updates) => { config = { ...config, ...updates }; };

      ledger = createLedger();
      assert.equal(ledger.ingestFill(actual).ingested, false,
        'the caller retry resumes the durable correction before duplicate-ID handling');
      near(ledger.getSellBooking('sell').bodyPnl, 6.98);
      near(position().realizedPnL, 6.98);
      near(config.maxUsdcDeployed, 1001.98);
      near(audit().pnl, 6.98);
      assert.equal(ledger.getFillsForOrder('sell').filter(row =>
        row.sellEconomicCorrections?.some(correction => correction.id === actual.tradeId && correction.status === 'applied')).length, 1);
    });
  }
});
