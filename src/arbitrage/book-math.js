// @ts-check
/**
 * Order-book math for the cross-pair arbitrage monitor.
 *
 * A normalized book is `{ bids: [[price, size], ...] (best first, descending),
 * asks: [[price, size], ...] (best first, ascending) }` where price is quote
 * per one unit of base. Everything here is pure: no I/O, no clocks.
 */

/**
 * @typedef {[number, number]} BookLevel
 * @typedef {{ bids: BookLevel[], asks: BookLevel[] }} Book
 * @typedef {{ symbol: string, base: string, quote: string, synthetic?: boolean }} Market
 */

/**
 * Normalize raw `[price, size]`-like levels: numeric, positive, sorted best first.
 * @param {Array<any>} levels
 * @param {'bids'|'asks'} side
 * @param {(level: any) => [any, any]} [pick] - extract [price, size] from a raw level
 * @returns {BookLevel[]}
 */
const normalizeLevels = (levels, side, pick = (level) => [level[0], level[1]]) => {
  if (!Array.isArray(levels)) return [];
  const out = [];
  for (const level of levels) {
    let price;
    let size;
    try {
      [price, size] = pick(level);
    } catch {
      continue;
    }
    const p = Number(price);
    const s = Number(size);
    if (Number.isFinite(p) && Number.isFinite(s) && p > 0 && s > 0) out.push(/** @type {BookLevel} */ ([p, s]));
  }
  out.sort((a, b) => side === 'bids' ? b[0] - a[0] : a[0] - b[0]);
  return out;
};

/**
 * A usable book has both sides and is not crossed.
 * @param {Book|null|undefined} book
 * @returns {boolean}
 */
const isUsableBook = (book) => Boolean(book
  && Array.isArray(book.bids) && Array.isArray(book.asks)
  && book.bids.length > 0 && book.asks.length > 0
  && book.bids[0][0] < book.asks[0][0]);

/**
 * Mid price (quote per base), or null for an unusable book.
 * @param {Book|null|undefined} book
 * @returns {number|null}
 */
const midPrice = (book) => isUsableBook(book) ? (book.bids[0][0] + book.asks[0][0]) / 2 : null;

/**
 * Spread in basis points of mid, or null.
 * @param {Book|null|undefined} book
 * @returns {number|null}
 */
const spreadBps = (book) => {
  const mid = midPrice(book);
  return mid ? ((book.asks[0][0] - book.bids[0][0]) / mid) * 10_000 : null;
};

/**
 * Convert `amountIn` of `from` through one market by walking its book as a
 * taker. Selling base hits bids; buying base with quote lifts asks.
 * A synthetic market (1:1 parity such as USDC/USD on Coinbase) converts at
 * exactly 1 with unlimited depth and no fee.
 *
 * @param {number} amountIn - amount of `from` to spend
 * @param {string} from - currency being spent (market.base or market.quote)
 * @param {Market} market
 * @param {Book|null|undefined} book
 * @param {number} [feeBps=0] - taker fee taken from the output
 * @returns {{ out: number, spent: number, exhausted: boolean } | null} null when the market cannot convert `from`
 */
const convertThroughBook = (amountIn, from, market, book, feeBps = 0) => {
  if (!(amountIn > 0)) return { out: 0, spent: 0, exhausted: false };
  if (market.synthetic) {
    if (from !== market.base && from !== market.quote) return null;
    return { out: amountIn, spent: amountIn, exhausted: false };
  }
  if (!isUsableBook(book)) return null;
  const feeFactor = 1 - feeBps / 10_000;
  let remaining = amountIn;
  let out = 0;
  if (from === market.base) {
    // Sell base into bids: receive price * size of quote.
    for (const [price, size] of book.bids) {
      const take = Math.min(remaining, size);
      out += take * price;
      remaining -= take;
      if (remaining <= 0) break;
    }
  } else if (from === market.quote) {
    // Buy base from asks: each level costs price * size of quote.
    for (const [price, size] of book.asks) {
      const levelCost = price * size;
      if (levelCost >= remaining) {
        out += remaining / price;
        remaining = 0;
        break;
      }
      out += size;
      remaining -= levelCost;
    }
  } else {
    return null;
  }
  const exhausted = remaining > amountIn * 1e-9;
  return { out: out * feeFactor, spent: amountIn - Math.max(0, remaining), exhausted };
};

/**
 * Mid-price conversion rate for one unit of `from` into the other side of the
 * market (no depth, no fees). Used for the indicative implied-price view.
 * @param {string} from
 * @param {Market} market
 * @param {Book|null|undefined} book
 * @returns {number|null}
 */
const midRate = (from, market, book) => {
  if (market.synthetic) return 1;
  const mid = midPrice(book);
  if (!mid) return null;
  if (from === market.base) return mid;
  if (from === market.quote) return 1 / mid;
  return null;
};

module.exports = { normalizeLevels, isUsableBook, midPrice, spreadBps, convertThroughBook, midRate };
