// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { convertThroughBook, normalizeLevels, isUsableBook } = require('../src/arbitrage/book-math');
const { planVenue, analyzeVenue } = require('../src/arbitrage/cross-pair-analyzer');
const { splitConcatenatedSymbol, normalizeCurrency } = require('../src/arbitrage/venue-sources');

const QUOTES = ['USD', 'USDT', 'USDC', 'CAD', 'EUR'];

const market = (symbol, base, quote) => ({ symbol, base, quote });
const deep = (price, spread, size = 1000) => ({
  bids: [[price * (1 - spread), size]],
  asks: [[price * (1 + spread), size]],
});

// A Kraken-shaped venue: BTC trades against USD, USDT and CAD; USD/CAD and
// USDT/USD convert between the quotes.
const KRAKEN_MARKETS = [
  market('XXBTZUSD', 'BTC', 'USD'),
  market('XXBTZCAD', 'BTC', 'CAD'),
  market('XBTUSDT', 'BTC', 'USDT'),
  market('ZUSDZCAD', 'USD', 'CAD'),
  market('USDTZUSD', 'USDT', 'USD'),
  market('XETHZUSD', 'ETH', 'USD'),
];

const healthyBooks = () => ({
  XXBTZUSD: { bids: [[95_990, 2], [95_980, 5]], asks: [[96_010, 2], [96_020, 5]] },
  XXBTZCAD: { bids: [[134_380, 2], [134_370, 5]], asks: [[134_420, 2], [134_430, 5]] },
  XBTUSDT: { bids: [[95_985, 2], [95_975, 5]], asks: [[96_015, 2], [96_025, 5]] },
  ZUSDZCAD: deep(1.4, 0.0002, 10_000_000),
  USDTZUSD: deep(1, 0.0001, 10_000_000),
});

describe('book math', () => {
  it('normalizes, filters and sorts levels best-first', () => {
    assert.deepEqual(normalizeLevels([['10', '1'], ['12', '2'], ['bad', '1'], ['11', '0']], 'bids'), [[12, 2], [10, 1]]);
    assert.deepEqual(normalizeLevels([{ price: '12', amount: '1' }, { price: '10', amount: '3' }], 'asks', (l) => [l.price, l.amount]), [[10, 3], [12, 1]]);
  });

  it('rejects crossed and one-sided books', () => {
    assert.equal(isUsableBook({ bids: [[11, 1]], asks: [[10, 1]] }), false);
    assert.equal(isUsableBook({ bids: [], asks: [[10, 1]] }), false);
    assert.equal(isUsableBook({ bids: [[9, 1]], asks: [[10, 1]] }), true);
  });

  it('walks asks when buying base and bids when selling it, with fees', () => {
    const m = market('BTC-USD', 'BTC', 'USD');
    const book = { bids: [[100, 1], [90, 1]], asks: [[110, 1], [120, 1]] };
    // 170 USD buys 1 BTC at 110 then 0.5 at 120.
    assert.deepEqual(convertThroughBook(170, 'USD', m, book), { out: 1.5, spent: 170, exhausted: false });
    // Selling 1.5 BTC: 1 at 100 + 0.5 at 90 = 145, less 100 bps.
    const sold = convertThroughBook(1.5, 'BTC', m, book, 100);
    assert.equal(sold.out, 145 * 0.99);
    // More than the book holds is flagged as exhausted.
    assert.equal(convertThroughBook(5, 'BTC', m, book).exhausted, true);
  });
});

describe('planVenue', () => {
  it('finds BTC pairs and the shortest on-venue conversion to home', () => {
    const plan = planVenue({ markets: KRAKEN_MARKETS, quoteCurrencies: QUOTES });
    assert.deepEqual(plan.assetMarkets.map((m) => m.symbol), ['XBTUSDT', 'XXBTZCAD', 'XXBTZUSD']);
    assert.deepEqual(plan.paths.CAD.map((l) => l.market.symbol), ['ZUSDZCAD']);
    assert.deepEqual(plan.requiredSymbols, ['USDTZUSD', 'XBTUSDT', 'XXBTZCAD', 'XXBTZUSD', 'ZUSDZCAD']);
    assert.deepEqual(plan.unconvertible, []);
  });

  it('uses parity links and two-hop paths, and reports quotes it cannot convert', () => {
    const plan = planVenue({
      markets: [market('BTC-USD', 'BTC', 'USD'), market('BTC-USDC', 'BTC', 'USDC'), market('BTC-EUR', 'BTC', 'EUR'), market('USDC-EUR', 'USDC', 'EUR'), market('BTC-CAD', 'BTC', 'CAD')],
      quoteCurrencies: QUOTES,
      parity: [['USDC', 'USD']],
    });
    assert.deepEqual(plan.paths.USDC.map((l) => l.market.symbol), ['parity:USDC=USD']);
    assert.deepEqual(plan.paths.EUR.map((l) => l.market.symbol), ['parity:USDC=USD', 'USDC-EUR']);
    assert.deepEqual(plan.unconvertible, ['CAD']);
    assert.ok(!plan.requiredSymbols.includes('parity:USDC=USD'));
  });
});

describe('analyzeVenue', () => {
  const plan = planVenue({ markets: KRAKEN_MARKETS, quoteCurrencies: QUOTES });

  it('finds no net-positive loop on a healthy venue', () => {
    const analysis = analyzeVenue({ venue: 'kraken', plan, books: healthyBooks(), feeBps: 40, notionalUsd: 1000 });
    assert.ok(analysis.pairs.every((p) => Math.abs(p.deviationBps) < 10), JSON.stringify(analysis.pairs));
    assert.ok(analysis.routes.length > 0);
    assert.ok(analysis.routes.every((r) => r.best === null && r.atNotional.netBps < 0));
  });

  it('flags a BTC/CAD book trading ~50% under and sizes the loop by real depth', () => {
    const books = healthyBooks();
    // 0.5 BTC offered at half price, then the normal book behind it.
    books.XXBTZCAD = { bids: [[67_100, 0.5], [67_000, 1]], asks: [[67_200, 0.5], [134_500, 5]] };
    const analysis = analyzeVenue({ venue: 'kraken', plan, books, feeBps: 40, notionalUsd: 1000, minEdgeBps: 50 });

    const cad = analysis.pairs.find((p) => p.symbol === 'XXBTZCAD');
    assert.equal(cad.conversionSource, 'venue');
    assert.deepEqual(cad.conversionPath, ['USD/CAD']);
    assert.ok(cad.deviationBps < -4000, `deviation ${cad.deviationBps}`);

    const top = analysis.routes[0];
    assert.equal(top.buyPair, 'BTC/CAD');
    assert.deepEqual(top.legs.map((l) => `${l.from}>${l.to}`), ['USD>CAD', 'CAD>BTC', 'BTC>USD']);
    assert.ok(top.atNotional.netBps > 9000, `net ${top.atNotional.netBps}`);
    // Only ~0.5 BTC (≈ $24k) is cheap; the best size is where that depth runs out.
    assert.equal(top.best.notionalUsd, 25_000);
    assert.ok(top.best.profitUsd > 20_000 && top.best.profitUsd < 25_000, `profit ${top.best.profitUsd}`);
    assert.ok(top.largestProfitableUsd >= top.best.notionalUsd);
  });

  it('falls back to reference FX for a quote with no on-venue conversion, marked non-executable', () => {
    const markets = [market('BTC-USD', 'BTC', 'USD'), market('BTC-CAD', 'BTC', 'CAD')];
    const fxPlan = planVenue({ markets, quoteCurrencies: QUOTES });
    const analysis = analyzeVenue({
      venue: 'x',
      plan: fxPlan,
      books: { 'BTC-USD': deep(96_000, 0.0001, 5), 'BTC-CAD': deep(67_200, 0.0001, 5) },
      externalHomePerUnit: { CAD: 1 / 1.4 },
    });
    const cad = analysis.pairs.find((p) => p.quote === 'CAD');
    assert.equal(cad.conversionSource, 'external');
    assert.equal(cad.executable, false);
    assert.ok(Math.abs(cad.impliedMid - 48_000) < 10);
    assert.equal(analysis.routes.length, 0);
  });
});

describe('venue symbol helpers', () => {
  it('splits Gemini-style concatenated symbols', () => {
    const known = new Set(['BTC', 'USD', 'GUSD', 'USDT', 'EUR']);
    assert.deepEqual(splitConcatenatedSymbol('btcgusd', known), { base: 'BTC', quote: 'GUSD' });
    assert.deepEqual(splitConcatenatedSymbol('btcusdt', known), { base: 'BTC', quote: 'USDT' });
    assert.deepEqual(splitConcatenatedSymbol('gusdusd', known), { base: 'GUSD', quote: 'USD' });
    assert.equal(splitConcatenatedSymbol('btcgusdperp', known), null);
  });

  it('maps Kraken legacy asset codes', () => {
    assert.equal(normalizeCurrency('XBT'), 'BTC');
    assert.equal(normalizeCurrency('ZCAD'), 'CAD');
    assert.equal(normalizeCurrency('usdt'), 'USDT');
  });
});
