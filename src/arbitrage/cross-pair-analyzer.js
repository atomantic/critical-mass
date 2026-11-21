// @ts-check
/**
 * Same-venue cross-pair analyzer.
 *
 * On one exchange, BTC trades against several quote currencies (USD, USDT,
 * EUR, CAD, ...). Converted into a common home currency through that same
 * exchange's FX/stablecoin markets, every BTC pair should imply the same price.
 * When one pair slips (Kraken BTC/CAD trading ~50% under BTC/USD for hours),
 * a taker can loop home → quote A → BTC → quote B → home on that one venue.
 *
 * This module is pure: it plans which books a venue needs and, given those
 * books, reports per-pair implied prices plus every buy-via-A / sell-via-B
 * loop walked through real depth with taker fees. Monitoring only; nothing
 * here places orders.
 */

const { convertThroughBook, midRate, midPrice, spreadBps, isUsableBook } = require('./book-math');

/**
 * @typedef {import('./book-math').Book} Book
 * @typedef {import('./book-math').Market} Market
 * @typedef {{ market: Market, from: string, to: string }} Leg
 * @typedef {{
 *   asset: string,
 *   home: string,
 *   assetMarkets: Market[],
 *   paths: Record<string, Leg[]>,
 *   requiredSymbols: string[],
 *   unconvertible: string[],
 * }} VenuePlan
 */

const DEFAULT_SIZE_GRID_USD = [100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000];

const pairLabel = (market) => `${market.base}/${market.quote}`;

/**
 * Build the conversion graph and pick, for each quote currency, the shortest
 * on-venue path from the home currency (at most `maxHops` markets). Parity
 * entries add zero-cost 1:1 links (e.g. USDC=USD on Coinbase, GUSD=USD on Gemini).
 *
 * @param {Object} args
 * @param {Market[]} args.markets - every listed market on the venue
 * @param {string} [args.asset='BTC']
 * @param {string} [args.home='USD']
 * @param {string[]} args.quoteCurrencies - fiat/stable currencies to consider
 * @param {Array<[string, string]>} [args.parity] - 1:1 currency pairs
 * @param {number} [args.maxHops=2]
 * @returns {VenuePlan}
 */
const planVenue = ({ markets, asset = 'BTC', home = 'USD', quoteCurrencies, parity = [], maxHops = 2 }) => {
  const quoteSet = new Set([...quoteCurrencies, home]);
  const assetMarkets = markets
    .filter((m) => m.base === asset && quoteSet.has(m.quote))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  /** @type {Market[]} */
  const fxMarkets = [
    ...parity
      .filter(([a, b]) => quoteSet.has(a) && quoteSet.has(b))
      .map(([a, b]) => ({ symbol: `parity:${a}=${b}`, base: a, quote: b, synthetic: true })),
    ...markets
      .filter((m) => m.base !== asset && quoteSet.has(m.base) && quoteSet.has(m.quote))
      .sort((a, b) => a.symbol.localeCompare(b.symbol)),
  ];

  // Breadth-first from home; first path found per currency is the shortest,
  // and synthetic parity links are visited first so they win ties.
  /** @type {Record<string, Leg[]>} */
  const paths = { [home]: [] };
  let frontier = [home];
  for (let hop = 0; hop < maxHops && frontier.length; hop++) {
    const next = [];
    for (const ccy of frontier) {
      for (const market of fxMarkets) {
        const to = market.base === ccy ? market.quote : market.quote === ccy ? market.base : null;
        if (!to || paths[to]) continue;
        paths[to] = [...paths[ccy], { market, from: ccy, to }];
        next.push(to);
      }
    }
    frontier = next;
  }

  const required = new Set();
  const unconvertible = [];
  for (const market of assetMarkets) {
    required.add(market.symbol);
    const path = paths[market.quote];
    if (!path) { unconvertible.push(market.quote); continue; }
    for (const leg of path) if (!leg.market.synthetic) required.add(leg.market.symbol);
  }

  return {
    asset,
    home,
    assetMarkets,
    paths,
    requiredSymbols: [...required].sort(),
    unconvertible: [...new Set(unconvertible)].sort(),
  };
};

/**
 * Reverse a home→X path into X→home.
 * @param {Leg[]} path
 * @returns {Leg[]}
 */
const reversePath = (path) => [...path].reverse().map((leg) => ({ market: leg.market, from: leg.to, to: leg.from }));

/**
 * Run `amount` of legs[0].from through every leg as a taker.
 * @param {number} amount
 * @param {Leg[]} legs
 * @param {Record<string, Book>} books
 * @param {number} feeBps
 * @returns {{ out: number, exhausted: boolean } | null}
 */
const simulateLegs = (amount, legs, books, feeBps) => {
  let current = amount;
  let exhausted = false;
  for (const leg of legs) {
    const result = convertThroughBook(current, leg.from, leg.market, books[leg.market.symbol], leg.market.synthetic ? 0 : feeBps);
    if (!result) return null;
    if (result.exhausted) exhausted = true;
    current = result.out;
  }
  return { out: current, exhausted };
};

const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

/**
 * Analyze one venue snapshot.
 *
 * @param {Object} args
 * @param {string} args.venue
 * @param {VenuePlan} args.plan
 * @param {Record<string, Book>} args.books - by market symbol
 * @param {number} [args.feeBps=0] - taker fee per (non-parity) leg
 * @param {Record<string, number>} [args.externalHomePerUnit] - reference FX: home currency per 1 unit (e.g. { CAD: 0.71 })
 * @param {number} [args.notionalUsd=1000] - the size every route is quoted at
 * @param {number[]} [args.sizeGridUsd] - sizes scanned for the best executable size
 * @param {number} [args.minEdgeBps=0] - net edge a size must clear to count as profitable
 * @returns {Object}
 */
const analyzeVenue = ({
  venue,
  plan,
  books,
  feeBps = 0,
  externalHomePerUnit = {},
  notionalUsd = 1000,
  sizeGridUsd = DEFAULT_SIZE_GRID_USD,
  minEdgeBps = 0,
}) => {
  const { home, asset } = plan;
  const pairs = plan.assetMarkets.map((market) => {
    const book = books[market.symbol];
    const path = plan.paths[market.quote] || null;
    let homePerQuote = null;
    let conversionSource = null;
    if (path) {
      let rate = 1;
      for (const leg of path) {
        // Product of mid rates along home → quote is quote per 1 home.
        const r = midRate(leg.from, leg.market, books[leg.market.symbol]);
        if (!r) { rate = null; break; }
        rate *= r;
      }
      if (rate) {
        homePerQuote = 1 / rate;
        conversionSource = path.length === 0 ? 'home' : path.every((leg) => leg.market.synthetic) ? 'parity' : 'venue';
      }
    }
    const external = market.quote === home ? 1 : externalHomePerUnit[market.quote];
    if (homePerQuote === null && Number.isFinite(external)) {
      homePerQuote = external;
      conversionSource = 'external';
    }
    const mid = midPrice(book);
    const impliedMid = mid && homePerQuote ? mid * homePerQuote : null;
    const externalImplied = mid && Number.isFinite(external) ? mid * external : null;
    return {
      symbol: market.symbol,
      pair: pairLabel(market),
      quote: market.quote,
      bid: isUsableBook(book) ? book.bids[0][0] : null,
      ask: isUsableBook(book) ? book.asks[0][0] : null,
      mid,
      spreadBps: round(spreadBps(book), 1),
      homePerQuote,
      conversionSource,
      conversionPath: path ? path.map((leg) => leg.market.synthetic ? `${leg.market.base}=${leg.market.quote}` : pairLabel(leg.market)) : null,
      impliedMid: round(impliedMid),
      externalImplied: round(externalImplied),
      executable: Boolean(path && isUsableBook(book) && conversionSource !== 'external'),
      /** @type {number|null} */ deviationBps: null,
      /** @type {number|null} */ externalDeviationBps: null,
    };
  });

  // The reference price is the median implied price. With fewer than three
  // priced pairs a median cannot say which one slipped, so anchor to the
  // venue's home-quote pair (BTC/USD) when it is priced.
  const priced = pairs.filter((p) => Number.isFinite(p.impliedMid));
  const homePair = priced.find((p) => p.quote === home);
  const medianImplied = priced.length < 3 && homePair ? homePair.impliedMid : median(priced.map((p) => p.impliedMid));
  for (const pair of pairs) {
    pair.deviationBps = medianImplied && pair.impliedMid ? round(((pair.impliedMid - medianImplied) / medianImplied) * 10_000, 1) : null;
    // The venue's own FX market can be the broken leg; compare with reference FX too.
    pair.externalDeviationBps = medianImplied && pair.externalImplied ? round(((pair.externalImplied - medianImplied) / medianImplied) * 10_000, 1) : null;
  }

  const executable = plan.assetMarkets.filter((m) => pairs.find((p) => p.symbol === m.symbol)?.executable);
  const routes = [];
  for (const buy of executable) {
    for (const sell of executable) {
      if (buy.symbol === sell.symbol) continue;
      const legs = [
        ...plan.paths[buy.quote],
        { market: buy, from: buy.quote, to: asset },
        { market: sell, from: asset, to: sell.quote },
        ...reversePath(plan.paths[sell.quote]),
      ];
      const quote = (size, fee) => {
        const result = simulateLegs(size, legs, books, fee);
        if (!result || !(result.out > 0)) return null;
        return {
          notionalUsd: size,
          netBps: round(((result.out - size) / size) * 10_000, 1),
          profitUsd: round(result.out - size),
          exhausted: result.exhausted,
        };
      };
      const atNotional = quote(notionalUsd, feeBps);
      const gross = quote(notionalUsd, 0);
      if (!atNotional || !gross) continue;

      let best = null;
      let largestProfitableUsd = null;
      for (const size of sizeGridUsd) {
        const q = quote(size, feeBps);
        if (!q || q.exhausted) break;
        if (q.netBps < minEdgeBps || q.profitUsd <= 0) continue;
        largestProfitableUsd = size;
        if (!best || q.profitUsd > best.profitUsd) best = q;
      }

      routes.push({
        id: `${buy.symbol}>${sell.symbol}`,
        buy: buy.symbol,
        sell: sell.symbol,
        buyPair: pairLabel(buy),
        sellPair: pairLabel(sell),
        legs: legs.map((leg) => ({
          market: leg.market.synthetic ? `${leg.market.base}=${leg.market.quote}` : pairLabel(leg.market),
          from: leg.from,
          to: leg.to,
        })),
        grossBps: gross.netBps,
        atNotional,
        best,
        largestProfitableUsd,
      });
    }
  }
  routes.sort((a, b) => (b.best?.profitUsd ?? -Infinity) - (a.best?.profitUsd ?? -Infinity) || b.atNotional.netBps - a.atNotional.netBps);

  return {
    venue,
    home,
    asset,
    medianImplied: round(medianImplied),
    feeBps,
    notionalUsd,
    pairs,
    routes,
    unconvertible: plan.unconvertible,
  };
};

module.exports = { planVenue, analyzeVenue, reversePath, DEFAULT_SIZE_GRID_USD };
