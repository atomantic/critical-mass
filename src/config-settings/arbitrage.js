// @ts-check
/**
 * Cross-pair arbitrage monitor settings (config.global.arbitrage).
 * Persistence stays in config-utils; injected readers/writers avoid a runtime
 * back-edge and keep every settings update on the shared config write lock.
 *
 * The monitor only reads public order books and raises alerts. It never
 * places orders.
 */

const ARBITRAGE_VENUE_IDS = ['coinbase', 'gemini', 'cryptocom', 'kraken'];

/**
 * Default taker fees are conservative entry-tier estimates per leg; operators
 * should set their own tier so "net" edges match what they would actually pay.
 */
const ARBITRAGE_DEFAULTS = {
  enabled: false,
  pollIntervalMs: 60_000,
  maxAlerts: 500,
  homeCurrency: 'USD',
  quoteCurrencies: ['USD', 'USDC', 'USDT', 'GUSD', 'PYUSD', 'RLUSD', 'USDG', 'DAI', 'EUR', 'EURC', 'GBP', 'CAD', 'AUD', 'SGD', 'JPY', 'CHF'],
  // Size every route is quoted at, in home currency.
  notionalUsd: 1000,
  // An executable opportunity: net edge (after taker fees on every leg) at
  // least this many bps, at a size of at least minAlertNotionalUsd.
  alertMinNetBps: 50,
  minAlertNotionalUsd: 500,
  // An indicative dislocation: a pair's implied price this far from the venue
  // median, whether or not the loop is executable (e.g. no on-venue FX leg).
  dislocationAlertBps: 300,
  // ...and only when that pair's own book is at most this wide. A 27% spread
  // (Gemini BTC/EUR) says the book is empty, not that BTC is mispriced.
  dislocationMaxSpreadBps: 200,
  // Polls in a row a condition must hold before an alert opens / fails before it closes.
  confirmPolls: 2,
  closeAfterPolls: 3,
  bookDepth: 50,
  referenceFx: { enabled: true, refreshMs: 3_600_000 },
  venues: {
    coinbase: { enabled: true, takerFeeBps: 60 },
    gemini: { enabled: true, takerFeeBps: 40 },
    cryptocom: { enabled: true, takerFeeBps: 50 },
    kraken: { enabled: true, takerFeeBps: 40 },
  },
};

const ARBITRAGE_POLL_INTERVAL_BOUNDS = { min: 15_000, max: 3_600_000 };
const ARBITRAGE_MAX_ALERTS_BOUNDS = { min: 1, max: 5000 };

/**
 * Numeric fields: [min, max, integer]. Shared with the route validator.
 * @type {Record<string, [number, number, boolean]>}
 */
const ARBITRAGE_NUMERIC_BOUNDS = {
  pollIntervalMs: [ARBITRAGE_POLL_INTERVAL_BOUNDS.min, ARBITRAGE_POLL_INTERVAL_BOUNDS.max, true],
  maxAlerts: [ARBITRAGE_MAX_ALERTS_BOUNDS.min, ARBITRAGE_MAX_ALERTS_BOUNDS.max, true],
  notionalUsd: [10, 10_000_000, false],
  alertMinNetBps: [0, 10_000, false],
  minAlertNotionalUsd: [0, 10_000_000, false],
  dislocationAlertBps: [10, 10_000, false],
  dislocationMaxSpreadBps: [0, 10_000, false],
  confirmPolls: [1, 20, true],
  closeAfterPolls: [1, 100, true],
  bookDepth: [5, 200, true],
};

const inBounds = (value, [min, max, integer]) => Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value));

/** Create the settings service using the facade-owned config operations. */
const createArbitrageSettings = ({ loadConfig, mutateConfig }) => {
  /**
   * Arbitrage config merged over defaults, with hand-edited out-of-range
   * values clamped back to the default.
   * @returns {typeof ARBITRAGE_DEFAULTS}
   */
  const getArbitrageConfig = () => {
    const config = loadConfig();
    const saved = config.global?.arbitrage || {};
    const venues = {};
    for (const id of ARBITRAGE_VENUE_IDS) {
      const merged = { ...ARBITRAGE_DEFAULTS.venues[id], ...(saved.venues?.[id] || {}) };
      if (typeof merged.enabled !== 'boolean') merged.enabled = ARBITRAGE_DEFAULTS.venues[id].enabled;
      if (!inBounds(merged.takerFeeBps, [0, 1000, false])) merged.takerFeeBps = ARBITRAGE_DEFAULTS.venues[id].takerFeeBps;
      venues[id] = merged;
    }
    const result = {
      ...ARBITRAGE_DEFAULTS,
      ...saved,
      referenceFx: { ...ARBITRAGE_DEFAULTS.referenceFx, ...(saved.referenceFx || {}) },
      venues,
    };
    for (const [key, bounds] of Object.entries(ARBITRAGE_NUMERIC_BOUNDS)) {
      if (!inBounds(result[key], bounds)) result[key] = ARBITRAGE_DEFAULTS[key];
    }
    if (typeof result.enabled !== 'boolean') result.enabled = ARBITRAGE_DEFAULTS.enabled;
    if (typeof result.homeCurrency !== 'string' || !/^[A-Z]{2,6}$/.test(result.homeCurrency)) result.homeCurrency = ARBITRAGE_DEFAULTS.homeCurrency;
    if (!Array.isArray(result.quoteCurrencies) || !result.quoteCurrencies.every((c) => typeof c === 'string' && /^[A-Z]{2,6}$/.test(c))) {
      result.quoteCurrencies = ARBITRAGE_DEFAULTS.quoteCurrencies;
    }
    return result;
  };

  /**
   * Update arbitrage configuration (venues merge per venue).
   * @param {Object} updates - validated updates
   * @returns {Object} Updated full configuration
   */
  const updateArbitrageConfig = (updates) => mutateConfig((config) => {
    const current = config.global?.arbitrage || {};
    const venues = { ...(current.venues || {}) };
    for (const [id, patch] of Object.entries(updates.venues || {})) {
      venues[id] = { ...(venues[id] || {}), ...patch };
    }
    config.global = config.global || {};
    config.global.arbitrage = {
      ...current,
      ...updates,
      referenceFx: updates.referenceFx ? { ...current.referenceFx, ...updates.referenceFx } : current.referenceFx,
      venues,
    };
  });

  return { getArbitrageConfig, updateArbitrageConfig };
};

/**
 * Validate a `PUT /api/arbitrage/config` body. Returns the accepted subset and
 * every error; unknown keys are errors rather than silently dropped.
 * @param {unknown} body
 * @returns {{ value: Object, errors: string[] }}
 */
const validateArbitrageConfigUpdate = (body) => {
  const errors = [];
  /** @type {Record<string, any>} */
  const value = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { value, errors: ['Request body must be a JSON object'] };
  for (const [key, raw] of Object.entries(body)) {
    if (key === 'enabled') {
      if (typeof raw !== 'boolean') errors.push('enabled: expected boolean');
      else value.enabled = raw;
    } else if (Object.prototype.hasOwnProperty.call(ARBITRAGE_NUMERIC_BOUNDS, key)) {
      const bounds = ARBITRAGE_NUMERIC_BOUNDS[key];
      if (!inBounds(raw, bounds)) errors.push(`${key}: must be ${bounds[2] ? 'an integer' : 'a number'} between ${bounds[0]} and ${bounds[1]}`);
      else value[key] = raw;
    } else if (key === 'quoteCurrencies') {
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > 40 || !raw.every((c) => typeof c === 'string' && /^[A-Z]{2,6}$/.test(c))) {
        errors.push('quoteCurrencies: must be 1-40 upper-case currency codes');
      } else value.quoteCurrencies = [...new Set(raw)];
    } else if (key === 'referenceFx') {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push('referenceFx: must be an object'); continue; }
      const fx = {};
      for (const [fxKey, fxValue] of Object.entries(raw)) {
        if (fxKey === 'enabled' && typeof fxValue === 'boolean') fx.enabled = fxValue;
        else if (fxKey === 'refreshMs' && inBounds(fxValue, [60_000, 86_400_000, true])) fx.refreshMs = fxValue;
        else errors.push(`referenceFx.${fxKey}: invalid`);
      }
      value.referenceFx = fx;
    } else if (key === 'venues') {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push('venues: must be an object'); continue; }
      const venues = {};
      for (const [id, patch] of Object.entries(raw)) {
        if (!ARBITRAGE_VENUE_IDS.includes(id)) { errors.push(`venues.${id}: unknown venue`); continue; }
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) { errors.push(`venues.${id}: must be an object`); continue; }
        const venue = {};
        for (const [venueKey, venueValue] of Object.entries(patch)) {
          if (venueKey === 'enabled' && typeof venueValue === 'boolean') venue.enabled = venueValue;
          else if (venueKey === 'takerFeeBps' && inBounds(venueValue, [0, 1000, false])) venue.takerFeeBps = venueValue;
          else errors.push(`venues.${id}.${venueKey}: invalid`);
        }
        venues[id] = venue;
      }
      value.venues = venues;
    } else {
      errors.push(`${key}: unknown setting`);
    }
  }
  return { value, errors };
};

module.exports = {
  createArbitrageSettings,
  validateArbitrageConfigUpdate,
  ARBITRAGE_DEFAULTS,
  ARBITRAGE_VENUE_IDS,
  ARBITRAGE_NUMERIC_BOUNDS,
  ARBITRAGE_POLL_INTERVAL_BOUNDS,
};
