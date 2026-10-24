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
const { createPlacementReconciler } = require('../src/regime-placement-reconciler');
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


const placementMethods = [
  ['market buy', (adapter) => adapter.placeMarketBuy(product, 10)],
  ['limit buy', (adapter) => adapter.placeLimitBuy(product, 0.01, 100, { clientOrderId: 'submitted-buy-id' })],
  ['limit sell', (adapter) => adapter.placeLimitSell(product, 0.01, 100, { clientOrderId: 'submitted-sell-id' })],
];
const decodedResponse = (value) => ({ ok: true, status: 200,
  json: async () => value, text: async () => JSON.stringify(value) });
const malformedAcknowledgements = {
  coinbase: [null, [], 'invalid', {}, { success: true },
    ...[null, {}, [], 'invalid'].map(success_response => ({ success: true, success_response })),
    ...['', ' ', {}, [], true].map(order_id => ({ success: true, success_response: { order_id } })),
    { success: false, error_response: {} }],
  gemini: [null, [], 'invalid', {}, { result: 'error' },
    ...['', ' ', {}, [], true].map(order_id => ({ order_id })),
    { order_id: 'accepted-order', is_cancelled: 'true' },
    ...['', null, false, -1].map(executed_amount => ({ order_id: 'accepted-order', is_cancelled: true, executed_amount })),
    { order_id: 'accepted-order', is_cancelled: true },
    { order_id: 'accepted-order', is_cancelled: true, executed_amount: 'invalid' }],
  cryptocom: [null, [], 'invalid', {}, { code: null }, { code: 0.5 }, { code: 'invalid' }, { code: 0 },
    ...[null, {}, [], 'invalid'].map(result => ({ code: 0, result })),
    ...['', ' ', {}, [], true].map(order_id => ({ code: 0, result: { order_id } }))],
};
const acceptedAcknowledgement = (c) => ({
  coinbase: { success: true, success_response: { order_id: 'accepted-order' } },
  gemini: { order_id: 'accepted-order', is_cancelled: false },
  cryptocom: { code: 0, result: { order_id: 'accepted-order' } },
})[c.name];
const rejectedAcknowledgement = (c) => ({
  coinbase: { success: false, error_response: { error: 'INVALID_PRICE', message: 'Invalid price' } },
  gemini: { result: 'error', reason: 'InvalidPrice', message: 'Invalid price' },
  cryptocom: { code: 213, message: 'INVALID_PRICE' },
})[c.name];

for (const c of cases) {
  describe(`${c.name} decoded order acknowledgements`, () => {
    for (const [method, submit] of placementMethods) {
      for (const [index, acknowledgement] of malformedAcknowledgements[c.name].entries()) {
        it(`${method} holds malformed acknowledgement ${index} until identified ownership is persisted`, async () => {
          const adapter = adapterFor(c);
          const submitted = [];
          global.fetch = async (_url, options) => {
            submitted.push(c.clientId(options));
            return decodedResponse(acknowledgement);
          };
          let lookupCount = 0;
          let lookupAvailable = false;
          adapter.findOrderByClientOrderId = async (clientId, pair) => {
            lookupCount++;
            assert.equal(clientId, submitted[0], 'reconcile the exact dispatched id');
            assert.equal(pair, product);
            if (!lookupAvailable) throw Error('lookup unavailable');
            return { orderId: 'accepted-order', status: 'OPEN', filledSize: 0 };
          };
          const place = () => placeWithUnknownReconcile(adapter, product, () => submit(adapter), scopeFor(c));
          assert.equal((await place()).pending, true);
          assert.equal(lookupCount, 1);
          const [intent] = stateTracker.loadPlacementIntents(c.name, product);
          assert.equal(intent.status, stateTracker.PLACEMENT_INTENT_STATUS.UNRESOLVED);
          assert.equal(intent.clientOrderId, submitted[0]);
          assert.equal((await place()).blockedByIntentId, intent.id);
          assert.equal(submitted.length, 1, 'unresolved acknowledgement blocks a second POST');

          // A subsequent recovery pass uses the persisted intent, not another
          // placement. Its ownership writes must complete before intent removal.
          lookupAvailable = true;
          const position = {};
          const handedOff = [];
          const reconciler = createPlacementReconciler({
            exchange: c.name, pair: product, productId: product, isDryRun: false,
            getAdapter: () => adapter, getPositionState: () => position,
            getOrderExecutor: () => ({ capabilities: { liveReconciliation: true },
              adoptPlacement: (found) => {
                assert.equal(stateTracker.loadPlacementIntents(c.name, product).length, 1);
                handedOff.push(found.orderId);
                return { success: true };
              } }),
            saveLiveState: () => {
              assert.equal(stateTracker.loadPlacementIntents(c.name, product).length, 1);
              fs.writeFileSync(path.join(root, 'owner.json'), JSON.stringify(position));
            },
            fillLedger: { persist: () => assert.equal(stateTracker.loadPlacementIntents(c.name, product).length, 1) },
            logger: { info() {}, warn() {}, error() {} },
          });
          assert.equal((await reconciler.recoverPlacementIntent(intent.id)).adoptedOrderId, 'accepted-order');
          assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'owner.json'))).pendingEntryOrders[0].orderId, 'accepted-order');
          assert.deepEqual(stateTracker.loadPlacementIntents(c.name, product), []);
          await reconciler.recoverPlacementIntent(intent.id);
          assert.deepEqual(handedOff, ['accepted-order']);
          assert.equal(submitted.length, 1, 'recovery never resends the placement');
        });
      }

      it(`${method} hands valid acknowledgements to the owner before clearing the intent`, async () => {
        const adapter = adapterFor(c);
        global.fetch = async () => decodedResponse(acceptedAcknowledgement(c));
        const owned = [];
        const result = await placeWithUnknownReconcile(adapter, product, () => submit(adapter), scopeFor(c, accepted => {
          assert.equal(stateTracker.loadPlacementIntents(c.name, product).length, 1);
          owned.push(accepted.orderId);
        }));
        assert.ok(result.success);
        assert.deepEqual(owned, ['accepted-order']);
        assert.deepEqual(stateTracker.loadPlacementIntents(c.name, product), []);
      });

      it(`${method} keeps explicit exchange rejections definitive`, async () => {
        const adapter = adapterFor(c);
        global.fetch = async () => decodedResponse(rejectedAcknowledgement(c));
        adapter.findOrderByClientOrderId = async () => assert.fail('a rejection does not need lookup');
        let rejection;
        try {
          rejection = await placeWithUnknownReconcile(adapter, product, () => submit(adapter), scopeFor(c));
          assert.ok(!rejection.success && !rejection.pending);
        } catch (err) {
          assert.equal(c.name, 'cryptocom');
          assert.equal(err.code, 213);
          assert.ok(!err.unknownOutcome);
        }
        assert.deepEqual(stateTracker.loadPlacementIntents(c.name, product), []);
      });
    }
  });
}

for (const [method, submit] of placementMethods) {
  it(`Gemini ${method} preserves confirmed zero-fill cancellations`, async () => {
    const c = cases.find(c => c.name === 'gemini');
    const adapter = adapterFor(c);
    global.fetch = async () => decodedResponse({ order_id: 'cancelled-order', is_cancelled: true, executed_amount: '0' });
    adapter.findOrderByClientOrderId = async () => assert.fail('confirmed cancellation needs no lookup');
    const result = await placeWithUnknownReconcile(adapter, product, () => submit(adapter), scopeFor(c));
    assert.ok(!result.success && !result.pending);
    assert.deepEqual(stateTracker.loadPlacementIntents(c.name, product), []);
  });
}
it('Gemini cancelled partial market execution is owned before its intent clears', async () => {
  const c = cases.find(c => c.name === 'gemini');
  const adapter = adapterFor(c);
  global.fetch = async () => decodedResponse({ order_id: 'partial-order', is_cancelled: true,
    executed_amount: '0.02', avg_execution_price: '100' });
  const owned = [];
  const result = await placeWithUnknownReconcile(adapter, product, () => adapter.placeMarketBuy(product, 10), scopeFor(c, accepted => {
    assert.equal(stateTracker.loadPlacementIntents(c.name, product).length, 1);
    owned.push(accepted.orderId);
  }));
  assert.equal(result.success, true);
  assert.equal(result.filledSize, 0.02);
  assert.deepEqual(owned, ['partial-order']);
  assert.deepEqual(stateTracker.loadPlacementIntents(c.name, product), []);
});
