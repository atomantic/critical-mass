// @ts-check
/**
 * Configuration Utilities
 *
 * Handles loading, validation, and normalization of multi-exchange configuration.
 * Supports backward compatibility with single-exchange config format.
 */

const fs = require('fs');
const path = require('path');
const { normalizeConfig: normalizeIntervalConfig } = require('./interval-utils');

/**
 * @typedef {import('./types').ExchangeConfig} ExchangeConfig
 * @typedef {import('./types').GlobalConfig} GlobalConfig
 * @typedef {import('./types').MultiExchangeConfig} MultiExchangeConfig
 * @typedef {import('./types').ValidationResult} ValidationResult
 * @typedef {import('./types').RegimeStrategyConfig} RegimeStrategyConfig
 */

const BASE_CONFIG_FILE = path.join(__dirname, '..', 'config.json');
const USER_CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

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
  reconcileIntervalMs: 300000,

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
 * Default aggressiveness preset definitions
 * These define the parameter values for each aggressiveness level.
 */
const DEFAULT_AGGRESSIVENESS_PRESETS = {
  conservative: {
    kFactor: 0.8,
    minIntervalMs: 180000,
    maxIntervalMs: 7200000,
    entryOffsetBps: 25,
    cautionScale: 0.15,
    trendScale: 0,
    maxCycleBuys: 10,
  },
  moderate: {
    kFactor: 0.65,
    minIntervalMs: 120000,
    maxIntervalMs: 3600000,
    entryOffsetBps: 18,
    cautionScale: 0.35,
    trendScale: 0.1,
    maxCycleBuys: 15,
  },
  aggressive: {
    kFactor: 0.5,
    minIntervalMs: 90000,
    maxIntervalMs: 2400000,
    entryOffsetBps: 12,
    cautionScale: 0.6,
    trendScale: 0.25,
    maxCycleBuys: 25,
  },
  maximum: {
    kFactor: 0.3,
    minIntervalMs: 60000,
    maxIntervalMs: 1200000,
    entryOffsetBps: 5,
    cautionScale: 1.0,
    trendScale: 0.5,
    maxCycleBuys: 50,
  },
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

/**
 * Load raw configuration from base config, with user overrides from data/config.json merged on top
 * @returns {Object} Raw configuration object
 */
const loadRawConfig = () => {
  const base = fs.existsSync(BASE_CONFIG_FILE)
    ? JSON.parse(fs.readFileSync(BASE_CONFIG_FILE, 'utf8'))
    : {};
  const user = fs.existsSync(USER_CONFIG_FILE)
    ? JSON.parse(fs.readFileSync(USER_CONFIG_FILE, 'utf8'))
    : {};
  return Object.keys(user).length ? deepMerge(base, user) : base;
};

/**
 * Save configuration to user config file (data/config.json).
 * Only persists the diff (overrides) from the base config.
 * @param {MultiExchangeConfig} config - Full merged configuration to save
 * @returns {void}
 */
const saveConfig = (config) => {
  const base = fs.existsSync(BASE_CONFIG_FILE)
    ? JSON.parse(fs.readFileSync(BASE_CONFIG_FILE, 'utf8'))
    : {};
  const diff = computeDiff(base, config);
  fs.mkdirSync(path.dirname(USER_CONFIG_FILE), { recursive: true });
  fs.writeFileSync(USER_CONFIG_FILE, JSON.stringify(diff, null, 2));
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
 * @returns {MultiExchangeConfig} Normalized multi-exchange configuration
 */
const loadConfig = () => {
  const raw = loadRawConfig();
  return normalizeToMultiExchange(raw);
};

/**
 * Get configuration for a specific exchange
 * @param {string} exchange - Exchange name
 * @returns {ExchangeConfig} Exchange configuration with defaults applied
 */
const getExchangeConfig = (exchange) => {
  const config = loadConfig();
  const exchangeConfig = config.exchanges?.[exchange] || {};

  // Merge with defaults and global settings
  const merged = {
    ...DEFAULTS,
    ...config.global,
    ...exchangeConfig,
  };

  // Apply interval normalization
  return normalizeIntervalConfig(merged);
};

/**
 * Get list of enabled exchanges
 * @returns {string[]} List of enabled exchange names
 */
const getEnabledExchanges = () => {
  const config = loadConfig();
  return Object.entries(config.exchanges || {})
    .filter(([_, cfg]) => cfg.enabled === true)
    .map(([name]) => name);
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
 * Update configuration for a specific exchange
 * @param {string} exchange - Exchange name
 * @param {Partial<ExchangeConfig>} updates - Configuration updates
 * @returns {MultiExchangeConfig} Updated full configuration
 */
const updateExchangeConfig = (exchange, updates) => {
  const config = loadConfig();

  if (!config.exchanges[exchange]) {
    config.exchanges[exchange] = { ...DEFAULTS };
  }

  config.exchanges[exchange] = {
    ...config.exchanges[exchange],
    ...updates,
  };

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
 * Enable or disable an exchange
 * @param {string} exchange - Exchange name
 * @param {boolean} enabled - Whether to enable
 * @returns {MultiExchangeConfig} Updated configuration
 */
const setExchangeEnabled = (exchange, enabled) => {
  return updateExchangeConfig(exchange, { enabled });
};

/**
 * Set dry-run mode for an exchange
 * @param {string} exchange - Exchange name
 * @param {boolean} dryRun - Whether to enable dry-run
 * @returns {MultiExchangeConfig} Updated configuration
 */
const setExchangeDryRun = (exchange, dryRun) => {
  return updateExchangeConfig(exchange, { dryRun });
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
 * Get regime strategy configuration for an exchange
 * @param {string} exchange - Exchange name
 * @returns {RegimeStrategyConfig} Regime configuration with defaults applied
 */
const getRegimeConfig = (exchange) => {
  const config = loadConfig();
  const exchangeConfig = config.exchanges?.[exchange] || {};
  const regimeConfig = exchangeConfig.regime || {};

  const merged = {
    ...REGIME_DEFAULTS,
    ...regimeConfig,
  };
  // Migrate old config key from disk
  const _oldKey = 'max' + 'BtcExposure'; // constructed to avoid refactoring scripts
  if (_oldKey in merged) {
    merged.maxAssetExposure = merged[_oldKey];
    delete merged[_oldKey];
  }
  return merged;
};

/**
 * Update regime configuration for an exchange
 * @param {string} exchange - Exchange name
 * @param {Partial<RegimeStrategyConfig>} updates - Regime config updates
 * @returns {MultiExchangeConfig} Updated full configuration
 */
const updateRegimeConfig = (exchange, updates) => {
  const config = loadConfig();

  if (!config.exchanges[exchange]) {
    config.exchanges[exchange] = { ...DEFAULTS };
  }

  const merged = {
    ...(config.exchanges[exchange].regime || {}),
    ...updates,
  };

  config.exchanges[exchange].regime = merged;

  saveConfig(config);
  return config;
};

/**
 * Validate regime strategy configuration
 * @param {Partial<RegimeStrategyConfig>} config - Regime config to validate
 * @returns {ValidationResult}
 */
const validateRegimeConfig = (config) => {
  const errors = [];

  // Aggressiveness level validation
  if (config.aggressiveness !== undefined) {
    const validLevels = ['conservative', 'moderate', 'aggressive', 'maximum'];
    if (!validLevels.includes(config.aggressiveness)) {
      errors.push('aggressiveness must be one of: conservative, moderate, aggressive, maximum');
    }
  }

  // Volatility Clock validation
  if (config.atrPeriod !== undefined && (config.atrPeriod < 5 || config.atrPeriod > 30)) {
    errors.push('atrPeriod must be between 5 and 30');
  }
  if (config.kFactor !== undefined && (config.kFactor < 0.2 || config.kFactor > 0.8)) {
    errors.push('kFactor must be between 0.2 and 0.8');
  }
  if (config.minIntervalMs !== undefined && config.minIntervalMs < 30000) {
    errors.push('minIntervalMs must be at least 30000 (30 seconds)');
  }
  if (config.maxIntervalMs !== undefined && config.maxIntervalMs > 14400000) {
    errors.push('maxIntervalMs must not exceed 14400000 (4 hours)');
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
  if (config.maxCycleBuys !== undefined && (config.maxCycleBuys < 3 || config.maxCycleBuys > 1000)) {
    errors.push('maxCycleBuys must be between 3 and 1000');
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

/**
 * Get Kalshi configuration
 * Reads the top-level kalshi section from config.json
 * @returns {{ enabled: boolean }}
 */
const getKalshiConfig = () => {
  const raw = loadRawConfig();
  return {
    enabled: false,
    ...raw.kalshi,
  };
};

/**
 * Default hedge configuration
 */
const HEDGE_DEFAULTS = {
  enabled: false,
  dryRun: true,
  exchange: 'coinbase',
  productId: 'BTC-USDC',
  kalshi: {
    allowedSeries: ['KXBTC15M', 'KXBTC'],
    maxPremiumCents: 50,
    maxContracts: 100,
    maxSlippageCents: 3,
    hedgeRatio: 1.0,
  },
  position: {
    btcAmount: 0.05,
    minBtcAmount: 0.01,
    maxBtcAmount: 1.0,
  },
  exitMode: 'hybrid',
  stopLoss: {
    percentFromEntry: 1.0,
    slippageBps: 10,
  },
  takeProfit: {
    mode: 'software',
    percentFromEntry: 0.5,
    trailingEnabled: false,
    trailingActivationPct: 0.3,
    trailingStepPct: 0.1,
  },
  entry: {
    minVolatility15m: 0.003,
    maxVolatility15m: 0.03,
    minExpectedProfit: 5,
    maxSpreadBps: 20,
    cooldownMs: 900000,
  },
  holdBeyondSettlement: false,
  risk: {
    maxDailyLoss: 200,
    maxOpenPairs: 1,
    maxDailyPairs: 10,
    circuitBreakerConsecutiveLosses: 3,
  },
  fees: {
    exchangeMakerBps: 5,
    exchangeTakerBps: 10,
    kalshiTakerCoeff: 0.07,
  },
};

/**
 * Get hedge engine configuration with defaults
 * @returns {Object} Hedge config with defaults applied
 */
const getHedgeConfig = () => {
  const raw = loadRawConfig();
  const userHedge = raw.hedge || {};
  return {
    ...HEDGE_DEFAULTS,
    ...userHedge,
    kalshi: { ...HEDGE_DEFAULTS.kalshi, ...userHedge.kalshi },
    position: { ...HEDGE_DEFAULTS.position, ...userHedge.position },
    stopLoss: { ...HEDGE_DEFAULTS.stopLoss, ...userHedge.stopLoss },
    takeProfit: { ...HEDGE_DEFAULTS.takeProfit, ...userHedge.takeProfit },
    entry: { ...HEDGE_DEFAULTS.entry, ...userHedge.entry },
    risk: { ...HEDGE_DEFAULTS.risk, ...userHedge.risk },
    fees: { ...HEDGE_DEFAULTS.fees, ...userHedge.fees },
  };
};

/**
 * Update hedge configuration
 * @param {Object} updates - Hedge config updates
 * @returns {void}
 */
const updateHedgeConfig = (updates) => {
  const config = loadConfig();
  const raw = loadRawConfig();
  const current = raw.hedge || {};

  const merged = deepMerge(current, updates);
  // Store hedge at top level (same as kalshi)
  const fullConfig = { ...config, hedge: merged };
  saveConfig(fullConfig);
};

module.exports = {
  loadConfig,
  saveConfig,
  loadRawConfig,
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
  // Kalshi
  getKalshiConfig,
  // Hedge
  getHedgeConfig,
  updateHedgeConfig,
  HEDGE_DEFAULTS,
  // Sentinel
  getSentinelConfig,
  updateSentinelConfig,
  SENTINEL_DEFAULTS,
  DEFAULTS,
  GLOBAL_DEFAULTS,
  REGIME_DEFAULTS,
  NOTIFICATION_DEFAULTS,
};
