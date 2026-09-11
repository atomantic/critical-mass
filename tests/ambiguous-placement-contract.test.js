// @ts-check
/**
 * Ambiguous order-placement contract (issue #427).
 *
 * A placement whose transport fails, or whose response cannot be decoded, has
 * an UNKNOWN outcome: the exchange may already hold the order. Treating that as
 * an ordinary failure is what produces an untracked live order and, on the next
 * engine tick, a second placement against the same capital.
 *
 * Every adapter must therefore:
 *   1. throw status:'unknown' / unknownOutcome:true carrying the client order
 *      id it actually sent (market AND limit placements),
 *   2. expose findOrderByClientOrderId so order-manager can resolve it,
 *   3. return null from that lookup ONLY on a positive "no such order" signal —
 *      an inconclusive lookup must throw, never read as absent,
 *   4. leave non-placement endpoints and definitive rejections unchanged.
 *
 * All exchange traffic is stubbed; no live API is contacted.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createGeminiAdapter } = require('../src/adapters/gemini/api');
const { createCryptocomAdapter } = require('../src/adapters/cryptocom/api');
const { placeWithUnknownReconcile } = require('../src/order-manager');

let keysPath;
let originalFetch;

beforeEach(() => {
  keysPath = path.join(os.tmpdir(), `ambiguous-placement-keys-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(keysPath, JSON.stringify({ apiKey: 'test-api-key-123', apiSecret: 'test-api-secret-456' }));
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  fs.rmSync(keysPath, { force: true });
});

const stubProduct = (adapter) => {
  adapter.getProductDetails = async () => ({
    baseIncrement: '0.001',
    quoteIncrement: '0.01',
    baseMinSize: '0.01',
    quoteMinSize: '1',
    price: 100,
  });
};

const textResponse = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  statusText: ok ? 'OK' : 'Error',
  text: async () => body,
  json: async () => JSON.parse(body),
});

/**
 * Per-exchange bindings for the shared contract below. Each case knows how to
 * recognize its placement request and how to shape a lookup response, so the
 * expectations themselves stay identical across exchanges.
 */
const cases = [
  {
    name: 'gemini',
    pair: 'BTCUSD',
    create: createGeminiAdapter,
    isPlacement: (url) => String(url).includes('/v1/order/new'),
    isLookup: (url) => String(url).includes('/v1/order/status'),
    // Gemini signs the payload into a base64 header rather than the body.
    sentClientOrderId: (options) =>
      JSON.parse(Buffer.from(options.headers['X-GEMINI-PAYLOAD'], 'base64').toString()).client_order_id,
    lookupClientOrderId: (options) =>
      JSON.parse(Buffer.from(options.headers['X-GEMINI-PAYLOAD'], 'base64').toString()).client_order_id,
    liveOrder: (clientOrderId) => textResponse(JSON.stringify({
      order_id: '55501', client_order_id: clientOrderId, symbol: 'btcusd', side: 'buy',
      is_live: true, is_cancelled: false, executed_amount: '0', original_amount: '0.019',
      avg_execution_price: '0', timestampms: 1700000000000,
    })),
    notFound: () => textResponse(JSON.stringify({ result: 'error', reason: 'OrderNotFound' }), { ok: false, status: 404 }),
    inconclusive: () => textResponse(JSON.stringify({ result: 'error', reason: 'RateLimit' }), { ok: false, status: 429 }),
    undecodable: () => textResponse('<html>504 gateway timeout</html>'),
    nonPlacement: (adapter) => adapter.cancelOrder('55501'),
    expectedOrderId: '55501',
  },
  {
    name: 'cryptocom',
    pair: 'BTC-USD',
    create: createCryptocomAdapter,
    isPlacement: (url, options) => JSON.parse(options.body).method === 'private/create-order',
    isLookup: (url, options) => JSON.parse(options.body).method === 'private/get-order-detail',
    sentClientOrderId: (options) => JSON.parse(options.body).params.client_oid,
    lookupClientOrderId: (options) => JSON.parse(options.body).params.client_oid,
    liveOrder: (clientOrderId) => textResponse(JSON.stringify({
      code: 0,
      result: { order_info: {
        order_id: '55501', client_oid: clientOrderId, instrument_name: 'BTC_USD', side: 'BUY',
        status: 'ACTIVE', quantity: '0.019', cumulative_quantity: '0', avg_price: '0',
        create_time: 1700000000000,
      } },
    })),
    notFound: () => textResponse(JSON.stringify({ code: 40401, message: 'NOT_FOUND' })),
    inconclusive: () => textResponse(JSON.stringify({ code: 42901, message: 'TOO_MANY_REQUESTS' })),
    undecodable: () => textResponse('<html>504 gateway timeout</html>'),
    nonPlacement: (adapter) => adapter.cancelOrder('55501'),
    expectedOrderId: '55501',
  },
];

for (const c of cases) {
  describe(`${c.name} ambiguous placement contract (issue #427)`, () => {
    /** Capture what the adapter sent, and drive the response per request. */
    const install = (respond) => {
      const placements = [];
      const lookups = [];
      global.fetch = async (url, options = {}) => {
        if (c.isPlacement(url, options)) {
          placements.push(c.sentClientOrderId(options));
          return respond('placement', placements.length);
        }
        if (c.isLookup(url, options)) {
          lookups.push(c.lookupClientOrderId(options));
          return respond('lookup', lookups.length, lookups[lookups.length - 1]);
        }
        throw new Error(`unexpected request ${url}`);
      };
      return { placements, lookups };
    };

    it('surfaces a lost market-buy response as an unknown outcome carrying the client order id', async () => {
      const adapter = c.create(keysPath);
      stubProduct(adapter);
      const { placements } = install(() => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); });

      await assert.rejects(
        () => adapter.placeMarketBuy(c.pair, 100),
        (err) => {
          assert.equal(err.status, 'unknown');
          assert.equal(err.unknownOutcome, true);
          assert.equal(err.clientOrderId, placements[0]);
          assert.match(err.message, /reconcile by client_order_id/);
          return true;
        }
      );
      // Exactly one submission — never a blind retry that could double-place.
      assert.equal(placements.length, 1);
    });

    it('surfaces a lost limit-buy response as an unknown outcome carrying the client order id', async () => {
      const adapter = c.create(keysPath);
      stubProduct(adapter);
      const { placements } = install(() => { throw new Error('ETIMEDOUT'); });

      await assert.rejects(
        () => adapter.placeLimitBuy(c.pair, 0.019, 100),
        (err) => err.status === 'unknown' && err.unknownOutcome === true && err.clientOrderId === placements[0]
      );
      assert.equal(placements.length, 1);
    });

    it('treats an undecodable 200 on a placement as unknown, not as a clean failure', async () => {
      const adapter = c.create(keysPath);
      stubProduct(adapter);
      const { placements } = install(() => c.undecodable());

      await assert.rejects(
        () => adapter.placeLimitSell(c.pair, 0.019, 100),
        (err) => {
          assert.equal(err.status, 'unknown');
          assert.equal(err.unknownOutcome, true);
          assert.equal(err.clientOrderId, placements[0]);
          assert.match(err.message, /undecodable response/);
          return true;
        }
      );
    });

    it('leaves a non-placement request as an ordinary network error', async () => {
      const adapter = c.create(keysPath);
      global.fetch = async () => { throw new Error('socket hang up'); };

      await assert.rejects(
        () => c.nonPlacement(adapter),
        (err) => err.status === 'network' && err.unknownOutcome === undefined
      );
    });

    it('findOrderByClientOrderId adopts the accepted order the exchange really holds', async () => {
      const adapter = c.create(keysPath);
      install((kind, _n, clientOrderId) => {
        assert.equal(kind, 'lookup');
        return c.liveOrder(clientOrderId);
      });

      const found = await adapter.findOrderByClientOrderId('coid-427', c.pair);
      assert.equal(found.orderId, c.expectedOrderId);
      assert.equal(found.status, 'OPEN');
    });

    it('findOrderByClientOrderId returns null only on a positive not-found signal', async () => {
      const adapter = c.create(keysPath);
      install(() => c.notFound());

      assert.equal(await adapter.findOrderByClientOrderId('coid-427', c.pair), null);
      // No id to look up is likewise "nothing to reconcile", with no API call.
      global.fetch = async () => { throw new Error('must not fetch'); };
      assert.equal(await adapter.findOrderByClientOrderId('', c.pair), null);
    });

    it('findOrderByClientOrderId throws on an inconclusive lookup instead of reporting absent', async () => {
      const adapter = c.create(keysPath);
      install(() => c.inconclusive());

      await assert.rejects(() => adapter.findOrderByClientOrderId('coid-427', c.pair));
    });

    for (const value of [null, false, 0, '']) {
      it(`keeps a placement pending when a successful lookup has invalid payload ${JSON.stringify(value)}`, async () => {
        const adapter = c.create(keysPath);
        stubProduct(adapter);
        const { placements } = install((kind) => {
          if (kind === 'placement') throw new Error('socket hang up');
          return textResponse(JSON.stringify(c.name === 'cryptocom' ? { code: 0, result: value } : value));
        });
        const result = await placeWithUnknownReconcile(adapter, c.pair,
          () => adapter.placeLimitBuy(c.pair, 0.019, 100), []);
        assert.equal(result.pending, true);
        assert.equal(result.success, false);
        assert.equal(placements.length, 1);
      });
    }

    it('reconciles an ambiguous placement into the live order without placing a second one', async () => {
      const adapter = c.create(keysPath);
      stubProduct(adapter);
      const { placements, lookups } = install((kind, attempt, clientOrderId) => {
        if (kind === 'placement') throw new Error('socket hang up');
        assert.equal(clientOrderId, placements[0], 'lookup must use the id we actually sent');
        return c.liveOrder(clientOrderId);
      });

      const result = await placeWithUnknownReconcile(
        adapter,
        c.pair,
        () => adapter.placeLimitBuy(c.pair, 0.019, 100),
        []
      );

      assert.equal(result.success, true);
      assert.equal(result.reconciled, true);
      assert.equal(result.orderId, c.expectedOrderId);
      assert.equal(placements.length, 1, 'the order must never be submitted twice');
      assert.equal(lookups.length, 1);
    });

    it('reports a clean failure only when the exchange positively never got the order', async () => {
      const adapter = c.create(keysPath);
      stubProduct(adapter);
      const { placements } = install((kind) => {
        if (kind === 'placement') throw new Error('socket hang up');
        return c.notFound();
      });

      const result = await placeWithUnknownReconcile(
        adapter,
        c.pair,
        () => adapter.placeLimitBuy(c.pair, 0.019, 100),
        []
      );

      assert.equal(result.success, false);
      assert.equal(placements.length, 1);
    });

    it('keeps an unresolved placement unresolved when the reconcile lookup itself fails', async () => {
      const adapter = c.create(keysPath);
      stubProduct(adapter);
      const { placements } = install((kind) => {
        if (kind === 'placement') throw new Error('socket hang up');
        return c.inconclusive();
      });

      // An inconclusive lookup must NOT collapse into a plain success:false —
      // that is the shape callers read as "safe to re-place". It comes back
      // marked `pending`, and (when the placement is fund-scoped) leaves a
      // durable intent that refuses the next placement outright (#472).
      const result = await placeWithUnknownReconcile(
        adapter,
        c.pair,
        () => adapter.placeLimitBuy(c.pair, 0.019, 100),
        []
      );
      assert.equal(result.success, false);
      assert.equal(result.pending, true, 'an inconclusive reconcile stays pending, never a clean failure');
      assert.equal(placements.length, 1);
    });
  });
}

describe('cryptocom definitive rejection stays an ordinary failure (issue #427)', () => {
  it('does not convert a non-zero response code into an unknown outcome', async () => {
    const adapter = createCryptocomAdapter(keysPath);
    stubProduct(adapter);
    global.fetch = async () => textResponse(JSON.stringify({ code: 213, message: 'INVALID_PRICE' }));

    await assert.rejects(
      () => adapter.placeLimitBuy('BTC-USD', 0.019, 100),
      (err) => err.unknownOutcome === undefined && /INVALID_PRICE/.test(err.message)
    );
  });
});
