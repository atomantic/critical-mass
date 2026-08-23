// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const migration = require('../src/migration');
const configUtils = require('../src/config-utils');
const correctiveBuys = require('../scripts/place-corrective-buys');
const legacyCorrectiveBuy = require('../scripts/place-corrective-buy-2cb8f4c2');

describe('corrective-buy pending state paths', () => {
  it('isolates reads and writes by exchange and product pair', (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'corrective-buy-paths-'));
    const originalGetExchangeDataDir = migration.getExchangeDataDir;
    migration.getExchangeDataDir = (exchange) => {
      const dir = path.join(tempRoot, exchange);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    t.after(() => {
      migration.getExchangeDataDir = originalGetExchangeDataDir;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    correctiveBuys.savePending([{ buyOrderId: 'btc-order' }], 'coinbase', 'BTC-USDC');
    correctiveBuys.savePending([{ buyOrderId: 'eth-order' }], 'coinbase', 'ETH-USDC');

    const btcPath = correctiveBuys.getPendingReadPath('coinbase', 'BTC-USDC');
    const ethPath = correctiveBuys.getPendingReadPath('coinbase', 'ETH-USDC');
    assert.equal(btcPath, path.join(tempRoot, 'coinbase', 'BTC-USDC', 'pending-corrective-buys.json'));
    assert.equal(ethPath, path.join(tempRoot, 'coinbase', 'ETH-USDC', 'pending-corrective-buys.json'));
    assert.deepEqual(correctiveBuys.loadPending('coinbase', 'BTC-USDC'), [{ buyOrderId: 'btc-order' }]);
    assert.deepEqual(correctiveBuys.loadPending('coinbase', 'ETH-USDC'), [{ buyOrderId: 'eth-order' }]);
  });

  it('keeps the deprecated audit script on the same pair-specific read/write contract', (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'corrective-buy-audit-paths-'));
    const originalGetExchangeDataDir = migration.getExchangeDataDir;
    migration.getExchangeDataDir = (exchange) => path.join(tempRoot, exchange);
    t.after(() => {
      migration.getExchangeDataDir = originalGetExchangeDataDir;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    assert.equal(
      legacyCorrectiveBuy.getPendingReadPath('coinbase', 'BTC-USDC'),
      path.join(tempRoot, 'coinbase', 'BTC-USDC', 'pending-corrective-buys.json')
    );
    assert.equal(
      legacyCorrectiveBuy.getPendingWritePath('coinbase', 'BTC-USDC'),
      path.join(tempRoot, 'coinbase', 'BTC-USDC', 'pending-corrective-buys.json')
    );
    assert.equal(fs.existsSync(path.join(tempRoot, 'coinbase', 'BTC-USDC')), true);
  });

  it('annotates the explicit BTC-USDC ledger when the configured default is a different fund', async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'corrective-buy-ledger-path-'));
    const originalGetExchangeDataDir = migration.getExchangeDataDir;
    const originalGetDefaultPair = configUtils.getDefaultPair;
    migration.getExchangeDataDir = (exchange) => {
      const dir = path.join(tempRoot, exchange);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    configUtils.getDefaultPair = () => 'ETH-USDC';
    t.after(() => {
      migration.getExchangeDataDir = originalGetExchangeDataDir;
      configUtils.getDefaultPair = originalGetDefaultPair;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    correctiveBuys.savePending([{
      buyOrderId: 'corrective-buy-1',
      sellOrderId: 'orphan-sell-1',
      filled: true,
      annotated: false,
    }], 'coinbase', 'BTC-USDC');

    await correctiveBuys.annotateFills({
      getOrderFills: async () => [{
        tradeId: 'corrective-trade-1',
        price: 50_000,
        size: 0.01,
        totalCommission: 0.25,
        rebate: 0,
        netFee: 0.25,
        liquidityIndicator: 'MAKER',
        tradeTime: new Date(1_750_000_000_000).toISOString(),
      }],
    });

    const explicitLedger = path.join(tempRoot, 'coinbase', 'BTC-USDC', 'fill-ledger.json');
    const defaultLedger = path.join(tempRoot, 'coinbase', 'ETH-USDC', 'fill-ledger.json');
    assert.equal(fs.existsSync(explicitLedger), true, 'annotation must persist to the requested pair');
    assert.equal(fs.existsSync(defaultLedger), false, 'configured default fund must remain untouched');

    const [fill] = JSON.parse(fs.readFileSync(explicitLedger, 'utf8'));
    assert.equal(fill.orderId, 'corrective-buy-1');
    assert.equal(fill.sellOrderId, 'orphan-sell-1');
    assert.equal(fill.correctiveBuy, true);
  });
});
