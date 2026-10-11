// Order POSTs can reach the matching engine before a gateway returns a 5xx.
// Exercise the real adapter -> order manager -> durable intent boundary without
// sending exchange traffic or touching installed fund data.
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const migration = require('../src/migration');
const stateTracker = require('../src/state-tracker');
const { placeWithUnknownReconcile } = require('../src/order-manager');
const { createCoinbaseAdapter } = require('../src/adapters/coinbase/api');
const { createGeminiAdapter } = require('../src/adapters/gemini/api');
const { createCryptocomAdapter } = require('../src/adapters/cryptocom/api');

const cases = [
  { name: 'coinbase', create: createCoinbaseAdapter,
    clientId: (options) => JSON.parse(options.body).client_order_id },
  { name: 'gemini', create: createGeminiAdapter,
    clientId: (options) => JSON.parse(Buffer.from(options.headers['X-GEMINI-PAYLOAD'], 'base64').toString()).client_order_id },
  { name: 'cryptocom', create: createCryptocomAdapter,
    clientId: (options) => JSON.parse(options.body).params.client_oid },
];
const product = 'BTC-USD';
let root;
let keysPath;
let originalFetch;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-placement-server-errors-'));
  keysPath = path.join(root, 'keys.json');
  const { privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  fs.writeFileSync(keysPath, JSON.stringify({
    name: 'organizations/test/apiKeys/test-key', privateKey,
    apiKey: 'test-api-key', apiSecret: 'test-api-secret',
  }));
  mock.method(migration, 'getExchangeDataDir', (exchange) => path.join(root, exchange));
  originalFetch = global.fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
  mock.restoreAll();
  fs.rmSync(root, { recursive: true, force: true });
});

const adapterFor = (c) => {
  const adapter = c.create(keysPath);
  adapter.getProductDetails = async () => ({
    baseIncrement: '0.001', quoteIncrement: '0.01',
    baseMinSize: '0.001', quoteMinSize: '1', price: 100,
  });
  return adapter;
};
const installFailure = (c, status) => {
  const submitted = [];
  const signals = [];
  global.fetch = async (_url, options) => {
    submitted.push(c.clientId(options));
    signals.push(options.signal);
    return { ok: false, status, statusText: 'Upstream failure',
      json: async () => ({}), text: async () => '<html>Upstream failure</html>' };
  };
  return { submitted, signals };
};
const scopeFor = (c, onAccepted) => ({
  intent: { exchange: c.name, pair: product, action: 'entry_bid', side: 'buy', price: 100, size: 0.01 },
  retryDelaysMs: [], onAccepted,
});

for (const c of cases) {
  describe(`${c.name} order-placement server errors`, () => {
    it('classifies server failures as unknown without replaying the order POST', async () => {
      const adapter = adapterFor(c);
      for (const status of [500, 502, 503, 504]) {
        const { submitted, signals } = installFailure(c, status);
        await assert.rejects(() => adapter.placeLimitBuy(product, 0.01, 100), (err) => {
          assert.equal(err.unknownOutcome, true);
          assert.equal(err.status, 'unknown');
          assert.equal(err.clientOrderId, submitted[0]);
          assert.match(err.message, new RegExp(`HTTP ${status}`));
          return true;
        });
        assert.equal(submitted.length, 1);
        if (c.name === 'coinbase') assert.equal(signals[0].aborted, true, 'release the unread error body');
      }
    });

    it('adopts an accepted order after a gateway failure before clearing its intent', async () => {
      const adapter = adapterFor(c);
      const { submitted } = installFailure(c, 502);
      adapter.findOrderByClientOrderId = async (clientId, pair) => {
        assert.equal(clientId, submitted[0]);
        assert.equal(pair, product);
        return { orderId: 'accepted-order', status: 'OPEN' };
      };
      const handedOff = [];
      const result = await placeWithUnknownReconcile(adapter, product,
        () => adapter.placeMarketBuy(product, 10), scopeFor(c, (accepted) => {
          assert.equal(stateTracker.loadPlacementIntents(c.name, product).length, 1);
          handedOff.push(accepted.orderId);
        }));
      assert.equal(result.success, true);
      assert.equal(result.reconciled, true);
      assert.deepEqual(handedOff, ['accepted-order']);
      assert.equal(submitted.length, 1);
      assert.deepEqual(stateTracker.loadPlacementIntents(c.name, product), []);
    });

    it('retains an unresolved intent when lookup fails and blocks another submission', async () => {
      const adapter = adapterFor(c);
      const { submitted } = installFailure(c, 504);
      adapter.findOrderByClientOrderId = async () => { throw Error('lookup unavailable'); };
      const place = () => placeWithUnknownReconcile(adapter, product,
        () => adapter.placeLimitSell(product, 0.01, 100), scopeFor(c));
      const first = await place();
      assert.equal(first.pending, true);
      const [intent] = stateTracker.loadPlacementIntents(c.name, product);
      assert.equal(intent.status, stateTracker.PLACEMENT_INTENT_STATUS.UNRESOLVED);
      assert.equal(intent.clientOrderId, submitted[0]);
      const second = await place();
      assert.equal(second.pending, true);
      assert.equal(second.blockedByIntentId, intent.id);
      assert.equal(submitted.length, 1, 'a later cycle must not place a replacement');
    });

    it('keeps client rejections and non-placement server errors definitive', async () => {
      const adapter = adapterFor(c);
      const { submitted } = installFailure(c, 400);
      await assert.rejects(() => adapter.placeLimitBuy(product, 0.01, 100),
        (err) => err.status === 400 && !err.unknownOutcome);
      assert.equal(submitted.length, 1);
      installFailure(c, 503);
      await assert.rejects(() => adapter.cancelOrder('existing-order'),
        (err) => err.status === 503 && !err.unknownOutcome);
    });
  });
}
