// @ts-check
// Real adapter -> manual importer -> disk-backed ledger, with synthetic HTTP
// responses and disposable storage only. Historical ledger rows are not repaired.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCryptocomAdapter } = require('../src/adapters/cryptocom/api');
const migration = require('../src/migration');
const ledgerModule = require.resolve('../src/fill-ledger');
const originalGetExchangeDataDir = migration.getExchangeDataDir;
const PAIR = 'BTC-USDT';

let tempDir;
let originalFetch;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cryptocom-fill-fees-'));
  originalFetch = global.fetch;
  migration.getExchangeDataDir = (exchange) => {
    const dir = path.join(tempDir, exchange);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  delete require.cache[ledgerModule];
});
afterEach(() => {
  global.fetch = originalFetch;
  migration.getExchangeDataDir = originalGetExchangeDataDir;
  delete require.cache[ledgerModule];
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('Crypto.com quote fee ingestion (#1800)', () => {
  for (const { name, fields, expected } of [
    { name: 'signed charge', fields: { fees: '-0.25', fee: '9' }, expected: 0.25 },
    { name: 'signed rebate', fields: { fees: '0.15' }, expected: -0.15 },
    { name: 'explicit string zero', fields: { fees: '0', fee: '9' }, expected: 0 },
    { name: 'explicit numeric zero', fields: { fees: 0, fee: '9' }, expected: 0 },
    { name: 'legacy charge', fields: { fee: '0.3' }, expected: 0.3 },
    { name: 'legacy rebate', fields: { fee: '-0.1' }, expected: -0.1 },
  ]) {
    it(`preserves ${name} across both readers, import, reload and replay`, async () => {
      const now = Date.now();
      const raw = {
        trade_id: 'trade-1', order_id: 'buy-1', instrument_name: 'BTC_USDT',
        side: 'BUY', traded_price: '100', traded_quantity: '1',
        create_time: now - 1000, fee_instrument_name: 'USDT', ...fields,
      };
      global.fetch = async (_url, options) => {
        const request = JSON.parse(options.body);
        let result;
        if (request.method === 'private/get-order-detail') {
          result = { order_info: {
            order_id: 'buy-1', instrument_name: 'BTC_USDT', side: 'BUY',
            create_time: now - 2000, update_time: now - 1000, cumulative_quantity: '1',
          } };
        } else {
          assert.equal(request.method, 'private/get-trades');
          result = { data: [raw] };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, result }) };
      };
      const keysPath = path.join(tempDir, 'keys.json');
      fs.writeFileSync(keysPath, JSON.stringify({ apiKey: 'fixture', apiSecret: 'fixture' }));
      const adapter = createCryptocomAdapter(keysPath);
      const fills = await adapter.getOrderFills('buy-1');
      const reconciled = await adapter.getReconciliationFills(PAIR, now - 3000);
      assert.equal(fills.length, 1);
      assert.equal(reconciled.length, 1);
      // +0 and -0 are equivalent economic fees.
      assert.equal(fills[0].netFee + 0, expected);
      assert.equal(fills[0].commission + 0, expected);
      assert.equal(reconciled[0].fee + 0, expected);
      assert.equal(reconciled[0].feeCurrency, 'USDT');

      const { createFillLedger } = require('../src/fill-ledger');
      const { createManualTradeStore } = require('../src/manual-trades');
      const { createManualTradeImporter } = require('../src/manual-trade-import');
      const ledger = createFillLedger('cryptocom', PAIR, PAIR);
      ledger.load();
      const store = createManualTradeStore('cryptocom', PAIR);
      store.load();
      const importer = createManualTradeImporter({
        exchange: 'cryptocom', pair: PAIR, adapter, fillLedger: ledger, store,
        fundConfig: { productId: PAIR },
        logger: { info() {}, warn() {}, error() {} },
      });
      assert.equal((await importer.importBuy({ buyOrderId: 'buy-1', createBody: false })).success, true);
      assert.equal((await importer.importBuy({ buyOrderId: 'buy-1', createBody: false })).success, true);
      const reloaded = createFillLedger('cryptocom', PAIR, PAIR);
      reloaded.load();
      const rows = reloaded.getAllFills();
      assert.equal(rows.length, 1, 'replay does not duplicate execution quantity or fees');
      assert.equal(rows[0].size, 1);
      assert.equal(rows[0].quoteAmount, 100);
      assert.equal(rows[0].netFee, expected);
      assert.equal(store.getAll().length, 1, 'replay keeps one manual trade');
    });
  }
});
