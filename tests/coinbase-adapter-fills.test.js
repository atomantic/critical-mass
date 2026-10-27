// @ts-check
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createCoinbaseAdapter } = require('../src/adapters/coinbase/api');

// ---------------------------------------------------------------------------
// Test harness
//
// getOrderFills() signs a JWT with an EC private key before calling fetch, so
// the test writes a freshly-generated prime256v1 key to a temp keys file and
// mocks global.fetch to return canned /historical/fills responses.
// ---------------------------------------------------------------------------

let keysPath;
let originalFetch;

/**
 * Install a global.fetch mock that records each request and returns a canned
 * response. Accepts either:
 *   - a handler `(url, calls) => responseBody` so tests can drive cursor-based
 *     pagination off the query string, or
 *   - an array of raw fills, which is wrapped as `{ fills }` (single page).
 * @param {((url: URL, calls: URL[]) => any) | any[]} handlerOrFills
 * @returns {{calls: URL[]}}
 */
const installFetchMock = (handlerOrFills) => {
  const calls = [];
  const handler = typeof handlerOrFills === 'function'
    ? handlerOrFills
    : () => ({ fills: handlerOrFills });
  global.fetch = async (url) => {
    const parsed = new URL(url);
    calls.push(parsed);
    const body = handler(parsed, calls);
    return { ok: true, status: 200, statusText: 'OK', json: async () => body };
  };
  return { calls };
};

const makeFill = (tradeId, size, overrides = {}) => ({
  trade_id: String(tradeId),
  order_id: 'ORDER-1',
  product_id: 'BTC-USDC',
  side: 'BUY',
  price: '50000.00',
  size: String(size),
  size_in_quote: false,
  commission: '0.10',
  trade_time: '2026-06-24T00:00:00Z',
  liquidity_indicator: 'MAKER',
  ...overrides,
});

// Exercise adapter pagination through the real importer and its disk-backed
// stores: ledger dedup alone must not hide inflated body/recovery quantities.
const withManualImporter = async (adapter, options, check) => {
  const migration = require('../src/migration');
  const originalDataDir = migration.getExchangeDataDir;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coinbase-fill-import-'));
  const ledgerModule = require.resolve('../src/fill-ledger');
  try {
    migration.getExchangeDataDir = () => directory;
    delete require.cache[ledgerModule];
    const ledger = require('../src/fill-ledger').createFillLedger('coinbase', 'BTC-USDC', 'BTC-USDC', { quiet: true });
    const store = require('../src/manual-trades').createManualTradeStore('coinbase', 'BTC-USDC');
    const importer = require('../src/manual-trade-import').createManualTradeImporter({
      exchange: 'coinbase', pair: 'BTC-USDC', adapter, fillLedger: ledger, store,
      fundConfig: { productId: 'BTC-USDC' }, ...options,
    });
    await check({ importer, ledger, store });
  } finally {
    migration.getExchangeDataDir = originalDataDir;
    delete require.cache[ledgerModule];
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

beforeEach(() => {
  // Generate a real EC P-256 key so the ES256 JWT signing in auth.js succeeds.
  const { privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  keysPath = path.join(os.tmpdir(), `coinbase-test-keys-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(keysPath, JSON.stringify({ name: 'organizations/test/apiKeys/test-key', privateKey }));
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  if (keysPath && fs.existsSync(keysPath)) fs.unlinkSync(keysPath);
});

describe('coinbase getOrderFills pagination', () => {
  it('accumulates fills across every cursor page', async () => {
    const adapter = createCoinbaseAdapter(keysPath);

    // Three pages of 2 fills each; the final page signals end via has_next: false.
    const pages = {
      '': { fills: [makeFill(1, 0.1), makeFill(2, 0.2)], cursor: 'CUR1', has_next: true },
      'CUR1': { fills: [makeFill(3, 0.3), makeFill(4, 0.4)], cursor: 'CUR2', has_next: true },
      // Final page echoes a non-empty cursor but has_next: false — must still terminate.
      'CUR2': { fills: [makeFill(5, 0.5), makeFill(6, 0.6)], cursor: 'CUR3', has_next: false },
    };

    const { calls } = installFetchMock((url) => {
      const cursor = url.searchParams.get('cursor') || '';
      assert.equal(url.searchParams.get('order_id'), 'ORDER-1');
      assert.ok(url.searchParams.get('limit'), 'limit param must be sent');
      return pages[cursor];
    });

    const fills = await adapter.getOrderFills('ORDER-1');

    assert.equal(calls.length, 3, 'should request all three pages');
    assert.equal(fills.length, 6, 'should accumulate fills from every page');
    assert.deepEqual(fills.map(f => f.tradeId), ['1', '2', '3', '4', '5', '6']);
    // totalSize-style sum must reflect every page, not just the first.
    const totalSize = fills.reduce((sum, f) => sum + f.size, 0);
    assert.ok(Math.abs(totalSize - 2.1) < 1e-9, `expected 2.1, got ${totalSize}`);
  });

  it('returns a single page unchanged when there is no further cursor', async () => {
    const adapter = createCoinbaseAdapter(keysPath);

    const { calls } = installFetchMock(() => ({
      fills: [makeFill(1, 0.1)],
      cursor: '',
    }));

    const fills = await adapter.getOrderFills('ORDER-1');

    assert.equal(calls.length, 1, 'should stop after one page');
    assert.equal(fills.length, 1);
    assert.equal(fills[0].size, 0.1);
  });

  it('rejects with incompleteFills when the API repeats the same cursor and leaves manual import clean', async () => {
    const adapter = createCoinbaseAdapter(keysPath);

    // A stuck endpoint keeps returning the same non-empty cursor with has_next: true.
    const { calls } = installFetchMock((url) => ({
      fills: [makeFill(url.searchParams.get('cursor') ? 2 : 1, 0.1)],
      cursor: 'STUCK',
      has_next: true,
    }));

    await assert.rejects(
      async () => adapter.getOrderFills('ORDER-1'),
      (err) => {
        assert.equal(err.incompleteFills, true);
        assert.match(err.message, /repeated cursor STUCK/);
        return true;
      }
    );

    // First page (no cursor) → STUCK, second page (cursor=STUCK) repeats STUCK → rejects.
    assert.equal(calls.length, 2, 'should reject once the cursor repeats');

    // Real-importer assertion: failed scan publishes no rows, trade record or body
    await withManualImporter(adapter, {
      injectBody: async () => assert.fail('incomplete scan must not publish body'),
    }, async ({ importer, ledger, store }) => {
      const result = await importer.importBuy({ buyOrderId: 'ORDER-1' });
      assert.equal(result.success, false);
      assert.match(result.error, /repeated cursor STUCK/);
      assert.equal(ledger.getFillCount(), 0, 'no ledger rows persisted');
      assert.equal(store.getAll().length, 0, 'no trade record saved');
    });
  });

  it('rejects with incompleteFills on an A/B cursor cycle without returning partial rows', async () => {
    const adapter = createCoinbaseAdapter(keysPath);
    const cursors = { '': 'CUR_A', 'CUR_A': 'CUR_B', 'CUR_B': 'CUR_A' };
    const { calls } = installFetchMock((url) => {
      const cursor = url.searchParams.get('cursor') || '';
      return {
        fills: [makeFill(calls.length, 0.1)],
        cursor: cursors[cursor] || 'CUR_A',
        has_next: true,
      };
    });

    await assert.rejects(
      async () => adapter.getOrderFills('ORDER-1'),
      (err) => {
        assert.equal(err.incompleteFills, true);
        assert.match(err.message, /repeated cursor CUR_A/);
        return true;
      }
    );
    assert.equal(calls.length, 3, 'should reject on the third page when CUR_A repeats');
  });

  const malformedPages = [
    ['missing fills', () => ({ has_next: false })],
    ['non-array fills', () => ({ fills: 'invalid', has_next: false })],
    ['invalid fill element', () => ({ fills: [null], has_next: false })],
    ['invalid has_next flag', () => ({ fills: [makeFill(1, 0.1)], has_next: 'false' })],
    ['null response', () => null],
  ];
  for (const [name, badPage] of malformedPages) {
    it(`rejects with incompleteFills on a malformed page (${name})`, async () => {
      const adapter = createCoinbaseAdapter(keysPath);
      installFetchMock(() => badPage());
      await assert.rejects(
        async () => adapter.getOrderFills('ORDER-1'),
        (err) => {
          assert.equal(err.incompleteFills, true);
          assert.match(err.message, /malformed fills page/);
          return true;
        }
      );
    });
  }

  it('rejects with incompleteFills when pagination exceeds page budget', async () => {
    const adapter = createCoinbaseAdapter(keysPath);
    const { calls } = installFetchMock((_url, calls) => ({
      fills: [makeFill(calls.length, 0.01)],
      cursor: `CUR_${calls.length}`,
      has_next: true,
    }));

    await assert.rejects(
      async () => adapter.getOrderFills('ORDER-1'),
      (err) => {
        assert.equal(err.incompleteFills, true);
        assert.match(err.message, /exceeded 64-page budget/);
        return true;
      }
    );
    assert.equal(calls.length, 64, 'must attempt exactly 64 pages before rejecting');
  });

  const unfindableContinuations = [
    ['missing cursor', () => ({ fills: [makeFill(1, 0.1)], has_next: true })],
    ['blank cursor', () => ({ fills: [makeFill(1, 0.1)], cursor: '   ', has_next: true })],
    ['empty cursor', () => ({ fills: [makeFill(1, 0.1)], cursor: '', has_next: true })],
    ['non-string cursor', () => ({ fills: [makeFill(1, 0.1)], cursor: 12345, has_next: true })],
  ];
  for (const [name, badContinuation] of unfindableContinuations) {
    it(`rejects with incompleteFills when has_next is true without usable continuation (${name})`, async () => {
      const adapter = createCoinbaseAdapter(keysPath);
      installFetchMock(() => badContinuation());
      await assert.rejects(
        async () => adapter.getOrderFills('ORDER-1'),
        (err) => {
          assert.equal(err.incompleteFills, true);
          assert.match(err.message, /missing continuation cursor/);
          return true;
        }
      );
    });
  }

  it('terminates cleanly on has_next: false even when a cursor is echoed', async () => {
    const adapter = createCoinbaseAdapter(keysPath);
    const { calls } = installFetchMock(() => ({
      fills: [makeFill(1, 0.1)],
      cursor: 'ECHOED_CURSOR',
      has_next: false,
    }));
    const fills = await adapter.getOrderFills('ORDER-1');
    assert.equal(calls.length, 1);
    assert.equal(fills.length, 1);
    assert.equal(fills[0].size, 0.1);
  });

  it('an incomplete manual paired import leaves ledger and store untouched and remains retryable', async () => {
    const adapter = createCoinbaseAdapter(keysPath);
    let attempts = 0;
    installFetchMock((url) => {
      const orderId = url.searchParams.get('order_id');
      if (orderId === 'BUY-1') {
        if (attempts === 0) {
          // Incomplete scan on first attempt (repeated cursor)
          return { fills: [makeFill(1, 0.01, { order_id: 'BUY-1' })], cursor: 'STUCK', has_next: true };
        }
        // Successful scan on retry
        return { fills: [makeFill(1, 0.01, { order_id: 'BUY-1' })], has_next: false };
      }
      if (orderId === 'SELL-1') {
        return { fills: [makeFill(2, 0.01, { order_id: 'SELL-1', side: 'SELL' })], has_next: false };
      }
      return { fills: [], has_next: false };
    });

    await withManualImporter(adapter, {}, async ({ importer, ledger, store }) => {
      // First attempt fails on buy leg
      const failResult = await importer.importPair({ buyOrderId: 'BUY-1', sellOrderId: 'SELL-1' });
      assert.equal(failResult.success, false);
      assert.match(failResult.error, /repeated cursor STUCK/);
      assert.equal(ledger.getFillCount(), 0, 'ledger must remain empty after failed buy leg');
      assert.equal(store.getAll().length, 0, 'store must remain empty after failed buy leg');

      // Retry after exchange endpoint recovers
      attempts = 1;
      const retryResult = await importer.importPair({ buyOrderId: 'BUY-1', sellOrderId: 'SELL-1' });
      assert.equal(retryResult.success, true);
      assert.equal(ledger.getFillCount(), 2, 'both legs ingested on clean retry');
      assert.equal(store.getAll().length, 1, 'trade record created on clean retry');
    });
  });

  it('counts overlapping page executions once when persisting an imported buy body', async () => {
    const adapter = createCoinbaseAdapter(keysPath);
    const first = makeFill(1, 0.004);
    const second = makeFill(2, 0.006);
    installFetchMock((url) => url.searchParams.has('cursor')
      ? { fills: [first, second, second], has_next: false }
      : { fills: [first], cursor: 'NEXT', has_next: true });
    const bodies = [];
    await withManualImporter(adapter, {
      injectBody: async (body) => {
        bodies.push(body);
        return { success: true, bodyId: body.id };
      },
    }, async ({ importer, ledger }) => {
      const result = await importer.importBuy({ buyOrderId: 'ORDER-1' });
      assert.equal(result.success, true);
      assert.equal(ledger.getRecordedSizeForOrder('ORDER-1'), 0.01);
      assert.equal(result.trade.buySize, 0.01);
      assert.equal(result.trade.buyPrice, 50000);
      assert.deepEqual(result.trade.buyFillTradeIds, ['1', '2']);
      assert.equal(bodies.length, 1);
      assert.equal(bodies[0].assetQty, 0.01);
      assert.ok(Math.abs(bodies[0].costBasis - 500.2) < 1e-8);
      const fundDir = require('../src/migration').resolveFundDataDir('coinbase', 'BTC-USDC');
      const saved = JSON.parse(fs.readFileSync(path.join(fundDir, 'manual-trades.json'), 'utf8'));
      assert.equal(saved.trades[0].buySize, 0.01);
      const retry = await importer.importBuy({ buyOrderId: 'ORDER-1' });
      assert.equal(retry.success, true);
      assert.equal(bodies.length, 1, 'retry must not create more inventory');
    });
  });

  it('sizes a recovery buy from unique sell executions when a page is redelivered', async () => {
    const adapter = createCoinbaseAdapter(keysPath);
    const sell = makeFill(1, 0.01, { side: 'SELL' });
    installFetchMock((url) => url.searchParams.has('cursor')
      ? { fills: [sell], has_next: false }
      : { fills: [sell], cursor: 'PAGE2', has_next: true });
    const buys = [];
    adapter.placeLimitBuy = async (_product, size) => {
      buys.push(size);
      return { success: true, orderId: 'RECOVERY' };
    };
    await withManualImporter(adapter, {}, async ({ importer, ledger, store }) => {
      const result = await importer.importSell({ sellOrderId: 'ORDER-1', recoveryBuyPrice: 49000 });
      assert.equal(result.success, true);
      assert.equal(ledger.getRecordedSizeForOrder('ORDER-1'), 0.01);
      assert.equal(result.trade.sellSize, 0.01);
      assert.deepEqual(buys, [0.01]);
      assert.equal(store.getAll()[0].recoveryAttempts[0].size, 0.01);
    });
  });

  it('keeps distinct executions with identical economics and leaves malformed IDs visible to validation', async () => {
    const adapter = createCoinbaseAdapter(keysPath);
    installFetchMock([makeFill(1, 0.01), makeFill(2, 0.01),
      makeFill(3, 0.01, { trade_id: undefined }), makeFill(4, 0.01, { trade_id: '' }),
      makeFill(5, 0.01, { trade_id: 1 })]);
    const fills = await adapter.getOrderFills('ORDER-1');
    assert.deepEqual(fills.map(fill => fill.tradeId), ['1', '2', undefined, '', 1]);
  });

  it('rejects conflicting duplicate economics before a manual import mutates any accounting', async () => {
    for (const conflicting of [{ size: 'NaN' }, { size: '0.02' }, { commission: '1.00' }]) {
      const adapter = createCoinbaseAdapter(keysPath);
      installFetchMock([makeFill(1, 0.01), makeFill(1, 0.01, conflicting)]);
      await withManualImporter(adapter, {
        injectBody: async () => assert.fail('conflicting data must not create inventory'),
      }, async ({ importer, ledger, store }) => {
        const result = await importer.importBuy({ buyOrderId: 'ORDER-1' });
        assert.equal(result.success, false);
        assert.match(result.error, /Conflicting Coinbase fill data/);
        assert.equal(ledger.getFillCount(), 0);
        assert.equal(store.getAll().length, 0);
      });
    }
  });

  it('deduplicates equivalent normalized executions despite different quote and commission representations', async () => {
    const adapter = createCoinbaseAdapter(keysPath);
    installFetchMock([makeFill(1, 0.01), makeFill(1, 500, {
      size_in_quote: true,
      commission_detail_total: { total_commission: '0.10', rebate: '0' },
    })]);
    const fills = await adapter.getOrderFills('ORDER-1');
    assert.equal(fills.length, 1);
    assert.equal(fills[0].size, 0.01);
    assert.equal(fills[0].sizeInQuote, 500);
    assert.equal(fills[0].netFee, 0.1);
  });
});

describe('coinbase getOrderFills size_in_quote handling (issue #148)', () => {
  it('converts quote-denominated size to base when size_in_quote is true', async () => {
    const adapter = createCoinbaseAdapter(keysPath);
    installFetchMock([
      {
        trade_id: 't1',
        order_id: 'o1',
        product_id: 'BTC-USDC',
        side: 'BUY',
        price: '50000',
        size: '500',        // 500 USDC notional
        size_in_quote: true, // boolean flag -> size is in quote currency
        commission: '2.5',
        trade_time: '2026-06-24T00:00:00Z',
        liquidity_indicator: 'TAKER',
      },
    ]);

    const [fill] = await adapter.getOrderFills('o1');

    // 500 USDC / 50000 = 0.01 BTC base
    assert.equal(fill.size, 0.01);
    // quote notional preserved
    assert.equal(fill.sizeInQuote, 500);
    // never NaN (the old parseFloat(true) bug)
    assert.ok(!Number.isNaN(fill.size));
    assert.ok(!Number.isNaN(fill.sizeInQuote));
  });

  it('treats size as base currency when size_in_quote is false', async () => {
    const adapter = createCoinbaseAdapter(keysPath);
    installFetchMock([
      {
        trade_id: 't2',
        order_id: 'o2',
        product_id: 'BTC-USDC',
        side: 'SELL',
        price: '50000',
        size: '0.02',        // already base currency
        size_in_quote: false,
        commission: '1.0',
        trade_time: '2026-06-24T01:00:00Z',
        liquidity_indicator: 'MAKER',
      },
    ]);

    const [fill] = await adapter.getOrderFills('o2');

    assert.equal(fill.size, 0.02);
    // quote notional = price * base
    assert.equal(fill.sizeInQuote, 1000);
  });

  it('handles the string "true" form of size_in_quote', async () => {
    const adapter = createCoinbaseAdapter(keysPath);
    installFetchMock([
      {
        trade_id: 't3',
        order_id: 'o3',
        product_id: 'ETH-USDC',
        side: 'BUY',
        price: '2000',
        size: '400',
        size_in_quote: 'true',
        trade_time: '2026-06-24T02:00:00Z',
      },
    ]);

    const [fill] = await adapter.getOrderFills('o3');

    assert.equal(fill.size, 0.2); // 400 / 2000
    assert.equal(fill.sizeInQuote, 400);
  });
});
