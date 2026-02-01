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
  DEFAULTS,
  GLOBAL_DEFAULTS,
};
