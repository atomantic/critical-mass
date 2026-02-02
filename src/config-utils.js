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

const CONFIG_FILE = path.join(__dirname, '..', 'config.json');

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
  dryRun: true,

  // Volatility Clock
  atrPeriod: 14,
  kFactor: 0.6,
  minIntervalMs: 60000,
  maxIntervalMs: 3600000,

  // Regime Detection
  momentumMult: 1.5,
  volExpansionMult: 1.5,
  volContractionMult: 1.2,
  vwapPeriodHours: 4,
  trendConfirmationPeriods: 5,

  // Position Sizing
  baseSizeUsdc: 50,
  harvestScale: 1.0,
  cautionScale: 0.5,
  trendScale: 0.0,
  maxLadderSteps: 10,
  ladderResetHours: 72, // Auto-reset ladder counter after 72 hours (3 days) at max, 0 to disable
  liquidityFactorCap: 2.0,

  // Take-Profit
  tpMult: 1.0,
  tpMinPercent: 2.0,
  tpMaxPercent: 15.0,
  tpUpdateThresholdPct: 0.5,
  holdbackRatio: 0.5,

  // TP Auto-Management
  tpAutoManaged: false,         // Opt-in flag for dynamic TP adjustment
  tpEvaluationCycles: 5,        // Evaluate every N cycles
  tpEvaluationMaxHours: 24,     // Or at least once per day
  tpMinSampleSize: 10,          // Minimum cycles before adjusting
  tpAbsoluteMin: 0.05,          // Floor for tpMinPercent
  tpAbsoluteMax: 5.0,           // Ceiling for tpMaxPercent
  tpMaxChangePercent: 25,       // Max % change per adjustment

  // Risk Caps
  maxBtcExposure: 0.5,
  maxUsdcDeployed: 10000,
  maxDrawdownPercent: 20,
  drawdownResetHours: 72, // Auto-reset peak after 72 hours (3 days) of drawdown pause

  // Order Execution
  entryOffsetBps: 10,
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
  maxOpenOrders: 3,
  reconcileIntervalMs: 300000,

  // Tail Events
  maxSpreadBps: 50,
  spreadPauseMs: 300000,
  minDepthUsdc: 10000,
  depthPauseMs: 300000,
  flashMoveMult: 3.0,
  flashCooldownMs: 600000,
  cancelEntriesOnFlash: true,
};

/**
 * Global default configuration
 * @type {GlobalConfig}
 */
const GLOBAL_DEFAULTS = {
  schedulerInterval: 30000,
};

/**
 * Load raw configuration from file
 * @returns {Object} Raw configuration object
 */
const loadRawConfig = () => {
  if (!fs.existsSync(CONFIG_FILE)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
};

/**
 * Save configuration to file
 * @param {MultiExchangeConfig} config - Configuration to save
 * @returns {void}
 */
const saveConfig = (config) => {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
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

  return {
    ...REGIME_DEFAULTS,
    ...regimeConfig,
  };
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

  config.exchanges[exchange].regime = {
    ...(config.exchanges[exchange].regime || {}),
    ...updates,
  };

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

  // Volatility Clock validation
  if (config.atrPeriod !== undefined && (config.atrPeriod < 5 || config.atrPeriod > 30)) {
    errors.push('atrPeriod must be between 5 and 30');
  }
  if (config.kFactor !== undefined && (config.kFactor < 0.4 || config.kFactor > 0.8)) {
    errors.push('kFactor must be between 0.4 and 0.8');
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
  if (config.baseSizeUsdc !== undefined && (config.baseSizeUsdc < 1 || config.baseSizeUsdc > 1000)) {
    errors.push('baseSizeUsdc must be between 1 and 1000');
  }
  if (config.maxLadderSteps !== undefined && (config.maxLadderSteps < 3 || config.maxLadderSteps > 50)) {
    errors.push('maxLadderSteps must be between 3 and 50');
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

  // Risk Caps validation
  if (config.maxBtcExposure !== undefined && (config.maxBtcExposure < 0.01 || config.maxBtcExposure > 10.0)) {
    errors.push('maxBtcExposure must be between 0.01 and 10.0');
  }
  if (config.maxUsdcDeployed !== undefined && (config.maxUsdcDeployed < 1000 || config.maxUsdcDeployed > 100000)) {
    errors.push('maxUsdcDeployed must be between 1000 and 100000');
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
  DEFAULTS,
  GLOBAL_DEFAULTS,
  REGIME_DEFAULTS,
};
