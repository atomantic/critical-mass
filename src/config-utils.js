// @ts-check
/**
 * Configuration Utilities
 *
 * Handles loading, validation, and normalization of multi-exchange configuration.
 * Supports backward compatibility with single-exchange config format.
 */

const { DEFAULT_AGGRESSIVENESS_PRESETS, MERGE_PROXIMITY_BOUNDS, PRESET_FIELD_RULES } = require('./regime-preset-contract');
const { validateConfigUpdate } = require('./config-validation');
const { isDeepStrictEqual } = require('util');
const fs = require('fs');
const path = require('path');
const { normalizeConfig: normalizeIntervalConfig } = require('./interval-utils');
// logger imports migration; migration's back-edge to config-utils must stay lazy.
const { createContextLogger } = require('./logger');

const configLogger = createContextLogger({ module: 'config-utils' });

/**
 * @typedef {import('./types').ExchangeConfig} ExchangeConfig
 * @typedef {import('./types').GlobalConfig} GlobalConfig
 * @typedef {import('./types').MultiExchangeConfig} MultiExchangeConfig
 * @typedef {import('./types').ValidationResult} ValidationResult
 * @typedef {import('./types').RegimeStrategyConfig} RegimeStrategyConfig
 */

const BASE_CONFIG_FILE = path.join(__dirname, '..', 'config.json');
const EXAMPLE_CONFIG_FILE = path.join(__dirname, '..', 'config.example.json');
const USER_CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

// Resolve the effective base-config path. config.json is git-ignored (it holds
// the operator's real allocations/capital), so a fresh clone won't have one —
// fall back to the committed config.example.json so the app boots out of the
// box with safe dry-run defaults. Operator overrides still land in
// data/config.json and merge on top either way.
const resolveBaseConfigFile = () =>
  fs.existsSync(BASE_CONFIG_FILE) ? BASE_CONFIG_FILE : EXAMPLE_CONFIG_FILE;

// Monotonic per-process counter for unique saveConfig tmp filenames (avoids a
// cross-process rename race on a shared fixed tmp path — see saveConfig).
let _saveConfigTmpSeq = 0;

/**
 * Deep merge two objects. Values from `override` take precedence.
 * Arrays are replaced, not concatenated.
 * @param {Object} base - Base object
 * @param {Object} override - Override object
 * @returns {Object} Merged object
 */
const deepMerge = (base, override) => {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const baseVal = base[key];
    const overVal = override[key];
    if (
      overVal && typeof overVal === 'object' && !Array.isArray(overVal) &&
      baseVal && typeof baseVal === 'object' && !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(baseVal, overVal);
    } else {
      result[key] = overVal;
    }
  }
  return result;
};

/**
 * Compute the diff between base and modified config.
 * Returns only keys/values that differ from base (user overrides).
 * @param {Object} base - Base configuration
 * @param {Object} modified - Modified configuration
 * @returns {Object} Only the differences
 */
const computeDiff = (base, modified) => {
  const diff = {};
  for (const key of Object.keys(modified)) {
    const baseVal = base[key];
    const modVal = modified[key];
    if (modVal && typeof modVal === 'object' && !Array.isArray(modVal) &&
        baseVal && typeof baseVal === 'object' && !Array.isArray(baseVal)) {
      const nested = computeDiff(baseVal, modVal);
      if (Object.keys(nested).length) diff[key] = nested;
    } else if (JSON.stringify(baseVal) !== JSON.stringify(modVal)) {
      diff[key] = modVal;
    }
  }
  return diff;
};

/**
 * Default configuration values
 * @type {ExchangeConfig}
 */
const DEFAULTS = {
  productId: 'BTC-USDC',
  totalAllocation: 10000,
  intervalsToSpread: 60,
  intervalType: 'daily',
  sellMarkupPercent: 10,
  holdbackPercent: 5,
  minOrderSize: 1,
  maxBuyPrice: 500000,
  enabled: false,
  dryRun: true,
  dcaStrategy: 'fixed',
  fibBaseAmount: 10,
};

/**
 * Default regime strategy configuration
 * @type {RegimeStrategyConfig}
 */
const REGIME_DEFAULTS = {
  // Mode flags
  enabled: false,
  // Note: dryRun is read from exchange-level config, not regime config

  // Aggressiveness preset (conservative, moderate, aggressive, maximum)
  aggressiveness: 'moderate',

  // Volatility Clock
  atrPeriod: 14,
  kFactor: 0.65,
  minIntervalMs: 120000,
  maxIntervalMs: 3600000,

  // Regime Detection
  momentumMult: 1.5,
  volExpansionMult: 1.5,
  volContractionMult: 1.2,
  vwapPeriodHours: 4,
  trendConfirmationPeriods: 5,

  // Position Sizing
  minOrderSizeUsdc: 5,  // Minimum order size in USDC (floor after all multipliers)
  baseSizeUsdc: 50,
  harvestScale: 1.0,
  cautionScale: 0.5,
  trendScale: 0.0,
  maxCycleBuys: 15,
  cycleResetHours: 72, // Auto-reset cycle buys counter after 72 hours (3 days) at max, 0 to disable
  liquidityFactorCap: 2.0,
  divergenceScalePct: 5,

  // Take-Profit
  tpMult: 1.0,
  tpMinPercent: 2.0,
  tpMaxPercent: 15.0,
  tpUpdateThresholdPct: 0.5,
  holdbackRatio: 0.5,

  // Legacy satellite aliases (removed — use celestialEnabled / maxCelestialBodies)

  // Celestial Hierarchy
  celestialEnabled: true,             // Enable multi-tier position management
  maxCelestialBodies: 10,             // Maximum concurrent celestial bodies (1-15)
  mergeProximityScale: MERGE_PROXIMITY_BOUNDS.default,  // Scale factor for merge proximity (range: see MERGE_PROXIMITY_BOUNDS)

  // TP Auto-Management
  tpAutoManaged: false,         // Opt-in flag for dynamic TP adjustment
  tpEvaluationCycles: 5,        // Evaluate every N cycles
  tpEvaluationMaxHours: 24,     // Or at least once per day
  tpMinSampleSize: 10,          // Minimum cycles before adjusting
  tpAbsoluteMin: 0.05,          // Floor for tpMinPercent
  tpAbsoluteMax: 5.0,           // Ceiling for tpMaxPercent
  tpMaxChangePercent: 25,       // Max % change per adjustment

  // Size Auto-Management
  sizeAutoManaged: false,       // Opt-in flag for dynamic position sizing
  sizeEvaluationCycles: 5,      // Evaluate every N cycles
  sizeEvaluationMaxHours: 24,   // Or at least once per day
  sizeMinSampleSize: 5,         // Minimum cycles before adjusting
  sizeAbsoluteMinBase: 10,      // Floor for baseSizeUsdc
  sizeAbsoluteMaxBase: 500,     // Ceiling for baseSizeUsdc
  sizeTargetUtilization: 0.90,  // Target 90% capital utilization
  sizeMaxChangePercent: 25,     // Max % change per adjustment
  sizeAutoCycleBuys: false,   // Also auto-adjust maxCycleBuys
  sizeMinCycleBuys: 10,       // Min cycle buys if auto-adjusting
  sizeMaxCycleBuys: 100,      // Max cycle buys if auto-adjusting

  // Risk Caps
  maxAssetExposure: 0,  // 0 = uncapped
  depositedCapital: 0,  // Total user deposits (0 = auto-derive from maxUsdcDeployed - realizedPnL)
  maxUsdcDeployed: 10000,
  maxDrawdownPercent: 20,
  drawdownResetHours: 72, // Auto-reset peak after 72 hours (3 days) of drawdown pause

  // Order Execution
  entryOffsetBps: 10,
  entryOffsetUpBps: 5, // Smaller offset when momentum is UP (get fills before price rises)
  entryOffsetDownBps: 15, // Larger offset when momentum is DOWN (catch falling price)
  entryMaxRetries: 3, // Max retries for post-only rejections in fast markets
  cancelRateLimitMs: 1000,
  orderStaleMs: 30000,

  // System Health
  staleDataMs: 30000,
  staleOrdersMs: 60000,
  maxRestErrors: 5,
  maxRateLimits: 3,
  maxLatencyMs: 5000,
  safeRecoveryMs: 60000,

  // Invariants
  maxOpenOrders: 100,
  reconcileIntervalMs: 60000,

  // Tail Events
  maxSpreadBps: 50,
  spreadPauseMs: 300000,
  minDepthUsdc: 10000,
  depthPauseMs: 300000,
  flashMoveMult: 3.0,
  flashCooldownMs: 600000,
  cancelEntriesOnFlash: true,

  // Macro Regime
  macroEnabled: false,                 // Enable multi-timeframe macro regime overlay
  macroUpdateIntervalMs: 300000,       // How often to fetch candles and re-score (5 min)
  macroHysteresis: 5,                  // Score buffer to prevent mode chatter at boundaries
  macroAccumulationThreshold: -15,     // Score below this → ACCUMULATION
  macroDeclineThreshold: -50,          // Score below this → DECLINE
  macroMarkupThreshold: 35,            // Score above this → MARKUP
  macroAccumulationSizeMult: 1.3,      // Size multiplier in ACCUMULATION
  macroAccumulationTpMult: 0.85,       // TP multiplier in ACCUMULATION (tighter)
  macroAccumulationOffsetMult: 0.8,    // Offset multiplier in ACCUMULATION (tighter entries)
  macroMarkupSizeMult: 0.7,           // Size multiplier in MARKUP
  macroMarkupTpMult: 1.3,             // TP multiplier in MARKUP (wider)
  macroMarkupOffsetMult: 1.2,         // Offset multiplier in MARKUP (wider entries)
  macroDeclineSizeMult: 0.4,          // Size multiplier in DECLINE
  macroDeclineTpMult: 0.7,            // TP multiplier in DECLINE (tighter)
  macroDeclineOffsetMult: 1.5,        // Offset multiplier in DECLINE (wider entries)

  // Long-Term Bias / Auto-Aggressiveness (Phase 1: observe-only)
  // See PLAN.md → Auto-Aggressiveness Roadmap. Phase 1 is purely advisory —
  // the depression score is computed and displayed but does not affect sizing.
  longTermBiasEnabled: true,           // Compute and expose depression score on macro state
  longTermLookbackDays: 365,           // History depth for percentile/drawdown/z-score
  longTermUpdateIntervalMs: 3600000,   // Refresh cadence for long-term candle store (1h)
  autoAggressivenessEnabled: false,    // Phase 3: actually modulate sizing from the score

  // Entry Mode
  entryMode: 'reactive',              // 'reactive' | 'ladder'

  // Ladder Parameters (only when entryMode: 'ladder')
  ladderMaxAthDropPct: 80,            // Bottom of ladder = ATH × (1 - this/100). 80 = lowest bid at 20% of ATH
  ladderSpacingMode: 'sqrt',          // 'linear' | 'sqrt' | 'exponential'
  ladderSizeMode: 'fibonacci',        // 'flat' | 'linear' | 'sqrt' | 'fibonacci'
  ladderAutoSwitch: false,            // Auto-switch based on volatility
  ladderAutoSwitchVolMult: 2.0,       // Vol expansion threshold
  ladderMinSpacingPct: 0.5,           // Min % between rungs
};

/**
 * Default notification configuration
 */
const NOTIFICATION_DEFAULTS = {
  enabled: false,
  telegram: { botToken: '', chatId: '' },
  events: {
    buy_filled: true,
    entry_filled: true,
    tp_filled: true,
    regime_change: true,
    flash_move: true,
    safe_mode: true,
    active_mode: true,
    cap_reached: true,
    cycle_reset: true,
    error: true,
    sell_placed: false,
    tp_placed: false,
    spread_pause: false,
    depth_pause: false,
    regime_hourly: false,
    orders_consolidated: false,
  },
  rateLimitMs: 5000,
  dailySummaryHour: 20,
  quietHours: { enabled: false, start: 23, end: 7 },
};

/**
 * Global default configuration
 * @type {GlobalConfig}
 */
const GLOBAL_DEFAULTS = {
  simpleDcaEnabled: false,
  schedulerInterval: 30000,
  backup: {
    enabled: true,
    intervalMs: 24 * 60 * 60 * 1000, // 24 hours
    maxBackups: 7,
    includePriceCache: false, // price caches are ~45MB per exchange, can be regenerated
  },
};

// In-process cache for the merged config. Invalidated when either the base
// or user config file's mtime changes, so external edits (e.g. from another
// process) are picked up automatically. This eliminates O(N) disk reads
// when a single request fans out across many funds.
let _configCache = null;
let _configCacheKey = null;
// Throttle the "reload failed" warning to once per failure episode. Because
// _configCacheKey is intentionally left stale on failure (to force a retry every
// call), a persistently-broken config would otherwise re-warn on every tick
// across every process/timer. Logged once on entering the failed state; reset on
// the next clean load (#185 review).
let _configReloadFailedLogged = false;

const _statMtimeMs = (file) => {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
};

/**
 * Drop the in-process merged-config cache so the next read comes from disk.
 *
 * Normally the mtime-keyed cache self-invalidates, but a backup restore
 * rewrites `config.json` wholesale and must not depend on filesystem timestamp
 * resolution to be observed — the gateway would keep serving (and re-saving)
 * the pre-restore config (issue #429).
 */
const invalidateConfigCache = () => {
  _configCache = null;
  _configCacheKey = null;
  _configReloadFailedLogged = false;
};

/**
 * Test-only alias for `invalidateConfigCache`. Tests that mock
 * `fs.existsSync`/`fs.readFileSync` should call this between cases since
 * the cache key is based on `fs.statSync` mtime (which the tests don't
 * mock, so the cache would otherwise stick across cases).
 */
const _resetConfigCacheForTests = invalidateConfigCache;

/**
 * Load raw configuration from base config, with user overrides from data/config.json merged on top.
 * @returns {Object} Raw configuration object
 */
const loadRawConfig = () => {
  const baseFile = resolveBaseConfigFile();
  const baseMtime = _statMtimeMs(baseFile);
  const userMtime = _statMtimeMs(USER_CONFIG_FILE);
  const cacheKey = `${baseFile}|${baseMtime}|${userMtime}`;
  if (_configCache && _configCacheKey === cacheKey) {
    return _configCache;
  }
  // Guard JSON.parse: loadRawConfig runs inside setInterval/setTimeout
  // callbacks (server.js exchange refresh, regime-engine updateMetrics →
  // handleTpAdjustment), so a thrown SyntaxError is an uncaught exception that
  // KILLS the whole gateway/engine — taking down live trading with no recovery
  // (observed crashing the gateway 2026-04-28 and the cryptocom engine
  // 2026-05-18 on a transient empty/partial read). The atomic write in
  // saveConfig (#123) only protects USER_CONFIG_FILE; the base config is still
  // exposed, and external corruption can hit either file. On a parse failure
  // with a last-good cache in hand, keep running on it; only a cold-start
  // failure (no cache yet) rethrows so the operator repairs before the engine
  // boots on the wrong config — mirroring fill-ledger.js's cold-start contract
  // (issue #185).
  let base;
  let user;
  try {
    base = baseMtime > 0 ? JSON.parse(fs.readFileSync(baseFile, 'utf8')) : {};
    user = userMtime > 0 ? JSON.parse(fs.readFileSync(USER_CONFIG_FILE, 'utf8')) : {};
  } catch (err) {
    if (_configCache) {
      // Leave _configCacheKey stale so the next call retries the read and picks
      // up the repaired file immediately once it parses cleanly again. Warn once
      // per episode (not every tick) — a persistently-broken config edit would
      // otherwise flood every process's log. Operators must still notice their
      // change didn't take effect; the engine keeps running on last-good config.
      if (!_configReloadFailedLogged) {
        configLogger.warn(`⚠️ [config] reload failed (${err.message}) — STILL USING LAST-GOOD CONFIG; repair ${USER_CONFIG_FILE}`, {
          error: err.message,
          configFile: USER_CONFIG_FILE,
          usingLastGoodConfig: true,
        });
        _configReloadFailedLogged = true;
      }
      return _configCache;
    }
    throw err;
  }
  _configReloadFailedLogged = false; // clean load — re-arm the failure warning
  _configCache = Object.keys(user).length ? deepMerge(base, user) : base;
  _configCacheKey = cacheKey;
  return _configCache;
};

/**
 * Atomically replace the user override file (data/config.json) with `override`.
 *
 * Split out of `saveConfig` so backup restore can rebuild the override file at
 * an explicit path (temp-directory tests, and the restore path that reconstructs
 * overrides against the destination's base config) without going through the
 * live config cache (issue #430).
 *
 * @param {Object} override - Base-relative override object to persist
 * @param {string} [file] - Target path; defaults to the live data/config.json
 * @returns {void}
 */
const writeUserConfigFile = (override, file = USER_CONFIG_FILE) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Atomic write (tmp + rename): a crash mid-write would otherwise leave a
  // truncated config.json, and loadRawConfig throws on parse failure — which
  // takes down the gateway AND every engine process at boot, with no recovery
  // path. Inlined rather than importing state-tracker.atomicWriteSync to avoid
  // a require cycle (state-tracker already requires config-utils) (issue #110 M7).
  // The tmp filename is unique per writer (pid + counter) so two processes
  // saving concurrently (e.g. an engine auto-updating regime limits while the
  // gateway handles a settings PUT) can't rename each other's tmp file — which
  // would ENOENT the second rename or persist the wrong payload. The rename
  // itself is atomic, so the last writer wins cleanly (#110 M7 / review).
  const tmpPath = `${file}.${process.pid}.${++_saveConfigTmpSeq}.tmp`;
  // Preserve the existing file's permission mode across the atomic replace.
  // tmp+rename creates a NEW inode at the default umask mode (commonly 0644),
  // so without this an operator who locked down config.json to 0600 (it can
  // hold the Telegram token / other secrets) would silently get it widened to
  // world-readable on every settings save. Fall back to 0600 for a brand-new
  // file since it may contain secrets (#110 review).
  let mode = 0o600;
  try {
    const existing = fs.statSync(file).mode & 0o777;
    if (existing) mode = existing; // keep the operator's chosen mode; ignore a 0/absent mode
  } catch { /* new file → restrictive default */ }
  fs.writeFileSync(tmpPath, JSON.stringify(override, null, 2), { mode });
  fs.renameSync(tmpPath, file);
};

/**
 * Save configuration to user config file (data/config.json).
 * Only persists the diff (overrides) from the base config.
 * @param {MultiExchangeConfig} config - Full merged configuration to save
 * @returns {void}
 */
const saveConfig = (config) => {
  const baseFile = resolveBaseConfigFile();
  // Guard the parse the same way loadRawConfig does (#185): the base config
  // can be transiently unreadable (mid-write from another process, disk
  // hiccup), and a raw SyntaxError here would abort the whole save — and the
  // caller (e.g. updateRegimeConfig) has already mutated its own working
  // copy expecting saveConfig to either persist it or throw a clear error.
  let base;
  try {
    base = fs.existsSync(baseFile)
      ? JSON.parse(fs.readFileSync(baseFile, 'utf8'))
      : {};
  } catch (err) {
    throw new Error(`saveConfig: base config file is unreadable/corrupt (${baseFile}): ${err.message}`);
  }
  writeUserConfigFile(computeDiff(base, config));
  // Bust the cache so the next read picks up our write immediately, even
  // before the OS updates mtime.
  _configCache = null;
  _configCacheKey = null;
};

/**
 * Check if config is in multi-exchange format
 * @param {Object} config - Configuration object
 * @returns {boolean}
 */
const isMultiExchangeConfig = (config) => {
  return config && typeof config.exchanges === 'object';
};

/**
 * Normalize single-exchange config to multi-exchange format
 * @param {Object} config - Single-exchange configuration
 * @returns {MultiExchangeConfig} Multi-exchange configuration
 */
const normalizeToMultiExchange = (config) => {
  if (isMultiExchangeConfig(config)) {
    return config;
  }

  // Convert flat config to multi-exchange format
  const { schedulerInterval, ...exchangeConfig } = config;

  return {
    exchanges: {
      coinbase: {
        ...DEFAULTS,
        ...exchangeConfig,
      },
      gemini: {
        ...DEFAULTS,
        productId: 'BTCUSD',
        enabled: false,
        dryRun: true,
      },
    },
    global: {
      ...GLOBAL_DEFAULTS,
      schedulerInterval: schedulerInterval || GLOBAL_DEFAULTS.schedulerInterval,
    },
  };
};

/**
 * Load and normalize configuration
 *
 * Returns a fresh deep clone on every call. loadRawConfig()/_configCache stay
 * shared for the O(N)-disk-read win that motivated the cache, but every
 * update*Config helper below mutates the object loadConfig() hands back
 * before calling saveConfig — if that were the live cache, a saveConfig
 * throw would leave the process running on a value that was never persisted
 * (issue #416). Node >= 20 per package.json `engines`, so structuredClone is
 * available.
 * @returns {MultiExchangeConfig} Normalized multi-exchange configuration
 */
const loadConfig = () => {
  const raw = loadRawConfig();
  return structuredClone(normalizeToMultiExchange(raw));
};

// ============================================================================
// Multi-Pair (Fund) Helpers
//
// A "fund" is identified by (exchange, pair). One exchange can host multiple
// funds, each with its own productId, regime config, allocation, lifecycle,
// and on-disk state. The on-disk config supports two layouts for an
// exchange's block:
//
//   Legacy (single fund per exchange):
//     { exchanges: { coinbase: { productId, regime, ...flatFields } } }
//
//   Nested (multi-pair):
//     { exchanges: { coinbase: { pairs: {
//         "BTC-USDC": { productId, regime, ...flatFields },
//         "ETH-USDC": { productId, regime, ...flatFields },
//     } } } }
//
// All readers use `normalizeExchangeBlock` so both layouts present a uniform
// `pairs` map internally. Writers (addFund/updateFundConfig) auto-convert from
// legacy → nested when a second pair is added.
// ============================================================================

// ============================================================================
// Currency parsing utilities
// ============================================================================

/**
 * Extract base currency from product ID.
 * Handles all exchange formats: BTC-USDC (Coinbase), CRO_USD (Crypto.com), BTCUSD (Gemini).
 * @param {string} productId
 * @returns {string} Base currency (e.g., 'BTC', 'ETH', 'CRO')
 */
const getBaseCurrency = (productId) => {
  if (!productId) return 'BTC';
  if (productId.includes('-')) return productId.split('-')[0];
  if (productId.includes('_')) return productId.split('_')[0];
  const upper = productId.toUpperCase();
  if (upper.endsWith('USDC')) return upper.slice(0, -4);
  if (upper.endsWith('USDT')) return upper.slice(0, -4);
  if (upper.endsWith('USD')) return upper.slice(0, -3);
  return upper;
};

/**
 * Extract quote currency from product ID.
 * @param {string} productId
 * @returns {string} Quote currency (e.g., 'USDC', 'USD')
 */
const getQuoteCurrency = (productId) => {
  if (!productId) return 'USD';
  if (productId.includes('-')) return productId.split('-')[1];
  if (productId.includes('_')) return productId.split('_')[1];
  const upper = productId.toUpperCase();
  if (upper.endsWith('USDC')) return 'USDC';
  if (upper.endsWith('USDT')) return 'USDT';
  if (upper.endsWith('USD')) return 'USD';
  return 'USD';
};

/**
 * Check whether a productId trades the same base asset as a fund's pair. A
 * fund's pair IS its identity, so a productId supplied at creation (POST
 * /api/:exchange/funds) or update (PUT /api/:exchange/config) must trade the
 * same base asset as the pair — a quote-only difference (e.g. USD -> USDC)
 * is allowed. Shared by both routes (and by `addFund`'s defensive check) so
 * the identity rule can't drift between entry points.
 *
 * @param {string} pair
 * @param {string} productId
 * @returns {{ ok: boolean, pairBase: string, incomingBase: string }}
 */
const productIdMatchesPair = (pair, productId) => {
  const pairBase = getBaseCurrency(pair);
  const incomingBase = getBaseCurrency(productId);
  return { ok: pairBase === incomingBase, pairBase, incomingBase };
};

/** Keys that stay at the exchange level (shared across all funds on that exchange) */
const EXCHANGE_LEVEL_KEYS = new Set([
  'pairs',
  'deletedPairs',
  'schedulerInterval',
  'aggressivenessPresets',
]);

/**
 * Exchange-level key holding fund deletion tombstones (issue #441).
 *
 * `saveConfig` persists only `computeDiff(base, merged)`, and `computeDiff`
 * walks `Object.keys(modified)` — so a pair *removed* from the merged tree is
 * simply absent from the diff, not recorded as deleted, and the next
 * `deepMerge(base, userDiff)` restores it from the base `config.json`. Making
 * `computeDiff` emit a marker for every missing base key would be wrong: the
 * config editor deliberately drops unknown/dead `regime` keys on the way
 * through and they must stay inert in base rather than be tombstoned
 * (tests/exchange-routes-config.test.js).
 *
 * So the tombstone is narrow and explicit: a string array of deleted pair
 * names stored at the exchange level. It lives OUTSIDE `pairs` on purpose —
 * every writer round-trips the block through `normalizeExchangeBlock`, which
 * filters tombstoned pairs out of `pairs` but carries the marker list through
 * untouched, so no ordinary save can resurrect a deleted fund. It is a plain
 * JSON array, so `loadRawConfig`/`deepMerge` (arrays are replaced wholesale)
 * round-trip it without any format awareness, and older builds reading a
 * tombstoned `data/config.json` just see an unknown key rather than throwing.
 */
const DELETED_PAIRS_KEY = 'deletedPairs';

/**
 * Read an exchange block's deletion tombstones, tolerating absent/garbage values.
 * @param {Object} [exchangeBlock]
 * @returns {string[]} Deleted pair names (possibly empty)
 */
const getDeletedPairs = (exchangeBlock) => {
  const list = exchangeBlock?.[DELETED_PAIRS_KEY];
  return Array.isArray(list) ? list.filter((p) => typeof p === 'string' && p) : [];
};

/**
 * Drop a pair's tombstone so a legitimate re-add isn't suppressed. Returns the
 * block unchanged (same reference) when there is nothing to clear, so ordinary
 * saves never introduce a `deletedPairs` key. Keeps an emptied list as `[]`
 * rather than deleting the key — the diff has to be able to override a
 * tombstone that lives in the base config.
 * @param {Object} exchangeBlock
 * @param {string} pair
 * @returns {Object}
 */
const clearDeletedPair = (exchangeBlock, pair) => {
  const list = getDeletedPairs(exchangeBlock);
  if (!list.includes(pair)) return exchangeBlock;
  return { ...exchangeBlock, [DELETED_PAIRS_KEY]: list.filter((p) => p !== pair) };
};

/**
 * Global sub-objects that must NEVER be merged into per-fund configs.
 * They carry secrets (notifications.telegram.botToken) or unrelated global
 * settings (sentinel, backup, aggressivenessPresets), and fund configs are
 * returned verbatim by API routes (e.g. legacy GET /api/config on an
 * unauthenticated listener). Consumers that need these sub-objects read them
 * via the dedicated accessors: getNotificationConfig, getSentinelConfig,
 * getBackupConfig, getAggressivenessPresets.
 */
const GLOBAL_KEYS_EXCLUDED_FROM_FUND_CONFIG = Object.freeze([
  'notifications',
  'sentinel',
  'backup',
  'aggressivenessPresets',
]);

/**
 * Copy of `global` with the secret-bearing/excluded sub-objects removed,
 * safe to spread into a fund config.
 * @param {Object|undefined} globalConfig
 * @returns {Object}
 */
const omitExcludedGlobals = (globalConfig) => {
  const safe = { ...(globalConfig || {}) };
  for (const key of GLOBAL_KEYS_EXCLUDED_FROM_FUND_CONFIG) delete safe[key];
  return safe;
};

/**
 * Resolve one fund's effective settings from a raw fund block.
 *
 * Pure counterpart of `getFundConfig` (which adds interval normalization on
 * top): DEFAULTS < non-excluded globals < the fund's own block. Shared with
 * `buildConfigSnapshot` so an archived snapshot materializes exactly the
 * values a reader would have seen (issue #430).
 *
 * @param {Object|undefined} globalConfig - The config's `global` block
 * @param {Object|undefined} fundBlock - Raw per-pair block
 * @returns {Object} Effective fund settings
 */
const resolveFundConfig = (globalConfig, fundBlock) => ({
  ...DEFAULTS,
  ...omitExcludedGlobals(globalConfig),
  ...(fundBlock || {}),
});

/**
 * Resolve one fund's effective regime settings from a raw fund block.
 *
 * Pure counterpart of `getRegimeConfig`, including the on-disk migration of
 * the pre-rename exposure cap key.
 *
 * @param {Object|undefined} fundBlock - Raw per-pair block
 * @returns {Object} Effective regime settings
 */
const resolveRegimeConfig = (fundBlock) => {
  const merged = { ...REGIME_DEFAULTS, ...(fundBlock?.regime || {}) };
  // Migrate old config key from disk
  const _oldKey = 'max' + 'BtcExposure'; // constructed to avoid refactoring scripts
  if (_oldKey in merged) {
    merged.maxAssetExposure = merged[_oldKey];
    delete merged[_oldKey];
  }
  return merged;
};

/**
 * Mask a secret for display: first 6 chars + '...' + last 4 chars.
 * @param {string} [secret]
 * @returns {string}
 */
const maskSecret = (secret) => secret ? `${secret.slice(0, 6)}...${secret.slice(-4)}` : '';

/**
 * Detect a previously-masked secret being echoed back by a client
 * (round-trip guard). Real Telegram bot tokens never contain '...'.
 * @param {*} value
 * @returns {boolean}
 */
const isMaskedSecret = (value) => typeof value === 'string' && value.includes('...');

/**
 * Normalize an exchange block to its `{ pairs, ...exchangeLevelFields }` form.
 * If the block is in legacy flat format, synthesizes `pairs[productId]` from
 * the flat fund-level fields. The original block is NOT mutated.
 *
 * @param {Object} exchangeBlock - Raw exchange config block
 * @returns {Object} { pairs: {pair: fundBlock}, ...exchangeLevelFields }
 */
const normalizeExchangeBlock = (exchangeBlock) => {
  if (!exchangeBlock || typeof exchangeBlock !== 'object') {
    return { pairs: {} };
  }
  if (exchangeBlock.pairs && typeof exchangeBlock.pairs === 'object') {
    // Already in nested form — return a copy that also clones each pair block
    // (the comment used to say "shallow copy" but returned the LIVE cached
    // object). loadRawConfig returns the shared _configCache, and callers mutate
    // the normalized result before saveConfig: updateFundConfig replaces
    // pairs[pair] (a one-level pairs clone would suffice) but updateRegimeConfig
    // does `normalized.pairs[pair].regime = merged` IN PLACE — so the inner pair
    // objects must be cloned too, or a saveConfig throw leaves the cache showing
    // the new value while disk doesn't (#113 / review).
    // Tombstoned pairs are filtered out here (the single read chokepoint) but
    // the `deletedPairs` marker list rides along in the spread, so writers that
    // save the normalized block back keep the deletion (#441).
    const deleted = new Set(getDeletedPairs(exchangeBlock));
    const pairsCopy = {};
    for (const [p, block] of Object.entries(exchangeBlock.pairs)) {
      if (deleted.has(p)) continue;
      pairsCopy[p] = (block && typeof block === 'object') ? { ...block } : block;
    }
    return { ...exchangeBlock, pairs: pairsCopy };
  }
  // Legacy flat → synthesize a single-fund pairs map
  const productId = exchangeBlock.productId || DEFAULTS.productId;
  const fundBlock = {};
  const exchangeLevel = {};
  for (const [key, value] of Object.entries(exchangeBlock)) {
    if (EXCHANGE_LEVEL_KEYS.has(key)) {
      exchangeLevel[key] = value;
    } else {
      fundBlock[key] = value;
    }
  }
  return {
    ...exchangeLevel,
    pairs: getDeletedPairs(exchangeBlock).includes(productId)
      ? {}
      : { [productId]: fundBlock },
  };
};

/**
 * Get the default pair for an exchange. For legacy flat config this is the
 * exchange's productId; for nested config it is the first key in `pairs`.
 *
 * @param {string} exchange - Exchange name
 * @returns {string|null} Default pair name, or null if exchange has no funds
 */
const getDefaultPair = (exchange) => {
  const config = loadConfig();
  const block = config.exchanges?.[exchange];
  if (!block) return null;
  // Tombstoned pairs are skipped so a deleted fund can never become an
  // exchange's default (#441). Filtered inline rather than via
  // normalizeExchangeBlock to keep the legacy-flat semantics exactly as they
  // were: a flat block with no productId still resolves to null, not DEFAULTS.
  const deleted = new Set(getDeletedPairs(block));
  if (block.pairs && typeof block.pairs === 'object') {
    const keys = Object.keys(block.pairs).filter((p) => !deleted.has(p));
    return keys.length > 0 ? keys[0] : null;
  }
  return (block.productId && !deleted.has(block.productId)) ? block.productId : null;
};

/**
 * Get all configured funds across all exchanges.
 * @returns {Array<{exchange: string, pair: string}>}
 */
const getConfiguredFunds = () => {
  const config = loadConfig();
  const funds = [];
  for (const [exchange, block] of Object.entries(config.exchanges || {})) {
    const normalized = normalizeExchangeBlock(block);
    for (const pair of Object.keys(normalized.pairs || {})) {
      funds.push({ exchange, pair });
    }
  }
  return funds;
};

/**
 * Get all configured funds for a specific exchange.
 * @param {string} exchange
 * @returns {string[]} List of pair names
 */
const getFundsForExchange = (exchange) => {
  const config = loadConfig();
  const block = config.exchanges?.[exchange];
  if (!block) return [];
  const normalized = normalizeExchangeBlock(block);
  return Object.keys(normalized.pairs || {});
};

// Pair names are identifiers, not filesystem paths. Keep this format check
// alongside the configured-fund lookup so HTTP and IPC callers share one
// definition of an acceptable fund identity.
const PAIR_RE = /^[A-Z0-9]{2,8}([-_][A-Z0-9]{2,8})?$/i;

/**
 * Resolve a requested pair to the exact configured fund key for an exchange.
 * A missing pair keeps the legacy default-fund behavior; supplied pairs must
 * be strings in a supported exchange format and name an existing fund.
 *
 * @param {string} exchange
 * @param {unknown} pair
 * @returns {{ pair: string | null, error: string | null }}
 */
const resolveConfiguredPair = (exchange, pair) => {
  const configuredFunds = getFundsForExchange(exchange);
  if (pair === undefined || pair === null || pair === '') {
    const defaultPair = getDefaultPair(exchange);
    if (!defaultPair || !configuredFunds.includes(defaultPair)) {
      return { pair: null, error: `No configured fund for exchange: ${exchange}` };
    }
    return { pair: defaultPair, error: null };
  }

  if (typeof pair !== 'string' || !PAIR_RE.test(pair)) {
    return { pair: null, error: 'Invalid pair. Expected a configured pair such as BTC-USDC, BTC_USD, or ETHUSD' };
  }

  const normalized = pair.toUpperCase();
  const configuredPair = configuredFunds.find((fund) => fund.toUpperCase() === normalized);
  if (!configuredPair) {
    return { pair: null, error: `Unknown configured fund for ${exchange}: ${normalized}` };
  }
  return { pair: configuredPair, error: null };
};

/**
 * Get the merged configuration for a specific fund (exchange + pair).
 * Resolves the fund's pair-level block, merges with DEFAULTS, and applies
 * interval normalization. If pair is omitted, falls back to the default pair.
 *
 * @param {string} exchange
 * @param {string} [pair] - Pair name; defaults to the exchange's default pair
 * @returns {ExchangeConfig} Fund configuration with defaults applied
 */
const getFundConfig = (exchange, pair) => {
  const config = loadConfig();
  const block = config.exchanges?.[exchange] || {};
  const normalized = normalizeExchangeBlock(block);
  const resolvedPair = pair || Object.keys(normalized.pairs || {})[0];
  const fundBlock = normalized.pairs?.[resolvedPair] || {};

  return normalizeIntervalConfig(resolveFundConfig(config.global, fundBlock));
};

/**
 * Get configuration for a specific exchange (returns the default fund's config).
 * Backwards-compat alias retained for legacy callers — new code should use
 * `getFundConfig(exchange, pair)`.
 *
 * @param {string} exchange - Exchange name
 * @returns {ExchangeConfig} Default fund's configuration with defaults applied
 */
const getExchangeConfig = (exchange) => getFundConfig(exchange);

/**
 * Get list of enabled exchanges (any exchange with at least one enabled fund).
 * @returns {string[]} List of enabled exchange names
 */
const getEnabledExchanges = () => {
  const config = loadConfig();
  const enabled = new Set();
  for (const [name, block] of Object.entries(config.exchanges || {})) {
    const normalized = normalizeExchangeBlock(block);
    for (const fund of Object.values(normalized.pairs || {})) {
      if (fund.enabled === true) {
        enabled.add(name);
        break;
      }
    }
  }
  return Array.from(enabled);
};

/**
 * Get list of enabled funds across all exchanges.
 * @returns {Array<{exchange: string, pair: string}>}
 */
const getEnabledFunds = () => {
  const config = loadConfig();
  const funds = [];
  for (const [exchange, block] of Object.entries(config.exchanges || {})) {
    const normalized = normalizeExchangeBlock(block);
    for (const [pair, fundBlock] of Object.entries(normalized.pairs || {})) {
      if (fundBlock.enabled === true) {
        funds.push({ exchange, pair });
      }
    }
  }
  return funds;
};

/**
 * Get list of all configured exchanges
 * @returns {string[]} List of exchange names
 */
const getConfiguredExchanges = () => {
  const config = loadConfig();
  return Object.keys(config.exchanges || {});
};

/**
 * Update fund-level configuration for a specific (exchange, pair).
 * Auto-converts the exchange's block from legacy flat → nested if needed.
 *
 * @param {string} exchange
 * @param {string} pair - Pair name
 * @param {Partial<ExchangeConfig>} updates - Fund-level config updates
 * @returns {MultiExchangeConfig} Updated full configuration
 */
const updateFundConfig = (exchange, pair, updates) => {
  const config = loadConfig();
  if (!config.exchanges) config.exchanges = {};

  // Seed DEFAULTS for brand-new exchange entries (preserves legacy behavior:
  // updateExchangeConfig('kraken', {...}) used to start from DEFAULTS).
  const isNew = !config.exchanges[exchange];
  const block = isNew ? { ...DEFAULTS } : config.exchanges[exchange];

  // If the block is in legacy flat form AND the target pair is the legacy
  // pair (or no pairs map exists yet), update in place to avoid converting
  // the on-disk schema unnecessarily. Otherwise convert to nested.
  const isLegacy = !block.pairs || typeof block.pairs !== 'object';
  const legacyPair = block.productId || DEFAULTS.productId;

  if (isLegacy && pair === legacyPair) {
    // Update flat fields directly — keep legacy layout
    config.exchanges[exchange] = { ...block, ...updates };
  } else {
    // Convert to nested form (idempotent if already nested)
    const normalized = normalizeExchangeBlock(block);
    const fundBlock = normalized.pairs[pair] || {};
    normalized.pairs[pair] = { ...fundBlock, ...updates };
    config.exchanges[exchange] = normalized;
  }

  // Writing a fund re-establishes it: drop any deletion tombstone so a re-add
  // of a previously removed pair isn't suppressed on the next load (#441).
  config.exchanges[exchange] = clearDeletedPair(config.exchanges[exchange], pair);

  saveConfig(config);
  return config;
};

/**
 * Update configuration for a specific exchange (legacy single-fund alias).
 * Updates the exchange's default fund. New code should use updateFundConfig.
 *
 * @param {string} exchange - Exchange name
 * @param {Partial<ExchangeConfig>} updates - Configuration updates
 * @returns {MultiExchangeConfig} Updated full configuration
 */
const updateExchangeConfig = (exchange, updates) => {
  const pair = getDefaultPair(exchange) || DEFAULTS.productId;
  return updateFundConfig(exchange, pair, updates);
};

/**
 * Add a new fund (exchange + pair). The exchange must already exist (i.e.
 * an adapter is configured for it). Refuses to overwrite an existing fund.
 *
 * @param {string} exchange
 * @param {string} pair
 * @param {Partial<ExchangeConfig>} initialConfig - Initial fund config (productId, enabled, dryRun, etc.)
 * @returns {MultiExchangeConfig} Updated full configuration
 * @throws {Error} If the exchange is unknown or the fund already exists
 */
const addFund = (exchange, pair, initialConfig = {}) => {
  if (!exchange || typeof exchange !== 'string') {
    throw new Error('exchange is required');
  }
  if (!pair || typeof pair !== 'string') {
    throw new Error('pair is required');
  }
  // Accept three formats:
  //   BASE-QUOTE (Coinbase, e.g. BTC-USDC)
  //   BASE_QUOTE (Crypto.com, e.g. BTC_USD)
  //   BASEQUOTE  (Gemini, e.g. BTCUSD)
  // The actual product validity is checked downstream via adapter.getProductDetails.
  if (!/^[A-Z0-9]{2,8}([-_][A-Z0-9]{2,8})?$/.test(pair)) {
    throw new Error(`Invalid pair format: ${pair} (expected e.g. BTC-USDC, ETHUSD, BTC_USD)`);
  }
  const existing = getFundsForExchange(exchange);
  if (existing.includes(pair)) {
    throw new Error(`Fund ${exchange}/${pair} already exists`);
  }

  // Defensive invariant: a fund's pair IS its identity, so a supplied
  // productId must trade the same base asset (quote-only differences, e.g.
  // USD -> USDC, are fine). POST /api/:exchange/funds already enforces this
  // at the request boundary, but that's an easy check to route around —
  // this repeats it here so no other caller can recreate the mismatch.
  if (initialConfig.productId !== undefined && initialConfig.productId !== null) {
    if (typeof initialConfig.productId !== 'string' || !initialConfig.productId) {
      throw new Error('productId must be a non-empty string');
    }
    const { ok, pairBase, incomingBase } = productIdMatchesPair(pair, initialConfig.productId);
    if (!ok) {
      throw new Error(`productId "${initialConfig.productId}" (${incomingBase}) does not match fund ${exchange}/${pair} (${pairBase}); a fund's traded asset must match its pair`);
    }
  }

  // Build the new fund block
  const fundBlock = {
    enabled: false,         // safer default — operator must explicitly enable
    dryRun: true,           // safer default
    productId: pair,        // pair IS the productId
    ...initialConfig,
  };

  return updateFundConfig(exchange, pair, fundBlock);
};

/**
 * Remove a fund (exchange + pair). Refuses to remove the last remaining fund
 * on an exchange — at least one fund must remain. Use this only after the
 * fund has been closed (lifecycle = closed) and its on-disk state archived
 * elsewhere; this function only mutates config, not state files.
 *
 * @param {string} exchange
 * @param {string} pair
 * @returns {MultiExchangeConfig} Updated full configuration
 */
const removeFund = (exchange, pair) => {
  const config = loadConfig();
  const block = config.exchanges?.[exchange];
  if (!block) {
    throw new Error(`Exchange ${exchange} not found`);
  }

  const existing = getFundsForExchange(exchange);
  if (!existing.includes(pair)) {
    throw new Error(`Fund ${exchange}/${pair} not found`);
  }
  if (existing.length === 1) {
    throw new Error(`Cannot remove the last remaining fund on ${exchange}`);
  }

  const normalized = normalizeExchangeBlock(block);
  delete normalized.pairs[pair];
  // Deleting the key is not enough on its own: saveConfig persists only the
  // diff against the base config.json, so a pair defined there would re-merge
  // on the next load. Record an explicit tombstone (#441).
  normalized[DELETED_PAIRS_KEY] = [...new Set([...getDeletedPairs(normalized), pair])];
  config.exchanges[exchange] = normalized;
  saveConfig(config);
  return config;
};

/**
 * Update global configuration
 * @param {Partial<GlobalConfig>} updates - Global configuration updates
 * @returns {MultiExchangeConfig} Updated full configuration
 */
const updateGlobalConfig = (updates) => {
  const config = loadConfig();

  config.global = {
    ...config.global,
    ...updates,
  };

  saveConfig(config);
  return config;
};

/**
 * Enable or disable a fund (or the default fund of an exchange).
 * @param {string} exchange - Exchange name
 * @param {boolean|string} enabledOrPair - 2-arg form: enabled. 3-arg form: pair name.
 * @param {boolean} [maybeEnabled] - 3-arg form: enabled
 * @returns {MultiExchangeConfig} Updated configuration
 */
const setExchangeEnabled = (exchange, enabledOrPair, maybeEnabled) => {
  if (typeof enabledOrPair === 'string') {
    return updateFundConfig(exchange, enabledOrPair, { enabled: maybeEnabled });
  }
  return updateExchangeConfig(exchange, { enabled: enabledOrPair });
};

/**
 * Set dry-run mode for a fund (or the default fund of an exchange).
 * @param {string} exchange - Exchange name
 * @param {boolean|string} dryRunOrPair - 2-arg form: dryRun. 3-arg form: pair name.
 * @param {boolean} [maybeDryRun] - 3-arg form: dryRun
 * @returns {MultiExchangeConfig} Updated configuration
 */
const setExchangeDryRun = (exchange, dryRunOrPair, maybeDryRun) => {
  if (typeof dryRunOrPair === 'string') {
    return updateFundConfig(exchange, dryRunOrPair, { dryRun: maybeDryRun });
  }
  return updateExchangeConfig(exchange, { dryRun: dryRunOrPair });
};

/**
 * Validate exchange configuration
 * @param {Partial<ExchangeConfig>} config - Exchange configuration to validate
 * @returns {ValidationResult}
 */
const validateExchangeConfig = (config) => {
  const errors = [];

  if (!config.productId) {
    errors.push('productId is required');
  }

  if (typeof config.totalAllocation !== 'number' || config.totalAllocation <= 0) {
    errors.push('totalAllocation must be a positive number');
  }

  if (typeof config.intervalsToSpread !== 'number' || config.intervalsToSpread <= 0) {
    errors.push('intervalsToSpread must be a positive number');
  }

  if (typeof config.sellMarkupPercent !== 'number' || config.sellMarkupPercent < 0) {
    errors.push('sellMarkupPercent must be a non-negative number');
  }

  if (typeof config.holdbackPercent !== 'number' || config.holdbackPercent < 0 || config.holdbackPercent > 100) {
    errors.push('holdbackPercent must be between 0 and 100');
  }

  if (typeof config.minOrderSize !== 'number' || config.minOrderSize <= 0) {
    errors.push('minOrderSize must be a positive number');
  }

  if (typeof config.maxBuyPrice !== 'number' || config.maxBuyPrice <= 0) {
    errors.push('maxBuyPrice must be a positive number');
  }

  // Fibonacci strategy validation
  if (config.dcaStrategy !== undefined && !['fixed', 'fibonacci'].includes(config.dcaStrategy)) {
    errors.push('dcaStrategy must be "fixed" or "fibonacci"');
  }

  if (config.dcaStrategy === 'fibonacci') {
    if (typeof config.fibBaseAmount !== 'number' || config.fibBaseAmount <= 0) {
      errors.push('fibBaseAmount must be a positive number when using Fibonacci strategy');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
};

/**
 * Get global configuration
 * @returns {GlobalConfig} Global configuration
 */
const getGlobalConfig = () => {
  const config = loadConfig();
  return {
    ...GLOBAL_DEFAULTS,
    ...config.global,
  };
};

/**
 * Get regime strategy configuration for a specific fund (exchange + pair).
 * If pair is omitted, falls back to the exchange's default fund.
 *
 * @param {string} exchange - Exchange name
 * @param {string} [pair] - Pair name; defaults to the exchange's default pair
 * @returns {RegimeStrategyConfig} Regime configuration with defaults applied
 */
const getRegimeConfig = (exchange, pair) => {
  const config = loadConfig();
  const block = config.exchanges?.[exchange] || {};
  const normalized = normalizeExchangeBlock(block);
  const resolvedPair = pair || Object.keys(normalized.pairs || {})[0];
  return resolveRegimeConfig(normalized.pairs?.[resolvedPair]);
};

/**
 * Update regime configuration for a specific fund (exchange + pair).
 * If pair is omitted, updates the exchange's default fund.
 *
 * @param {string} exchange - Exchange name
 * @param {string|Partial<RegimeStrategyConfig>} pairOrUpdates - Pair name (3-arg form) or updates (legacy 2-arg form)
 * @param {Partial<RegimeStrategyConfig>} [maybeUpdates] - Regime config updates (3-arg form)
 * @returns {MultiExchangeConfig} Updated full configuration
 */
const updateRegimeConfig = (exchange, pairOrUpdates, maybeUpdates) => {
  let pair;
  let updates;
  if (typeof pairOrUpdates === 'string') {
    pair = pairOrUpdates;
    updates = maybeUpdates || {};
  } else {
    pair = getDefaultPair(exchange) || DEFAULTS.productId;
    updates = pairOrUpdates || {};
  }

  const config = loadConfig();
  if (!config.exchanges) config.exchanges = {};

  // Seed DEFAULTS for brand-new exchange entries (legacy behavior).
  const isNew = !config.exchanges[exchange];
  const block = isNew ? { ...DEFAULTS } : config.exchanges[exchange];
  const isLegacy = !block.pairs || typeof block.pairs !== 'object';
  const legacyPair = block.productId || DEFAULTS.productId;

  if (isLegacy && pair === legacyPair) {
    // Update flat regime in place
    const merged = { ...(block.regime || {}), ...updates };
    config.exchanges[exchange] = { ...block, regime: merged };
  } else {
    // Convert to nested form (idempotent if already nested)
    const normalized = normalizeExchangeBlock(block);
    if (!normalized.pairs[pair]) normalized.pairs[pair] = {};
    const merged = { ...(normalized.pairs[pair].regime || {}), ...updates };
    normalized.pairs[pair].regime = merged;
    config.exchanges[exchange] = normalized;
  }

  saveConfig(config);
  return config;
};

/**
 * Validate regime strategy configuration
 * @param {Partial<RegimeStrategyConfig>} config - Regime config to validate
 * @returns {ValidationResult}
 */
const validateRegimeConfig = (config) => {
  const { errors } = validateConfigUpdate(PRESET_FIELD_RULES, config);

  // Aggressiveness level validation
  if (config.aggressiveness !== undefined) {
    const validLevels = Object.keys(DEFAULT_AGGRESSIVENESS_PRESETS);
    if (!validLevels.includes(config.aggressiveness)) {
      errors.push('aggressiveness must be one of: conservative, moderate, aggressive, maximum');
    }
  }

  // Volatility Clock validation
  if (config.atrPeriod !== undefined && (config.atrPeriod < 5 || config.atrPeriod > 30)) {
    errors.push('atrPeriod must be between 5 and 30');
  }
  // Regime Detection validation
  if (config.momentumMult !== undefined && (config.momentumMult < 1.0 || config.momentumMult > 2.5)) {
    errors.push('momentumMult must be between 1.0 and 2.5');
  }
  if (config.volExpansionMult !== undefined && (config.volExpansionMult < 1.2 || config.volExpansionMult > 2.0)) {
    errors.push('volExpansionMult must be between 1.2 and 2.0');
  }

  // Position Sizing validation
  if (config.minOrderSizeUsdc !== undefined && (config.minOrderSizeUsdc < 1 || config.minOrderSizeUsdc > 100)) {
    errors.push('minOrderSizeUsdc must be between 1 and 100');
  }
  if (config.baseSizeUsdc !== undefined && (config.baseSizeUsdc < 1 || config.baseSizeUsdc > 1000)) {
    errors.push('baseSizeUsdc must be between 1 and 1000');
  }
  if (config.divergenceScalePct !== undefined && (config.divergenceScalePct < 0.5 || config.divergenceScalePct > 20)) {
    errors.push('divergenceScalePct must be between 0.5 and 20');
  }

  // Take-Profit validation
  if (config.tpMinPercent !== undefined && (config.tpMinPercent < 0.01 || config.tpMinPercent > 10.0)) {
    errors.push('tpMinPercent must be between 0.01 and 10.0');
  }
  if (config.tpMaxPercent !== undefined && (config.tpMaxPercent < 0.1 || config.tpMaxPercent > 50.0)) {
    errors.push('tpMaxPercent must be between 0.1 and 50.0');
  }
  if (config.holdbackRatio !== undefined && (config.holdbackRatio < 0.0 || config.holdbackRatio > 1.0)) {
    errors.push('holdbackRatio must be between 0.0 and 1.0');
  }

  // TP Auto-Management validation
  if (config.tpEvaluationCycles !== undefined && (config.tpEvaluationCycles < 1 || config.tpEvaluationCycles > 100)) {
    errors.push('tpEvaluationCycles must be between 1 and 100');
  }
  if (config.tpEvaluationMaxHours !== undefined && (config.tpEvaluationMaxHours < 1 || config.tpEvaluationMaxHours > 168)) {
    errors.push('tpEvaluationMaxHours must be between 1 and 168 (1 week)');
  }
  if (config.tpMinSampleSize !== undefined && (config.tpMinSampleSize < 3 || config.tpMinSampleSize > 100)) {
    errors.push('tpMinSampleSize must be between 3 and 100');
  }
  if (config.tpAbsoluteMin !== undefined && (config.tpAbsoluteMin < 0.01 || config.tpAbsoluteMin > 1.0)) {
    errors.push('tpAbsoluteMin must be between 0.01 and 1.0');
  }
  if (config.tpAbsoluteMax !== undefined && (config.tpAbsoluteMax < 1.0 || config.tpAbsoluteMax > 10.0)) {
    errors.push('tpAbsoluteMax must be between 1.0 and 10.0');
  }
  if (config.tpMaxChangePercent !== undefined && (config.tpMaxChangePercent < 5 || config.tpMaxChangePercent > 50)) {
    errors.push('tpMaxChangePercent must be between 5 and 50');
  }

  // Size Auto-Management validation
  if (config.sizeEvaluationCycles !== undefined && (config.sizeEvaluationCycles < 1 || config.sizeEvaluationCycles > 100)) {
    errors.push('sizeEvaluationCycles must be between 1 and 100');
  }
  if (config.sizeEvaluationMaxHours !== undefined && (config.sizeEvaluationMaxHours < 1 || config.sizeEvaluationMaxHours > 168)) {
    errors.push('sizeEvaluationMaxHours must be between 1 and 168 (1 week)');
  }
  if (config.sizeMinSampleSize !== undefined && (config.sizeMinSampleSize < 1 || config.sizeMinSampleSize > 50)) {
    errors.push('sizeMinSampleSize must be between 1 and 50');
  }
  if (config.sizeAbsoluteMinBase !== undefined && (config.sizeAbsoluteMinBase < 1 || config.sizeAbsoluteMinBase > 100)) {
    errors.push('sizeAbsoluteMinBase must be between 1 and 100');
  }
  if (config.sizeAbsoluteMaxBase !== undefined && (config.sizeAbsoluteMaxBase < 50 || config.sizeAbsoluteMaxBase > 2000)) {
    errors.push('sizeAbsoluteMaxBase must be between 50 and 2000');
  }
  if (config.sizeTargetUtilization !== undefined && (config.sizeTargetUtilization < 0.5 || config.sizeTargetUtilization > 0.99)) {
    errors.push('sizeTargetUtilization must be between 0.5 and 0.99');
  }
  if (config.sizeMaxChangePercent !== undefined && (config.sizeMaxChangePercent < 5 || config.sizeMaxChangePercent > 50)) {
    errors.push('sizeMaxChangePercent must be between 5 and 50');
  }
  if (config.sizeMinCycleBuys !== undefined && (config.sizeMinCycleBuys < 5 || config.sizeMinCycleBuys > 50)) {
    errors.push('sizeMinCycleBuys must be between 5 and 50');
  }
  if (config.sizeMaxCycleBuys !== undefined && (config.sizeMaxCycleBuys < 20 || config.sizeMaxCycleBuys > 200)) {
    errors.push('sizeMaxCycleBuys must be between 20 and 200');
  }

  // Legacy satellite config aliases silently accepted (mapped to celestial equivalents)

  // Celestial Hierarchy validation
  if (config.maxCelestialBodies !== undefined && (!Number.isInteger(config.maxCelestialBodies) || config.maxCelestialBodies < 1 || config.maxCelestialBodies > 15)) {
    errors.push('maxCelestialBodies must be an integer between 1 and 15');
  }

  // Ladder / Entry Mode validation
  if (config.entryMode !== undefined) {
    const allowedEntryModes = ['reactive', 'ladder'];
    if (!allowedEntryModes.includes(config.entryMode)) {
      errors.push(`entryMode must be one of: ${allowedEntryModes.join(', ')}`);
    }
  }
  if (config.ladderMaxAthDropPct !== undefined && (config.ladderMaxAthDropPct < 10 || config.ladderMaxAthDropPct > 95)) {
    errors.push('ladderMaxAthDropPct must be between 10 and 95');
  }
  if (config.ladderSpacingMode !== undefined) {
    const allowedSpacing = ['linear', 'sqrt', 'exponential'];
    if (!allowedSpacing.includes(config.ladderSpacingMode)) {
      errors.push(`ladderSpacingMode must be one of: ${allowedSpacing.join(', ')}`);
    }
  }
  if (config.ladderSizeMode !== undefined) {
    const allowedSizing = ['flat', 'linear', 'sqrt', 'fibonacci'];
    if (!allowedSizing.includes(config.ladderSizeMode)) {
      errors.push(`ladderSizeMode must be one of: ${allowedSizing.join(', ')}`);
    }
  }
  if (config.ladderMinSpacingPct !== undefined && (config.ladderMinSpacingPct < 0.01 || config.ladderMinSpacingPct > 5.0)) {
    errors.push('ladderMinSpacingPct must be between 0.01 and 5.0');
  }

  // Macro Regime validation
  if (config.macroHysteresis !== undefined && (config.macroHysteresis < 1 || config.macroHysteresis > 20)) {
    errors.push('macroHysteresis must be between 1 and 20');
  }
  if (config.macroDeclineThreshold !== undefined && config.macroAccumulationThreshold !== undefined
    && config.macroDeclineThreshold >= config.macroAccumulationThreshold) {
    errors.push('macroDeclineThreshold must be less than macroAccumulationThreshold');
  }
  if (config.macroAccumulationThreshold !== undefined && config.macroMarkupThreshold !== undefined
    && config.macroAccumulationThreshold >= config.macroMarkupThreshold) {
    errors.push('macroAccumulationThreshold must be less than macroMarkupThreshold');
  }
  if (config.macroUpdateIntervalMs !== undefined && (config.macroUpdateIntervalMs < 60000 || config.macroUpdateIntervalMs > 600000)) {
    errors.push('macroUpdateIntervalMs must be between 60000 (1 min) and 600000 (10 min)');
  }
  const macroMultFields = [
    'macroAccumulationSizeMult', 'macroAccumulationTpMult', 'macroAccumulationOffsetMult',
    'macroMarkupSizeMult', 'macroMarkupTpMult', 'macroMarkupOffsetMult',
    'macroDeclineSizeMult', 'macroDeclineTpMult', 'macroDeclineOffsetMult',
  ];
  for (const field of macroMultFields) {
    if (config[field] !== undefined && (config[field] < 0.1 || config[field] > 3.0)) {
      errors.push(`${field} must be between 0.1 and 3.0`);
    }
  }

  // Risk Caps validation
  if (config.maxAssetExposure !== undefined && config.maxAssetExposure !== 0 && (config.maxAssetExposure < 0.01 || config.maxAssetExposure > 10.0)) {
    errors.push('maxAssetExposure must be 0 (uncapped) or between 0.01 and 10.0');
  }
  if (config.depositedCapital !== undefined && config.depositedCapital !== 0 && config.depositedCapital < 100) {
    errors.push('depositedCapital must be 0 (auto-derive) or at least 100');
  }
  if (config.maxUsdcDeployed !== undefined && config.maxUsdcDeployed < 1000) {
    errors.push('maxUsdcDeployed must be at least 1000');
  }
  if (config.maxDrawdownPercent !== undefined && (config.maxDrawdownPercent < 10 || config.maxDrawdownPercent > 30)) {
    errors.push('maxDrawdownPercent must be between 10 and 30');
  }
  if (config.drawdownResetHours !== undefined && (config.drawdownResetHours < 0 || config.drawdownResetHours > 720)) {
    errors.push('drawdownResetHours must be between 0 (disabled) and 720 (30 days)');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
};

/**
 * Get notification configuration with defaults
 * @returns {Object} Notification config
 */
const getNotificationConfig = () => {
  const config = loadConfig();
  const notif = config.global?.notifications || {};
  return {
    ...NOTIFICATION_DEFAULTS,
    ...notif,
    telegram: { ...NOTIFICATION_DEFAULTS.telegram, ...notif.telegram },
    events: { ...NOTIFICATION_DEFAULTS.events, ...notif.events },
    quietHours: { ...NOTIFICATION_DEFAULTS.quietHours, ...notif.quietHours },
  };
};

/**
 * Get aggressiveness presets (user-customized merged with defaults)
 * @returns {Object} Presets keyed by level id
 */
const getAggressivenessPresets = () => {
  const config = loadConfig();
  const saved = config.global?.aggressivenessPresets || {};
  const merged = {};
  for (const level of Object.keys(DEFAULT_AGGRESSIVENESS_PRESETS)) {
    merged[level] = {
      ...DEFAULT_AGGRESSIVENESS_PRESETS[level],
      ...saved[level],
    };
  }
  return merged;
};

/**
 * Update aggressiveness presets
 * @param {Object} updates - Presets keyed by level id with partial param overrides
 * @returns {Object} Updated full configuration
 */
const updateAggressivenessPresets = (updates) => {
  const config = loadConfig();
  const current = config.global?.aggressivenessPresets || {};

  config.global = config.global || {};
  config.global.aggressivenessPresets = {};

  for (const level of Object.keys(DEFAULT_AGGRESSIVENESS_PRESETS)) {
    config.global.aggressivenessPresets[level] = {
      ...DEFAULT_AGGRESSIVENESS_PRESETS[level],
      ...current[level],
      ...updates[level],
    };
  }

  saveConfig(config);
  return config;
};

/**
 * Update notification configuration
 * @param {Object} updates - Notification config updates
 * @returns {Object} Updated full configuration
 */
const updateNotificationConfig = (updates) => {
  const config = loadConfig();
  const current = config.global?.notifications || {};

  config.global = config.global || {};
  config.global.notifications = {
    ...current,
    ...updates,
    telegram: updates.telegram
      ? { ...current.telegram, ...updates.telegram }
      : current.telegram,
    events: updates.events
      ? { ...current.events, ...updates.events }
      : current.events,
    quietHours: updates.quietHours
      ? { ...current.quietHours, ...updates.quietHours }
      : current.quietHours,
  };

  saveConfig(config);
  return config;
};

/**
 * Get backup configuration with defaults
 * @returns {Object} Backup config
 */
const getBackupConfig = () => {
  const config = loadConfig();
  const backup = config.global?.backup || {};
  return {
    ...GLOBAL_DEFAULTS.backup,
    ...backup,
  };
};

/**
 * Update backup configuration
 * @param {Object} updates - Backup config updates
 * @returns {Object} Updated full configuration
 */
const updateBackupConfig = (updates) => {
  const config = loadConfig();
  const current = config.global?.backup || {};

  config.global = config.global || {};
  config.global.backup = {
    ...GLOBAL_DEFAULTS.backup,
    ...current,
    ...updates,
  };

  saveConfig(config);
  return config;
};

/**
 * Default sentinel configuration
 */
const SENTINEL_DEFAULTS = {
  enabled: false,
  pollIntervalMs: 300000,
  maxAlerts: 200,
  aiClassification: { enabled: true, maxPerHour: 10 },
  feeds: [
    { name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml', enabled: true },
    { name: 'CNBC Economy', url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html', enabled: true },
  ],
  keywords: {
    critical: ['rate cut', 'rate hike', 'emergency', 'FOMC decision', 'quantitative easing', 'quantitative tightening', 'war declared', 'nuclear'],
    warning: ['FOMC', 'inflation', 'CPI', 'unemployment', 'tariff', 'sanctions', 'Iran', 'geopolitical', 'fed funds'],
    info: ['fed speech', 'treasury', 'GDP', 'economic data'],
  },
};

/**
 * Get sentinel configuration with defaults
 * @returns {Object} Sentinel config
 */
const getSentinelConfig = () => {
  const config = loadConfig();
  const sentinel = config.global?.sentinel || {};
  return {
    ...SENTINEL_DEFAULTS,
    ...sentinel,
    aiClassification: { ...SENTINEL_DEFAULTS.aiClassification, ...sentinel.aiClassification },
    keywords: { ...SENTINEL_DEFAULTS.keywords, ...sentinel.keywords },
    feeds: sentinel.feeds || SENTINEL_DEFAULTS.feeds,
  };
};

/**
 * Update sentinel configuration
 * @param {Object} updates - Sentinel config updates
 * @returns {Object} Updated full configuration
 */
const updateSentinelConfig = (updates) => {
  const config = loadConfig();
  const current = config.global?.sentinel || {};

  config.global = config.global || {};
  config.global.sentinel = {
    ...current,
    ...updates,
    aiClassification: updates.aiClassification
      ? { ...current.aiClassification, ...updates.aiClassification }
      : current.aiClassification,
    keywords: updates.keywords
      ? { ...current.keywords, ...updates.keywords }
      : current.keywords,
  };

  saveConfig(config);
  return config;
};

// ============================================================================
// Backup archive configuration snapshot (issue #430)
//
// data/config.json holds only the DIFF against the machine-local base
// config.json (or, on a fresh clone, the shipped config.example.json). An
// archive of the data directory alone therefore carries no fund identity at
// all when the operator's funds are defined in the base file: restoring onto a
// new machine silently adopts the destination's base — a different pair and a
// different allocation — while the restored state files describe the original
// fund.
//
// The archive fixes that by carrying a self-contained, schema-allowlisted
// snapshot of the EFFECTIVE configuration (every value already materialized,
// so it does not depend on any base file), which restore replays against
// whatever base the destination has.
// ============================================================================

/** Snapshot format version. Bump only for a breaking shape change. */
const CONFIG_SNAPSHOT_VERSION = 1;

/**
 * Fund-level fields carried by a snapshot. Allowlisted from the fund schema so
 * a stray/unknown key on disk — or a crafted archive — can never smuggle a
 * credential through the snapshot.
 */
const SNAPSHOT_FUND_KEYS = Object.freeze(Object.keys(DEFAULTS));

/** Regime (strategy) fields carried by a snapshot. */
const SNAPSHOT_REGIME_KEYS = Object.freeze(Object.keys(REGIME_DEFAULTS));

/**
 * Global fields carried by a snapshot.
 *
 * Deliberately EXCLUDES `notifications` and `sentinel`: those hold the Telegram
 * bot token and the AI-classification credentials. Restore leaves the
 * destination's own copies of both untouched.
 */
const SNAPSHOT_GLOBAL_KEYS = Object.freeze([
  ...Object.keys(GLOBAL_DEFAULTS),
  'aggressivenessPresets',
]);

/**
 * Copy only the allowlisted, defined keys of `source`, in allowlist order (so
 * two snapshots of equal content are structurally identical).
 * @param {Object|undefined} source
 * @param {ReadonlyArray<string>} keys
 * @returns {Object}
 */
const pickAllowed = (source, keys) => {
  const out = {};
  for (const key of keys) {
    if (source?.[key] !== undefined) out[key] = source[key];
  }
  return out;
};

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Build a self-contained snapshot of the effective non-secret configuration.
 *
 * @param {Object} config - A full (already merged) configuration object
 * @returns {{version: number, exchanges: Object, global: Object}} Snapshot
 */
const buildConfigSnapshot = (config) => {
  const normalized = normalizeToMultiExchange(isPlainObject(config) ? config : {});
  const exchanges = {};
  for (const [exchange, block] of Object.entries(normalized.exchanges || {})) {
    const pairs = {};
    for (const [pair, fundBlock] of Object.entries(normalizeExchangeBlock(block).pairs || {})) {
      const fund = pickAllowed(resolveFundConfig(normalized.global, fundBlock), SNAPSHOT_FUND_KEYS);
      // The pair key IS the fund identity; never let it drift from productId.
      fund.productId = fundBlock?.productId ?? pair;
      fund.regime = pickAllowed(resolveRegimeConfig(fundBlock), SNAPSHOT_REGIME_KEYS);
      pairs[pair] = fund;
    }
    // An exchange with no live funds is represented by its absence, which is
    // what reconstruction tombstones against the destination base.
    if (Object.keys(pairs).length > 0) exchanges[exchange] = { pairs };
  }
  return {
    version: CONFIG_SNAPSHOT_VERSION,
    exchanges,
    global: pickAllowed(normalized.global, SNAPSHOT_GLOBAL_KEYS),
  };
};

/**
 * Schema-validate a snapshot read back out of an archive.
 *
 * Strict by design: an unknown key is a rejection, not a value to pass through,
 * because the snapshot is replayed into the destination's live config file.
 *
 * @param {*} snapshot - Untrusted snapshot from an archive manifest
 * @returns {{valid: boolean, error?: string}}
 */
const validateConfigSnapshot = (snapshot) => {
  if (!isPlainObject(snapshot)) {
    return { valid: false, error: 'configuration snapshot is missing or is not an object' };
  }
  if (snapshot.version !== CONFIG_SNAPSHOT_VERSION) {
    return {
      valid: false,
      error: `configuration snapshot version ${JSON.stringify(snapshot.version)} is not supported by this build (expected ${CONFIG_SNAPSHOT_VERSION}) — upgrade critical-mass before restoring this archive`,
    };
  }
  if (!isPlainObject(snapshot.exchanges)) {
    return { valid: false, error: 'configuration snapshot has no `exchanges` object' };
  }
  if (snapshot.global !== undefined && !isPlainObject(snapshot.global)) {
    return { valid: false, error: 'configuration snapshot `global` is not an object' };
  }
  for (const key of Object.keys(snapshot.global || {})) {
    if (!SNAPSHOT_GLOBAL_KEYS.includes(key)) {
      return { valid: false, error: `configuration snapshot carries unsupported global field "${key}"` };
    }
  }
  const allowedFundKeys = new Set([...SNAPSHOT_FUND_KEYS, 'regime']);
  for (const [exchange, block] of Object.entries(snapshot.exchanges)) {
    if (!isPlainObject(block) || !isPlainObject(block.pairs)) {
      return { valid: false, error: `configuration snapshot entry for exchange "${exchange}" has no \`pairs\` object` };
    }
    for (const [pair, fund] of Object.entries(block.pairs)) {
      if (!PAIR_RE.test(pair)) {
        return { valid: false, error: `configuration snapshot has an invalid pair identifier "${exchange}/${pair}"` };
      }
      if (!isPlainObject(fund)) {
        return { valid: false, error: `configuration snapshot fund "${exchange}/${pair}" is not an object` };
      }
      if (typeof fund.productId !== 'string' || !fund.productId) {
        return { valid: false, error: `configuration snapshot fund "${exchange}/${pair}" has no productId` };
      }
      for (const key of Object.keys(fund)) {
        if (!allowedFundKeys.has(key)) {
          return { valid: false, error: `configuration snapshot fund "${exchange}/${pair}" carries unsupported field "${key}"` };
        }
      }
      if (fund.regime !== undefined) {
        if (!isPlainObject(fund.regime)) {
          return { valid: false, error: `configuration snapshot fund "${exchange}/${pair}" has a non-object regime block` };
        }
        for (const key of Object.keys(fund.regime)) {
          if (!SNAPSHOT_REGIME_KEYS.includes(key)) {
            return { valid: false, error: `configuration snapshot fund "${exchange}/${pair}" carries unsupported regime field "${key}"` };
          }
        }
      }
    }
  }
  return { valid: true };
};

/**
 * Resolution a merged config would produce for one fund if the override
 * carried NOTHING for it. Used to drop redundant keys from the reconstructed
 * override so a restore doesn't freeze a fully-materialized copy of every
 * setting into data/config.json (which would then shadow later edits to the
 * base config.json).
 *
 * Note the base's LEGACY-FLAT fields are deliberately ignored: the
 * reconstructed block always carries a `pairs` map, and `normalizeExchangeBlock`
 * only synthesizes a fund from flat fields when there is no `pairs` map at all.
 *
 * @param {Object|null} baseBlock - Destination base block for the exchange
 * @param {string} pair
 * @param {Object} globalConfig - The reconstructed `global` block
 * @returns {{fund: Object, regime: Object}}
 */
const resolveOverrideBaseline = (baseBlock, pair, globalConfig) => {
  const basePair = isPlainObject(baseBlock?.pairs) ? baseBlock.pairs[pair] : undefined;
  return {
    fund: resolveFundConfig(globalConfig, basePair),
    regime: resolveRegimeConfig(basePair),
  };
};

/**
 * Strip fund/regime keys the destination would resolve to the same value
 * anyway. Verified by the caller — on any mismatch the unpruned target wins.
 * @param {Object} target - Full reconstructed configuration
 * @param {Object} base - Destination base configuration
 * @returns {Object} Pruned clone of `target`
 */
const minimizeReconstructedTarget = (target, base) => {
  const pruned = structuredClone(target);
  for (const [exchange, block] of Object.entries(pruned.exchanges || {})) {
    const baseBlock = isPlainObject(base.exchanges?.[exchange]) ? base.exchanges[exchange] : null;
    for (const [pair, fund] of Object.entries(block.pairs || {})) {
      const baseline = resolveOverrideBaseline(baseBlock, pair, pruned.global);
      for (const key of Object.keys(fund)) {
        if (key !== 'regime' && key !== 'productId' && isDeepStrictEqual(fund[key], baseline.fund[key])) delete fund[key];
      }
      for (const key of Object.keys(fund.regime || {})) {
        if (isDeepStrictEqual(fund.regime[key], baseline.regime[key])) delete fund.regime[key];
      }
      if (fund.regime && Object.keys(fund.regime).length === 0) delete fund.regime;
    }
  }
  return pruned;
};

/**
 * Rebuild the base-relative override file (data/config.json) that makes the
 * DESTINATION reproduce the archived configuration.
 *
 * Pure — computes and verifies the result in memory so the caller can abort
 * before mutating anything on the destination.
 *
 * @param {Object} args
 * @param {*} args.snapshot - Snapshot from the archive manifest (validated here)
 * @param {Object} [args.baseConfig] - Destination's raw base config.json contents
 * @param {Object} [args.destinationGlobal] - Destination's effective `global` block,
 *   read BEFORE the restore, so its credentials (Telegram, Sentinel) survive.
 * @returns {{ok: true, override: Object} | {ok: false, error: string}}
 */
const reconstructConfigOverride = ({ snapshot, baseConfig, destinationGlobal }) => {
  const validation = validateConfigSnapshot(snapshot);
  if (!validation.valid) return { ok: false, error: validation.error };

  const base = isPlainObject(baseConfig) ? baseConfig : {};
  const target = structuredClone(base);
  target.exchanges = { ...(base.exchanges || {}) };

  const exchanges = new Set([...Object.keys(base.exchanges || {}), ...Object.keys(snapshot.exchanges)]);
  for (const exchange of exchanges) {
    const baseBlock = isPlainObject(base.exchanges?.[exchange]) ? base.exchanges[exchange] : null;
    const snapshotPairs = snapshot.exchanges[exchange]?.pairs || {};
    // computeDiff only emits keys present in the target, so a pair the base
    // defines but the source did not would merge straight back in. Tombstone it
    // instead — the same mechanism fund deletion uses (#441).
    const basePairs = isPlainObject(baseBlock?.pairs) ? Object.keys(baseBlock.pairs) : [];
    const tombstones = basePairs.filter((pair) => !(pair in snapshotPairs));
    const block = { ...(baseBlock || {}), pairs: structuredClone(snapshotPairs) };
    if (tombstones.length > 0 || (Array.isArray(baseBlock?.[DELETED_PAIRS_KEY]) && baseBlock[DELETED_PAIRS_KEY].length > 0)) {
      block[DELETED_PAIRS_KEY] = tombstones;
    } else {
      delete block[DELETED_PAIRS_KEY];
    }
    target.exchanges[exchange] = block;
  }

  // Non-secret globals come from the archive; everything else (notifications,
  // sentinel) stays on the destination's own effective values.
  target.global = deepMerge(
    isPlainObject(destinationGlobal) ? destinationGlobal : (base.global || {}),
    snapshot.global || {},
  );

  // Prove the round trip before the caller writes anything: replay each
  // candidate override through the exact merge+normalize path loadConfig uses
  // and re-derive a snapshot from it. Any drift (a base pair that survived, a
  // value the diff failed to carry) is caught here instead of silently trading
  // the wrong fund. The minimized candidate is preferred so the override file
  // stays a diff; the fully-materialized one is the fallback that always works.
  const reproduces = (candidate) =>
    isDeepStrictEqual(buildConfigSnapshot(deepMerge(base, candidate)).exchanges, snapshot.exchanges);

  for (const candidate of [minimizeReconstructedTarget(target, base), target]) {
    const override = computeDiff(base, candidate);
    if (reproduces(override)) return { ok: true, override };
  }

  const describe = (entry) => Object.keys(entry || {}).sort().join(', ') || 'none';
  const reproduced = buildConfigSnapshot(deepMerge(base, computeDiff(base, target)));
  return {
    ok: false,
    error: `restored configuration would not reproduce the archived funds (archived: ${describe(snapshot.exchanges)}; reconstructed: ${describe(reproduced.exchanges)}) — destination config left unchanged`,
  };
};

module.exports = {
  loadConfig,
  saveConfig,
  loadRawConfig,
  invalidateConfigCache,
  _resetConfigCacheForTests,
  getExchangeConfig,
  getEnabledExchanges,
  getConfiguredExchanges,
  updateExchangeConfig,
  updateGlobalConfig,
  setExchangeEnabled,
  setExchangeDryRun,
  validateExchangeConfig,
  getGlobalConfig,
  isMultiExchangeConfig,
  normalizeToMultiExchange,
  // Multi-pair (fund) helpers
  normalizeExchangeBlock,
  getDefaultPair,
  getConfiguredFunds,
  getFundsForExchange,
  resolveConfiguredPair,
  getEnabledFunds,
  getFundConfig,
  updateFundConfig,
  addFund,
  removeFund,
  // Regime strategy
  getRegimeConfig,
  updateRegimeConfig,
  validateRegimeConfig,
  // Notifications
  getNotificationConfig,
  updateNotificationConfig,
  // Aggressiveness presets
  getAggressivenessPresets,
  updateAggressivenessPresets,
  DEFAULT_AGGRESSIVENESS_PRESETS,
  // Backups
  getBackupConfig,
  updateBackupConfig,
  // Sentinel
  getSentinelConfig,
  updateSentinelConfig,
  SENTINEL_DEFAULTS,
  DEFAULTS,
  GLOBAL_DEFAULTS,
  REGIME_DEFAULTS,
  MERGE_PROXIMITY_BOUNDS,
  NOTIFICATION_DEFAULTS,
  // Currency parsing
  getBaseCurrency,
  getQuoteCurrency,
  productIdMatchesPair,
  // Backup archive config portability (#430)
  CONFIG_SNAPSHOT_VERSION,
  buildConfigSnapshot,
  validateConfigSnapshot,
  reconstructConfigOverride,
  writeUserConfigFile,
  resolveBaseConfigFile,
  USER_CONFIG_FILE,
  deepMerge,
  // Secret handling
  GLOBAL_KEYS_EXCLUDED_FROM_FUND_CONFIG,
  maskSecret,
  isMaskedSecret,
};
