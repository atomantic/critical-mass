// @ts-check
/**
 * Public (unauthenticated) market-data sources for the arbitrage monitor.
 *
 * Each source lists the venue's spot markets and fetches one order book,
 * normalized to `{ bids, asks }` (see book-math.js). No API keys are read and
 * no private endpoint is touched, so a monitored venue does not need to be a
 * configured fund exchange (Kraken is monitor-only).
 */

const { withAbortTimeout } = require('../adapters/http');
const { normalizeLevels } = require('./book-math');

/** @typedef {import('./book-math').Market} Market */
/** @typedef {import('./book-math').Book} Book */

const USER_AGENT = 'critical-mass-arbitrage-monitor';
const FETCH_TIMEOUT_MS = 10_000;

/**
 * GET a JSON document from a fixed public host.
 * @param {string} url
 * @returns {Promise<any>}
 */
const defaultFetchJson = (url) => withAbortTimeout(async (signal) => {
  const res = await fetch(url, { signal, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) {
    const error = /** @type {any} */ (new Error(`HTTP ${res.status} from ${new URL(url).host}`));
    error.status = res.status;
    throw error;
  }
  return res.json();
}, { timeoutMs: FETCH_TIMEOUT_MS });

/** Kraken's legacy asset codes. */
const KRAKEN_ASSET_ALIASES = { XBT: 'BTC', XXBT: 'BTC', XDG: 'DOGE', ZUSD: 'USD', ZEUR: 'EUR', ZCAD: 'CAD', ZGBP: 'GBP', ZJPY: 'JPY', ZAUD: 'AUD', ZCHF: 'CHF' };
const normalizeCurrency = (code) => {
  const upper = String(code || '').toUpperCase();
  return KRAKEN_ASSET_ALIASES[upper] || upper;
};

/**
 * Split a concatenated symbol like `btcgusd` into known currencies.
 * @param {string} symbol
 * @param {Set<string>} known - upper-case currency codes
 * @returns {{ base: string, quote: string } | null}
 */
const splitConcatenatedSymbol = (symbol, known) => {
  const upper = symbol.toUpperCase();
  for (let i = 2; i <= upper.length - 2; i++) {
    const base = upper.slice(0, i);
    const quote = upper.slice(i);
    if (known.has(base) && known.has(quote)) return { base, quote };
  }
  return null;
};

/**
 * @param {Object} [deps]
 * @param {(url: string) => Promise<any>} [deps.fetchJson]
 */
const createCoinbaseSource = ({ fetchJson = defaultFetchJson } = {}) => ({
  id: 'coinbase',
  label: 'Coinbase',
  minRequestSpacingMs: 120,
  // Coinbase converts USDC and USD 1:1 without a fee.
  parity: /** @type {Array<[string, string]>} */ ([['USDC', 'USD']]),
  /** @returns {Promise<Market[]>} */
  listMarkets: async () => {
    const products = await fetchJson('https://api.exchange.coinbase.com/products');
    if (!Array.isArray(products)) throw new Error('Coinbase products: unexpected response');
    return products
      .filter((p) => p && p.status === 'online' && !p.trading_disabled && !p.cancel_only && !p.auction_mode)
      .map((p) => ({ symbol: String(p.id), base: normalizeCurrency(p.base_currency), quote: normalizeCurrency(p.quote_currency) }));
  },
  /** @returns {Promise<Book>} */
  fetchBook: async (symbol, depth) => {
    const book = await fetchJson(`https://api.exchange.coinbase.com/products/${encodeURIComponent(symbol)}/book?level=2`);
    return {
      bids: normalizeLevels(book?.bids, 'bids').slice(0, depth),
      asks: normalizeLevels(book?.asks, 'asks').slice(0, depth),
    };
  },
});

/**
 * @param {Object} [deps]
 * @param {(url: string) => Promise<any>} [deps.fetchJson]
 * @param {string[]} [deps.knownCurrencies] - used to split Gemini's concatenated symbols
 */
const createGeminiSource = ({ fetchJson = defaultFetchJson, knownCurrencies = [] } = {}) => ({
  id: 'gemini',
  label: 'Gemini',
  minRequestSpacingMs: 600,
  // Gemini redeems GUSD for USD 1:1.
  parity: /** @type {Array<[string, string]>} */ ([['GUSD', 'USD']]),
  /** @returns {Promise<Market[]>} */
  listMarkets: async () => {
    const symbols = await fetchJson('https://api.gemini.com/v1/symbols');
    if (!Array.isArray(symbols)) throw new Error('Gemini symbols: unexpected response');
    const known = new Set(['BTC', ...knownCurrencies.map((c) => c.toUpperCase())]);
    return symbols.flatMap((symbol) => {
      const split = typeof symbol === 'string' ? splitConcatenatedSymbol(symbol, known) : null;
      return split ? [{ symbol, ...split }] : [];
    });
  },
  /** @returns {Promise<Book>} */
  fetchBook: async (symbol, depth) => {
    const book = await fetchJson(`https://api.gemini.com/v1/book/${encodeURIComponent(symbol)}?limit_bids=${depth}&limit_asks=${depth}`);
    /** @type {(level: any) => [any, any]} */
    const pick = (level) => [level?.price, level?.amount];
    return { bids: normalizeLevels(book?.bids, 'bids', pick), asks: normalizeLevels(book?.asks, 'asks', pick) };
  },
});

/**
 * @param {Object} [deps]
 * @param {(url: string) => Promise<any>} [deps.fetchJson]
 */
const createCryptocomSource = ({ fetchJson = defaultFetchJson } = {}) => ({
  id: 'cryptocom',
  label: 'Crypto.com Exchange',
  minRequestSpacingMs: 100,
  parity: /** @type {Array<[string, string]>} */ ([]),
  /** @returns {Promise<Market[]>} */
  listMarkets: async () => {
    const json = await fetchJson('https://api.crypto.com/exchange/v1/public/get-instruments');
    const data = json?.result?.data;
    if (!Array.isArray(data)) throw new Error('Crypto.com instruments: unexpected response');
    return data
      .filter((i) => i && i.inst_type === 'CCY_PAIR' && i.tradable !== false)
      .map((i) => ({ symbol: String(i.symbol), base: normalizeCurrency(i.base_ccy), quote: normalizeCurrency(i.quote_ccy) }));
  },
  /** @returns {Promise<Book>} */
  fetchBook: async (symbol, depth) => {
    // The public book endpoint caps depth at 50.
    const json = await fetchJson(`https://api.crypto.com/exchange/v1/public/get-book?instrument_name=${encodeURIComponent(symbol)}&depth=${Math.min(depth, 50)}`);
    const book = json?.result?.data?.[0];
    return { bids: normalizeLevels(book?.bids, 'bids'), asks: normalizeLevels(book?.asks, 'asks') };
  },
});

/**
 * Kraken is not a fund exchange in critical-mass; it is monitored from public
 * data only because that is where the BTC/CAD dislocation was seen.
 * @param {Object} [deps]
 * @param {(url: string) => Promise<any>} [deps.fetchJson]
 */
const createKrakenSource = ({ fetchJson = defaultFetchJson } = {}) => ({
  id: 'kraken',
  label: 'Kraken',
  // Public endpoints allow roughly one call per second.
  minRequestSpacingMs: 1100,
  parity: /** @type {Array<[string, string]>} */ ([]),
  /** @returns {Promise<Market[]>} */
  listMarkets: async () => {
    const json = await fetchJson('https://api.kraken.com/0/public/AssetPairs');
    if (Array.isArray(json?.error) && json.error.length) throw new Error(`Kraken AssetPairs: ${json.error.join(', ')}`);
    const result = json?.result;
    if (!result || typeof result !== 'object') throw new Error('Kraken AssetPairs: unexpected response');
    return Object.entries(result).flatMap(([key, pair]) => {
      if (!pair || (pair.status && pair.status !== 'online') || key.endsWith('.d')) return [];
      const [base, quote] = String(pair.wsname || '').split('/');
      if (!base || !quote) return [];
      return [{ symbol: key, base: normalizeCurrency(base), quote: normalizeCurrency(quote) }];
    });
  },
  /** @returns {Promise<Book>} */
  fetchBook: async (symbol, depth) => {
    const json = await fetchJson(`https://api.kraken.com/0/public/Depth?pair=${encodeURIComponent(symbol)}&count=${depth}`);
    if (Array.isArray(json?.error) && json.error.length) throw new Error(`Kraken Depth: ${json.error.join(', ')}`);
    const book = json?.result?.[symbol] ?? Object.values(json?.result || {})[0];
    return { bids: normalizeLevels(book?.bids, 'bids'), asks: normalizeLevels(book?.asks, 'asks') };
  },
});

/** Venues the monitor knows how to read, in display order. */
const VENUE_IDS = ['coinbase', 'gemini', 'cryptocom', 'kraken'];

/**
 * @param {Object} [deps]
 * @param {(url: string) => Promise<any>} [deps.fetchJson]
 * @param {string[]} [deps.knownCurrencies]
 */
const createVenueSources = (deps = {}) => ({
  coinbase: createCoinbaseSource(deps),
  gemini: createGeminiSource(deps),
  cryptocom: createCryptocomSource(deps),
  kraken: createKrakenSource(deps),
});

/**
 * Reference FX (ECB rates via frankfurter.app): home currency per 1 unit.
 * Indicative only; used when a venue has no market to convert a quote
 * currency, and to show when a venue's own FX market is the broken leg.
 * @param {string} home
 * @param {(url: string) => Promise<any>} [fetchJson]
 * @returns {Promise<Record<string, number>>}
 */
const fetchReferenceFx = async (home, fetchJson = defaultFetchJson) => {
  const json = await fetchJson(`https://api.frankfurter.app/latest?from=${encodeURIComponent(home)}`);
  const rates = json?.rates;
  if (!rates || typeof rates !== 'object') throw new Error('Reference FX: unexpected response');
  /** @type {Record<string, number>} */
  const homePerUnit = {};
  for (const [ccy, perHome] of Object.entries(rates)) {
    const value = Number(perHome);
    if (Number.isFinite(value) && value > 0) homePerUnit[ccy.toUpperCase()] = 1 / value;
  }
  return homePerUnit;
};

module.exports = {
  VENUE_IDS,
  createVenueSources,
  createCoinbaseSource,
  createGeminiSource,
  createCryptocomSource,
  createKrakenSource,
  fetchReferenceFx,
  splitConcatenatedSymbol,
  normalizeCurrency,
  defaultFetchJson,
};
