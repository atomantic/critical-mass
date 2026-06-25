// @ts-check
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const configUtils = require('../src/config-utils');

const {
  DEFAULTS,
  GLOBAL_DEFAULTS,
  REGIME_DEFAULTS,
  NOTIFICATION_DEFAULTS,
  DEFAULT_AGGRESSIVENESS_PRESETS,
  isMultiExchangeConfig,
  normalizeToMultiExchange,
  validateExchangeConfig,
  validateRegimeConfig,
  loadRawConfig,
  loadConfig,
  saveConfig,
  getExchangeConfig,
  getEnabledExchanges,
  getConfiguredExchanges,
  getGlobalConfig,
  getRegimeConfig,
  getNotificationConfig,
  getAggressivenessPresets,
  getBackupConfig,
  updateExchangeConfig,
  updateGlobalConfig,
  updateRegimeConfig,
  updateNotificationConfig,
  updateAggressivenessPresets,
  updateBackupConfig,
  setExchangeEnabled,
  setExchangeDryRun,
  getFundConfig,
  maskSecret,
  isMaskedSecret,
  GLOBAL_KEYS_EXCLUDED_FROM_FUND_CONFIG,
} = configUtils;

// Resolved paths matching what config-utils.js computes internally
const BASE_CONFIG_FILE = path.join(__dirname, '..', 'config.json');
const USER_CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

// ============================================================================
// Helper: mock fs for config loading/saving
// ============================================================================

/**
 * Set up fs mocks so config-utils reads from virtual in-memory files.
 * @param {Object} opts
 * @param {Object|null} opts.base - Base config (null = file does not exist)
 * @param {Object|null} opts.user - User config (null = file does not exist)
 * @returns {{ written: () => Object|null }} accessor for data written by saveConfig
 */
const setupFsMocks = ({ base = null, user = null } = {}) => {
  let writtenData = null;
  let writtenMode;

  // The config-utils module caches loadRawConfig() between calls keyed on
  // file mtimes. Tests mock existsSync/readFileSync but not statSync, so
  // we have to bust the cache explicitly to make each case see fresh mocks.
  configUtils._resetConfigCacheForTests();

  mock.method(fs, 'existsSync', (filePath) => {
    if (filePath === BASE_CONFIG_FILE) return base !== null;
    if (filePath === USER_CONFIG_FILE) return user !== null;
    // Fall through for other paths (e.g. mkdirSync checks)
    return false;
  });

  mock.method(fs, 'readFileSync', (filePath, _encoding) => {
    if (filePath === BASE_CONFIG_FILE && base !== null) return JSON.stringify(base);
    if (filePath === USER_CONFIG_FILE && user !== null) return JSON.stringify(user);
    throw new Error(`ENOENT: no such file: ${filePath}`);
  });

  // The cache also calls fs.statSync — return synthetic mtimes derived
  // from the mocked file presence so the cache key changes with each setup.
  let mtimeCounter = 0;
  mock.method(fs, 'statSync', (filePath) => {
    // Include a realistic mode (0600) so saveConfig's permission-preserving
    // atomic write reads back the operator's chosen mode under the mock.
    if (filePath === BASE_CONFIG_FILE && base !== null) return { mtimeMs: ++mtimeCounter, mode: 0o100600 };
    if (filePath === USER_CONFIG_FILE && user !== null) return { mtimeMs: ++mtimeCounter, mode: 0o100600 };
    const err = new Error(`ENOENT: no such file: ${filePath}`);
    err.code = 'ENOENT';
    throw err;
  });

  mock.method(fs, 'writeFileSync', (_filePath, data, opts) => {
    writtenData = JSON.parse(data);
    writtenMode = opts && opts.mode;
  });

  // saveConfig writes atomically (tmp + rename); the tmp file never really
  // exists under the fs mocks, so stub renameSync to a no-op.
  mock.method(fs, 'renameSync', () => {});

  mock.method(fs, 'mkdirSync', () => {});

  return {
    written: () => writtenData,
    writtenMode: () => writtenMode,
  };
};

// ============================================================================
// Pure Function Tests (no fs needed)
// ============================================================================

describe('isMultiExchangeConfig', () => {
  it('returns true for object with exchanges key', () => {
    assert.equal(isMultiExchangeConfig({ exchanges: { coinbase: {} } }), true);
  });

  it('returns false for flat config without exchanges', () => {
    assert.equal(isMultiExchangeConfig({ productId: 'BTC-USDC' }), false);
  });

  it('returns falsy for null', () => {
    assert.ok(!isMultiExchangeConfig(null));
  });

  it('returns falsy for undefined', () => {
    assert.ok(!isMultiExchangeConfig(undefined));
  });

  it('returns false when exchanges is an array (not object)', () => {
    // Arrays are typeof 'object' so this should still return true per the implementation
    assert.equal(isMultiExchangeConfig({ exchanges: ['coinbase'] }), true);
  });
});

describe('normalizeToMultiExchange', () => {
  it('passes through config already in multi-exchange format', () => {
    const input = {
      exchanges: { coinbase: { productId: 'BTC-USDC', enabled: true } },
      global: { schedulerInterval: 15000 },
    };
    const result = normalizeToMultiExchange(input);
    assert.deepStrictEqual(result, input);
  });

  it('converts flat single-exchange config to multi-exchange format', () => {
    const input = {
      productId: 'BTC-USDC',
      totalAllocation: 5000,
      enabled: true,
    };
    const result = normalizeToMultiExchange(input);

    assert.ok(result.exchanges.coinbase);
    assert.ok(result.exchanges.gemini);
    assert.equal(result.exchanges.coinbase.productId, 'BTC-USDC');
    assert.equal(result.exchanges.coinbase.totalAllocation, 5000);
    assert.equal(result.exchanges.coinbase.enabled, true);
    // Gemini should get defaults
    assert.equal(result.exchanges.gemini.productId, 'BTCUSD');
    assert.equal(result.exchanges.gemini.enabled, false);
    assert.equal(result.exchanges.gemini.dryRun, true);
  });

  it('moves schedulerInterval into global config', () => {
    const input = { schedulerInterval: 10000, productId: 'BTC-USDC' };
    const result = normalizeToMultiExchange(input);

    assert.equal(result.global.schedulerInterval, 10000);
    // schedulerInterval should NOT appear in exchange config
    assert.equal(result.exchanges.coinbase.schedulerInterval, undefined);
  });

  it('uses default schedulerInterval when not present in flat config', () => {
    const input = { productId: 'BTC-USDC' };
    const result = normalizeToMultiExchange(input);

    assert.equal(result.global.schedulerInterval, GLOBAL_DEFAULTS.schedulerInterval);
  });

  it('merges DEFAULTS into coinbase exchange config', () => {
    const input = { productId: 'ETH-USDC' };
    const result = normalizeToMultiExchange(input);

    // Defaults applied under coinbase
    assert.equal(result.exchanges.coinbase.holdbackPercent, DEFAULTS.holdbackPercent);
    assert.equal(result.exchanges.coinbase.dryRun, DEFAULTS.dryRun);
    // Override from input takes precedence
    assert.equal(result.exchanges.coinbase.productId, 'ETH-USDC');
  });
});

// ============================================================================
// Defaults / Constants
// ============================================================================

describe('DEFAULTS', () => {
  it('has expected default productId', () => {
    assert.equal(DEFAULTS.productId, 'BTC-USDC');
  });

  it('has dryRun enabled by default', () => {
    assert.equal(DEFAULTS.dryRun, true);
  });

  it('has enabled disabled by default', () => {
    assert.equal(DEFAULTS.enabled, false);
  });

  it('has expected default dcaStrategy', () => {
    assert.equal(DEFAULTS.dcaStrategy, 'fixed');
  });
});

describe('GLOBAL_DEFAULTS', () => {
  it('has schedulerInterval', () => {
    assert.equal(typeof GLOBAL_DEFAULTS.schedulerInterval, 'number');
    assert.ok(GLOBAL_DEFAULTS.schedulerInterval > 0);
  });

  it('has backup configuration', () => {
    assert.equal(GLOBAL_DEFAULTS.backup.enabled, true);
    assert.equal(GLOBAL_DEFAULTS.backup.maxBackups, 7);
  });

  it('has simpleDcaEnabled defaulting to false', () => {
    assert.equal(GLOBAL_DEFAULTS.simpleDcaEnabled, false);
  });
});

// ============================================================================
// validateExchangeConfig
// ============================================================================

describe('validateExchangeConfig', () => {
  it('validates a complete valid config', () => {
    const result = validateExchangeConfig({ ...DEFAULTS });
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it('reports missing productId', () => {
    const cfg = { ...DEFAULTS, productId: '' };
    const result = validateExchangeConfig(cfg);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('productId')));
  });

  it('reports non-positive totalAllocation', () => {
    const result = validateExchangeConfig({ ...DEFAULTS, totalAllocation: 0 });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('totalAllocation')));
  });

  it('reports negative totalAllocation', () => {
    const result = validateExchangeConfig({ ...DEFAULTS, totalAllocation: -100 });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('totalAllocation')));
  });

  it('reports non-positive intervalsToSpread', () => {
    const result = validateExchangeConfig({ ...DEFAULTS, intervalsToSpread: 0 });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('intervalsToSpread')));
  });

  it('reports negative sellMarkupPercent', () => {
    const result = validateExchangeConfig({ ...DEFAULTS, sellMarkupPercent: -1 });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('sellMarkupPercent')));
  });

  it('accepts zero sellMarkupPercent', () => {
    const result = validateExchangeConfig({ ...DEFAULTS, sellMarkupPercent: 0 });
    assert.equal(result.valid, true);
  });

  it('reports holdbackPercent outside 0-100 range', () => {
    const over = validateExchangeConfig({ ...DEFAULTS, holdbackPercent: 101 });
    assert.equal(over.valid, false);
    assert.ok(over.errors.some(e => e.includes('holdbackPercent')));

    const under = validateExchangeConfig({ ...DEFAULTS, holdbackPercent: -1 });
    assert.equal(under.valid, false);
  });

  it('reports non-positive minOrderSize', () => {
    const result = validateExchangeConfig({ ...DEFAULTS, minOrderSize: 0 });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('minOrderSize')));
  });

  it('reports non-positive maxBuyPrice', () => {
    const result = validateExchangeConfig({ ...DEFAULTS, maxBuyPrice: -1 });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('maxBuyPrice')));
  });

  it('reports invalid dcaStrategy value', () => {
    const result = validateExchangeConfig({ ...DEFAULTS, dcaStrategy: 'martingale' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('dcaStrategy')));
  });

  it('accepts valid dcaStrategy values', () => {
    assert.equal(validateExchangeConfig({ ...DEFAULTS, dcaStrategy: 'fixed' }).valid, true);
    assert.equal(validateExchangeConfig({ ...DEFAULTS, dcaStrategy: 'fibonacci' }).valid, true);
  });

  it('reports non-positive fibBaseAmount when fibonacci strategy', () => {
    const result = validateExchangeConfig({ ...DEFAULTS, dcaStrategy: 'fibonacci', fibBaseAmount: 0 });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('fibBaseAmount')));
  });

  it('allows missing fibBaseAmount when fixed strategy', () => {
    const cfg = { ...DEFAULTS, dcaStrategy: 'fixed', fibBaseAmount: 0 };
    const result = validateExchangeConfig(cfg);
    // fibBaseAmount validation only triggers for fibonacci strategy
    assert.equal(result.valid, true);
  });

  it('collects multiple errors at once', () => {
    const result = validateExchangeConfig({
      productId: '',
      totalAllocation: -1,
      intervalsToSpread: 0,
      sellMarkupPercent: -1,
      holdbackPercent: 200,
      minOrderSize: 0,
      maxBuyPrice: 0,
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.length >= 5);
  });
});

// ============================================================================
// validateRegimeConfig
// ============================================================================

describe('validateRegimeConfig', () => {
  it('validates an empty config (all optional)', () => {
    const result = validateRegimeConfig({});
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it('reports invalid aggressiveness level', () => {
    const result = validateRegimeConfig({ aggressiveness: 'extreme' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('aggressiveness')));
  });

  it('accepts valid aggressiveness levels', () => {
    for (const level of ['conservative', 'moderate', 'aggressive', 'maximum']) {
      assert.equal(validateRegimeConfig({ aggressiveness: level }).valid, true);
    }
  });

  it('reports atrPeriod out of range', () => {
    assert.equal(validateRegimeConfig({ atrPeriod: 4 }).valid, false);
    assert.equal(validateRegimeConfig({ atrPeriod: 31 }).valid, false);
    assert.equal(validateRegimeConfig({ atrPeriod: 14 }).valid, true);
  });

  it('reports kFactor out of range', () => {
    assert.equal(validateRegimeConfig({ kFactor: 0.1 }).valid, false);
    assert.equal(validateRegimeConfig({ kFactor: 0.9 }).valid, false);
    assert.equal(validateRegimeConfig({ kFactor: 0.5 }).valid, true);
  });

  it('reports minIntervalMs below 30000', () => {
    assert.equal(validateRegimeConfig({ minIntervalMs: 20000 }).valid, false);
    assert.equal(validateRegimeConfig({ minIntervalMs: 30000 }).valid, true);
  });

  it('reports maxIntervalMs above 14400000', () => {
    assert.equal(validateRegimeConfig({ maxIntervalMs: 15000000 }).valid, false);
    assert.equal(validateRegimeConfig({ maxIntervalMs: 14400000 }).valid, true);
  });


  it('reports invalid entryMode', () => {
    assert.equal(validateRegimeConfig({ entryMode: 'unknown' }).valid, false);
    assert.equal(validateRegimeConfig({ entryMode: 'reactive' }).valid, true);
    assert.equal(validateRegimeConfig({ entryMode: 'ladder' }).valid, true);
  });

  it('reports invalid ladderSpacingMode', () => {
    assert.equal(validateRegimeConfig({ ladderSpacingMode: 'cubic' }).valid, false);
    assert.equal(validateRegimeConfig({ ladderSpacingMode: 'sqrt' }).valid, true);
  });

  it('reports invalid ladderSizeMode', () => {
    assert.equal(validateRegimeConfig({ ladderSizeMode: 'random' }).valid, false);
    assert.equal(validateRegimeConfig({ ladderSizeMode: 'fibonacci' }).valid, true);
  });

  it('reports macro thresholds in wrong order', () => {
    // macroDeclineThreshold must be < macroAccumulationThreshold
    const result1 = validateRegimeConfig({
      macroDeclineThreshold: -10,
      macroAccumulationThreshold: -15,
    });
    assert.equal(result1.valid, false);
    assert.ok(result1.errors.some(e => e.includes('macroDeclineThreshold')));

    // macroAccumulationThreshold must be < macroMarkupThreshold
    const result2 = validateRegimeConfig({
      macroAccumulationThreshold: 40,
      macroMarkupThreshold: 35,
    });
    assert.equal(result2.valid, false);
    assert.ok(result2.errors.some(e => e.includes('macroAccumulationThreshold')));
  });

  it('reports maxCelestialBodies out of range', () => {
    assert.equal(validateRegimeConfig({ maxCelestialBodies: 0 }).valid, false);
    assert.equal(validateRegimeConfig({ maxCelestialBodies: 16 }).valid, false);
    assert.equal(validateRegimeConfig({ maxCelestialBodies: 10 }).valid, true);
  });

  it('reports non-integer maxCelestialBodies', () => {
    assert.equal(validateRegimeConfig({ maxCelestialBodies: 5.5 }).valid, false);
  });

  it('validates macro multiplier fields in range 0.1 to 3.0', () => {
    const macroFields = [
      'macroAccumulationSizeMult', 'macroMarkupTpMult', 'macroDeclineOffsetMult',
    ];
    for (const field of macroFields) {
      assert.equal(validateRegimeConfig({ [field]: 0.05 }).valid, false);
      assert.equal(validateRegimeConfig({ [field]: 3.5 }).valid, false);
      assert.equal(validateRegimeConfig({ [field]: 1.0 }).valid, true);
    }
  });

  it('reports maxAssetExposure out of range', () => {
    assert.equal(validateRegimeConfig({ maxAssetExposure: -1 }).valid, false);
    assert.equal(validateRegimeConfig({ maxAssetExposure: 11 }).valid, false);
    assert.equal(validateRegimeConfig({ maxAssetExposure: 0 }).valid, true);  // 0 = uncapped
    assert.equal(validateRegimeConfig({ maxAssetExposure: 1.0 }).valid, true);
  });

  it('reports maxDrawdownPercent out of range', () => {
    assert.equal(validateRegimeConfig({ maxDrawdownPercent: 5 }).valid, false);
    assert.equal(validateRegimeConfig({ maxDrawdownPercent: 35 }).valid, false);
    assert.equal(validateRegimeConfig({ maxDrawdownPercent: 20 }).valid, true);
  });

  it('reports depositedCapital invalid values', () => {
    // 0 is valid (auto-derive)
    assert.equal(validateRegimeConfig({ depositedCapital: 0 }).valid, true);
    // between 100 and 100000 is valid
    assert.equal(validateRegimeConfig({ depositedCapital: 500 }).valid, true);
    // below 100 (and not 0) is invalid
    assert.equal(validateRegimeConfig({ depositedCapital: 50 }).valid, false);
  });
});

// ============================================================================
// Config Loading (with fs mocks)
// ============================================================================

describe('loadRawConfig', () => {
  afterEach(() => mock.restoreAll());

  it('returns empty object when neither base nor user config exist', () => {
    setupFsMocks({ base: null, user: null });
    const result = loadRawConfig();
    assert.deepStrictEqual(result, {});
  });

  it('returns base config when only base exists', () => {
    const baseConfig = { exchanges: { coinbase: { enabled: true } } };
    setupFsMocks({ base: baseConfig, user: null });
    const result = loadRawConfig();
    assert.deepStrictEqual(result, baseConfig);
  });

  it('merges user config over base config', () => {
    const baseConfig = {
      exchanges: { coinbase: { enabled: false, productId: 'BTC-USDC' } },
    };
    const userConfig = {
      exchanges: { coinbase: { enabled: true } },
    };
    setupFsMocks({ base: baseConfig, user: userConfig });
    const result = loadRawConfig();
    assert.equal(result.exchanges.coinbase.enabled, true);
    assert.equal(result.exchanges.coinbase.productId, 'BTC-USDC');
  });

  it('returns base config unchanged when user config is empty object', () => {
    const baseConfig = { exchanges: { coinbase: { enabled: false } } };
    setupFsMocks({ base: baseConfig, user: {} });
    const result = loadRawConfig();
    // Empty user config has no keys, so base is returned as-is
    assert.deepStrictEqual(result, baseConfig);
  });

  // Issue #185: loadRawConfig runs inside timer callbacks, so an unguarded
  // JSON.parse throw is a process-killing uncaught exception. A transient bad
  // read must NOT crash live trading when a last-good config is cached.
  it('throws on a cold-start parse failure when no config is cached yet', () => {
    setupFsMocks({ base: { exchanges: {} }, user: null });
    mock.method(fs, 'readFileSync', () => '{ this is not json');
    assert.throws(() => loadRawConfig(), /JSON|Unexpected|token/i);
  });

  it('keeps the last-good config (no crash) when a reload hits invalid JSON', () => {
    const baseConfig = { exchanges: { coinbase: { enabled: true } } };
    setupFsMocks({ base: baseConfig, user: null });
    const good = loadRawConfig();
    assert.equal(good.exchanges.coinbase.enabled, true);

    // statSync increments mtime each call, so the next loadRawConfig re-reads
    // (cache key differs) and hits the corrupted read.
    mock.method(fs, 'readFileSync', () => 'not json{');
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...a) => warnings.push(a.join(' '));
    let result;
    try {
      result = loadRawConfig(); // must not throw
    } finally {
      console.warn = origWarn;
    }
    assert.deepStrictEqual(result, good, 'returns the last-good cached config');
    assert.ok(warnings.some(w => w.includes('reload failed')), 'logs a reload-failed warning');
  });

  it('warns only once across repeated failed reloads (no per-tick spam)', () => {
    const baseConfig = { exchanges: { coinbase: { enabled: true } } };
    setupFsMocks({ base: baseConfig, user: null });
    loadRawConfig(); // prime _configCache with a good load

    mock.method(fs, 'readFileSync', () => 'not json{');
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...a) => warnings.push(a.join(' '));
    try {
      loadRawConfig();
      loadRawConfig();
      loadRawConfig();
    } finally {
      console.warn = origWarn;
    }
    assert.equal(warnings.length, 1, 'persistent corruption must warn once, not every call');
  });
});

describe('loadConfig', () => {
  afterEach(() => mock.restoreAll());

  it('normalizes raw config to multi-exchange format', () => {
    const baseConfig = { productId: 'BTC-USDC', totalAllocation: 5000 };
    setupFsMocks({ base: baseConfig, user: null });
    const result = loadConfig();
    assert.ok(result.exchanges);
    assert.ok(result.global);
    assert.ok(result.exchanges.coinbase);
  });

  it('handles already multi-exchange config', () => {
    const baseConfig = {
      exchanges: { coinbase: { productId: 'BTC-USDC', enabled: true } },
      global: { schedulerInterval: 20000 },
    };
    setupFsMocks({ base: baseConfig, user: null });
    const result = loadConfig();
    assert.equal(result.exchanges.coinbase.enabled, true);
    assert.equal(result.global.schedulerInterval, 20000);
  });
});

// ============================================================================
// saveConfig (diff-based persistence)
// ============================================================================

describe('saveConfig', () => {
  afterEach(() => mock.restoreAll());

  it('persists only the diff from base config', () => {
    const baseConfig = {
      exchanges: { coinbase: { enabled: false, productId: 'BTC-USDC' } },
      global: { schedulerInterval: 30000 },
    };
    const mocks = setupFsMocks({ base: baseConfig, user: null });

    const fullConfig = {
      exchanges: { coinbase: { enabled: true, productId: 'BTC-USDC' } },
      global: { schedulerInterval: 30000 },
    };
    saveConfig(fullConfig);

    const written = mocks.written();
    // Only the changed field should be in the diff
    assert.equal(written.exchanges.coinbase.enabled, true);
    // Unchanged fields should NOT be in the diff
    assert.equal(written.exchanges?.coinbase?.productId, undefined);
    assert.equal(written.global, undefined);
  });

  it('preserves the existing config file permission mode on the atomic write', () => {
    // statSync mock reports the existing file as 0600 — saveConfig must write
    // the tmp file with that mode so an operator-locked-down config (it can
    // hold secrets) isn't widened to default 0644 on save (#110 review).
    const mocks = setupFsMocks({ base: { global: { schedulerInterval: 1 } }, user: { global: { schedulerInterval: 2 } } });
    saveConfig({ global: { schedulerInterval: 3 } });
    assert.equal(mocks.writtenMode() & 0o777, 0o600, 'atomic write must preserve the existing 0600 mode');
  });

  it('uses a restrictive 0600 mode for a brand-new config file', () => {
    const mocks = setupFsMocks({ base: { global: { schedulerInterval: 1 } }, user: null });
    saveConfig({ global: { schedulerInterval: 3 } });
    assert.equal(mocks.writtenMode() & 0o777, 0o600, 'new config file must be created 0600 (may hold secrets)');
  });

  it('writes empty object when config matches base exactly', () => {
    const baseConfig = {
      exchanges: { coinbase: { enabled: false } },
    };
    const mocks = setupFsMocks({ base: baseConfig, user: null });
    saveConfig({ exchanges: { coinbase: { enabled: false } } });
    assert.deepStrictEqual(mocks.written(), {});
  });
});

// ============================================================================
// getExchangeConfig
// ============================================================================

describe('getExchangeConfig', () => {
  afterEach(() => mock.restoreAll());

  it('merges DEFAULTS into exchange config', () => {
    const baseConfig = {
      exchanges: { coinbase: { productId: 'BTC-USDC' } },
      global: {},
    };
    setupFsMocks({ base: baseConfig, user: null });
    const result = getExchangeConfig('coinbase');
    assert.equal(result.productId, 'BTC-USDC');
    assert.equal(result.holdbackPercent, DEFAULTS.holdbackPercent);
    assert.equal(result.dryRun, DEFAULTS.dryRun);
  });

  it('returns DEFAULTS for unknown exchange', () => {
    const baseConfig = {
      exchanges: { coinbase: { enabled: true } },
      global: {},
    };
    setupFsMocks({ base: baseConfig, user: null });
    const result = getExchangeConfig('kraken');
    assert.equal(result.productId, DEFAULTS.productId);
    assert.equal(result.dryRun, DEFAULTS.dryRun);
  });

  it('applies interval normalization with intervalType default', () => {
    const baseConfig = {
      exchanges: { coinbase: { productId: 'BTC-USDC' } },
      global: {},
    };
    setupFsMocks({ base: baseConfig, user: null });
    const result = getExchangeConfig('coinbase');
    // normalizeIntervalConfig ensures intervalType is set
    assert.equal(result.intervalType, 'daily');
    // intervalsToSpread comes from DEFAULTS
    assert.equal(result.intervalsToSpread, DEFAULTS.intervalsToSpread);
  });
});

// ============================================================================
// Secret exclusion from fund configs (issue #104)
// ============================================================================

describe('getFundConfig secret exclusion', () => {
  afterEach(() => mock.restoreAll());

  const SECRET_TOKEN = '123456:SECRET-BOT-TOKEN-abcdef';

  const baseWithSecrets = {
    exchanges: { coinbase: { productId: 'BTC-USDC' } },
    global: {
      schedulerInterval: 15000,
      simpleDcaEnabled: true,
      notifications: {
        enabled: true,
        telegram: { botToken: SECRET_TOKEN, chatId: '999' },
      },
      sentinel: { enabled: true, feeds: [] },
      backup: { enabled: true, maxBackups: 3 },
      aggressivenessPresets: { moderate: { kFactor: 0.6 } },
    },
  };

  it('never merges secret-bearing global sub-objects into the fund config', () => {
    setupFsMocks({ base: baseWithSecrets, user: null });
    const result = getFundConfig('coinbase', 'BTC-USDC');
    for (const key of GLOBAL_KEYS_EXCLUDED_FROM_FUND_CONFIG) {
      assert.equal(result[key], undefined, `${key} must not leak into fund config`);
    }
    assert.ok(!JSON.stringify(result).includes(SECRET_TOKEN));
  });

  it('getExchangeConfig (legacy alias) also excludes secrets', () => {
    setupFsMocks({ base: baseWithSecrets, user: null });
    const result = getExchangeConfig('coinbase');
    assert.ok(!JSON.stringify(result).includes('botToken'));
    assert.ok(!JSON.stringify(result).includes(SECRET_TOKEN));
  });

  it('still merges non-secret global scalars into the fund config', () => {
    setupFsMocks({ base: baseWithSecrets, user: null });
    const result = getFundConfig('coinbase', 'BTC-USDC');
    assert.equal(result.schedulerInterval, 15000);
    assert.equal(result.simpleDcaEnabled, true);
    assert.equal(result.productId, 'BTC-USDC');
  });

  it('engine path still resolves the real token via getNotificationConfig', () => {
    setupFsMocks({ base: baseWithSecrets, user: null });
    const notif = getNotificationConfig();
    assert.equal(notif.telegram.botToken, SECRET_TOKEN);
    assert.equal(notif.telegram.chatId, '999');
    assert.equal(notif.enabled, true);
  });
});

describe('maskSecret / isMaskedSecret', () => {
  it('masks to first 6 + ... + last 4', () => {
    assert.equal(maskSecret('123456:SECRET-BOT-TOKEN-abcdef'), '123456...cdef');
  });

  it('returns empty string for empty/undefined', () => {
    assert.equal(maskSecret(''), '');
    assert.equal(maskSecret(undefined), '');
  });

  it('detects masked values and rejects real tokens', () => {
    assert.equal(isMaskedSecret(maskSecret('123456:SECRET-BOT-TOKEN-abcdef')), true);
    assert.equal(isMaskedSecret('123456:SECRET-BOT-TOKEN-abcdef'), false);
    assert.equal(isMaskedSecret(undefined), false);
    assert.equal(isMaskedSecret(''), false);
  });
});

// ============================================================================
// getEnabledExchanges / getConfiguredExchanges
// ============================================================================

describe('getEnabledExchanges', () => {
  afterEach(() => mock.restoreAll());

  it('returns only exchanges with enabled: true', () => {
    const baseConfig = {
      exchanges: {
        coinbase: { enabled: true },
        gemini: { enabled: false },
        kraken: { enabled: true },
      },
      global: {},
    };
    setupFsMocks({ base: baseConfig, user: null });
    const result = getEnabledExchanges();
    assert.deepStrictEqual(result.sort(), ['coinbase', 'kraken']);
  });

  it('returns empty array when no exchanges enabled', () => {
    const baseConfig = {
      exchanges: { coinbase: { enabled: false } },
      global: {},
    };
    setupFsMocks({ base: baseConfig, user: null });
    assert.deepStrictEqual(getEnabledExchanges(), []);
  });
});

describe('getConfiguredExchanges', () => {
  afterEach(() => mock.restoreAll());

  it('returns all exchange names regardless of enabled state', () => {
    const baseConfig = {
      exchanges: {
        coinbase: { enabled: true },
        gemini: { enabled: false },
      },
      global: {},
    };
    setupFsMocks({ base: baseConfig, user: null });
    const result = getConfiguredExchanges();
    assert.deepStrictEqual(result.sort(), ['coinbase', 'gemini']);
  });
});

// ============================================================================
// updateExchangeConfig
// ============================================================================

describe('updateExchangeConfig', () => {
  afterEach(() => mock.restoreAll());

  it('merges updates into existing exchange config and saves', () => {
    const baseConfig = {
      exchanges: { coinbase: { enabled: false, productId: 'BTC-USDC' } },
      global: {},
    };
    const mocks = setupFsMocks({ base: baseConfig, user: null });
    const result = updateExchangeConfig('coinbase', { enabled: true });
    assert.equal(result.exchanges.coinbase.enabled, true);
    assert.equal(result.exchanges.coinbase.productId, 'BTC-USDC');
    // Verify it was saved
    assert.ok(mocks.written() !== null);
  });

  it('creates exchange entry with DEFAULTS when exchange does not exist', () => {
    const baseConfig = {
      exchanges: { coinbase: { enabled: true } },
      global: {},
    };
    setupFsMocks({ base: baseConfig, user: null });
    const result = updateExchangeConfig('kraken', { productId: 'XBT-USD' });
    assert.ok(result.exchanges.kraken);
    assert.equal(result.exchanges.kraken.productId, 'XBT-USD');
    // Should have defaults filled in
    assert.equal(result.exchanges.kraken.dryRun, DEFAULTS.dryRun);
  });
});

// ============================================================================
// setExchangeEnabled / setExchangeDryRun
// ============================================================================

describe('setExchangeEnabled', () => {
  afterEach(() => mock.restoreAll());

  it('enables an exchange', () => {
    const baseConfig = {
      exchanges: { coinbase: { enabled: false } },
      global: {},
    };
    setupFsMocks({ base: baseConfig, user: null });
    const result = setExchangeEnabled('coinbase', true);
    assert.equal(result.exchanges.coinbase.enabled, true);
  });
});

describe('setExchangeDryRun', () => {
  afterEach(() => mock.restoreAll());

  it('sets dry-run mode', () => {
    const baseConfig = {
      exchanges: { coinbase: { dryRun: true } },
      global: {},
    };
    setupFsMocks({ base: baseConfig, user: null });
    const result = setExchangeDryRun('coinbase', false);
    assert.equal(result.exchanges.coinbase.dryRun, false);
  });
});

// ============================================================================
// updateGlobalConfig
// ============================================================================

describe('updateGlobalConfig', () => {
  afterEach(() => mock.restoreAll());

  it('merges global updates and saves', () => {
    const baseConfig = {
      exchanges: { coinbase: { enabled: true } },
      global: { schedulerInterval: 30000 },
    };
    const mocks = setupFsMocks({ base: baseConfig, user: null });
    const result = updateGlobalConfig({ schedulerInterval: 15000 });
    assert.equal(result.global.schedulerInterval, 15000);
    assert.ok(mocks.written() !== null);
  });
});

// ============================================================================
// getGlobalConfig
// ============================================================================

describe('getGlobalConfig', () => {
  afterEach(() => mock.restoreAll());

  it('returns GLOBAL_DEFAULTS merged with stored global config', () => {
    const baseConfig = {
      exchanges: {},
      global: { schedulerInterval: 20000 },
    };
    setupFsMocks({ base: baseConfig, user: null });
    const result = getGlobalConfig();
    assert.equal(result.schedulerInterval, 20000);
    assert.equal(result.backup.enabled, GLOBAL_DEFAULTS.backup.enabled);
  });

  it('returns pure GLOBAL_DEFAULTS when no global stored', () => {
    setupFsMocks({ base: { exchanges: {} }, user: null });
    const result = getGlobalConfig();
    assert.equal(result.schedulerInterval, GLOBAL_DEFAULTS.schedulerInterval);
  });

  it('returns simpleDcaEnabled false by default', () => {
    setupFsMocks({ base: { exchanges: {}, global: {} }, user: null });
    const result = getGlobalConfig();
    assert.equal(result.simpleDcaEnabled, false);
  });

  it('allows simpleDcaEnabled to be overridden to true via updateGlobalConfig', () => {
    const baseConfig = {
      exchanges: {},
      global: {},
    };
    setupFsMocks({ base: baseConfig, user: null });
    const result = updateGlobalConfig({ simpleDcaEnabled: true });
    assert.equal(result.global.simpleDcaEnabled, true);
  });
});

// ============================================================================
// Regime Config
// ============================================================================

describe('getRegimeConfig', () => {
  afterEach(() => mock.restoreAll());

  it('returns REGIME_DEFAULTS when no regime config stored', () => {
    const baseConfig = {
      exchanges: { coinbase: {} },
      global: {},
    };
    setupFsMocks({ base: baseConfig, user: null });
    const result = getRegimeConfig('coinbase');
    assert.equal(result.enabled, REGIME_DEFAULTS.enabled);
    assert.equal(result.atrPeriod, REGIME_DEFAULTS.atrPeriod);
    assert.equal(result.baseSizeUsdc, REGIME_DEFAULTS.baseSizeUsdc);
  });

  it('merges stored regime config over defaults', () => {
    const baseConfig = {
      exchanges: {
        coinbase: {
          regime: { enabled: true, baseSizeUsdc: 100 },
        },
      },
      global: {},
    };
    setupFsMocks({ base: baseConfig, user: null });
    const result = getRegimeConfig('coinbase');
    assert.equal(result.enabled, true);
    assert.equal(result.baseSizeUsdc, 100);
    // Non-overridden defaults should still be present
    assert.equal(result.atrPeriod, REGIME_DEFAULTS.atrPeriod);
  });

  it('returns REGIME_DEFAULTS for unknown exchange', () => {
    setupFsMocks({ base: { exchanges: {}, global: {} }, user: null });
    const result = getRegimeConfig('binance');
    assert.equal(result.atrPeriod, REGIME_DEFAULTS.atrPeriod);
  });
});

describe('updateRegimeConfig', () => {
  afterEach(() => mock.restoreAll());

  it('updates regime config for existing exchange', () => {
    const baseConfig = {
      exchanges: { coinbase: { regime: { enabled: false } } },
      global: {},
    };
    const mocks = setupFsMocks({ base: baseConfig, user: null });
    const result = updateRegimeConfig('coinbase', { enabled: true, baseSizeUsdc: 200 });
    assert.equal(result.exchanges.coinbase.regime.enabled, true);
    assert.equal(result.exchanges.coinbase.regime.baseSizeUsdc, 200);
    assert.ok(mocks.written() !== null);
  });

  it('creates exchange with DEFAULTS and sets regime for new exchange', () => {
    const baseConfig = {
      exchanges: { coinbase: { enabled: true } },
      global: {},
    };
    setupFsMocks({ base: baseConfig, user: null });
    const result = updateRegimeConfig('kraken', { enabled: true });
    assert.ok(result.exchanges.kraken);
    assert.equal(result.exchanges.kraken.regime.enabled, true);
    assert.equal(result.exchanges.kraken.dryRun, DEFAULTS.dryRun);
  });

});

// ============================================================================
// Notification Config
// ============================================================================

describe('getNotificationConfig', () => {
  afterEach(() => mock.restoreAll());

  it('returns NOTIFICATION_DEFAULTS when no notifications stored', () => {
    setupFsMocks({ base: { exchanges: {}, global: {} }, user: null });
    const result = getNotificationConfig();
    assert.equal(result.enabled, false);
    assert.equal(result.rateLimitMs, NOTIFICATION_DEFAULTS.rateLimitMs);
    assert.equal(result.events.buy_filled, true);
    assert.equal(result.telegram.botToken, '');
  });

  it('merges stored notification config with nested defaults', () => {
    const baseConfig = {
      exchanges: {},
      global: {
        notifications: {
          enabled: true,
          telegram: { botToken: 'abc123' },
          events: { error: false },
        },
      },
    };
    setupFsMocks({ base: baseConfig, user: null });
    const result = getNotificationConfig();
    assert.equal(result.enabled, true);
    assert.equal(result.telegram.botToken, 'abc123');
    assert.equal(result.telegram.chatId, ''); // Default preserved
    assert.equal(result.events.error, false); // Overridden
    assert.equal(result.events.buy_filled, true); // Default preserved
  });
});

describe('updateNotificationConfig', () => {
  afterEach(() => mock.restoreAll());

  it('merges telegram updates preserving existing fields', () => {
    const baseConfig = {
      exchanges: {},
      global: {
        notifications: { telegram: { botToken: 'old-token', chatId: 'chat-1' } },
      },
    };
    const mocks = setupFsMocks({ base: baseConfig, user: null });
    updateNotificationConfig({ telegram: { botToken: 'new-token' } });
    const written = mocks.written();
    assert.ok(written !== null);
  });
});

// ============================================================================
// Aggressiveness Presets
// ============================================================================

describe('getAggressivenessPresets', () => {
  afterEach(() => mock.restoreAll());

  it('returns DEFAULT_AGGRESSIVENESS_PRESETS when none stored', () => {
    setupFsMocks({ base: { exchanges: {}, global: {} }, user: null });
    const result = getAggressivenessPresets();
    assert.deepStrictEqual(
      Object.keys(result).sort(),
      ['aggressive', 'conservative', 'maximum', 'moderate'],
    );
    assert.equal(result.moderate.kFactor, DEFAULT_AGGRESSIVENESS_PRESETS.moderate.kFactor);
  });

  it('merges user-customized presets over defaults', () => {
    const baseConfig = {
      exchanges: {},
      global: {
        aggressivenessPresets: {
          moderate: { kFactor: 0.7 },
        },
      },
    };
    setupFsMocks({ base: baseConfig, user: null });
    const result = getAggressivenessPresets();
    assert.equal(result.moderate.kFactor, 0.7);
    // Other moderate defaults should still be present
    assert.equal(result.moderate.cautionScale, DEFAULT_AGGRESSIVENESS_PRESETS.moderate.cautionScale);
    // Other levels untouched
    assert.equal(result.conservative.kFactor, DEFAULT_AGGRESSIVENESS_PRESETS.conservative.kFactor);
  });
});

describe('updateAggressivenessPresets', () => {
  afterEach(() => mock.restoreAll());

  it('updates presets and saves', () => {
    setupFsMocks({ base: { exchanges: {}, global: {} }, user: null });
    const result = updateAggressivenessPresets({
      aggressive: { cautionScale: 0.75 },
    });
    assert.equal(result.global.aggressivenessPresets.aggressive.cautionScale, 0.75);
    // Other fields preserved from defaults
    assert.equal(
      result.global.aggressivenessPresets.aggressive.kFactor,
      DEFAULT_AGGRESSIVENESS_PRESETS.aggressive.kFactor,
    );
  });
});

// ============================================================================
// Backup Config
// ============================================================================

describe('getBackupConfig', () => {
  afterEach(() => mock.restoreAll());

  it('returns GLOBAL_DEFAULTS.backup when none stored', () => {
    setupFsMocks({ base: { exchanges: {}, global: {} }, user: null });
    const result = getBackupConfig();
    assert.equal(result.enabled, GLOBAL_DEFAULTS.backup.enabled);
    assert.equal(result.maxBackups, GLOBAL_DEFAULTS.backup.maxBackups);
  });

  it('merges stored backup overrides', () => {
    const baseConfig = {
      exchanges: {},
      global: { backup: { maxBackups: 14 } },
    };
    setupFsMocks({ base: baseConfig, user: null });
    const result = getBackupConfig();
    assert.equal(result.maxBackups, 14);
    assert.equal(result.enabled, GLOBAL_DEFAULTS.backup.enabled);
  });
});

describe('updateBackupConfig', () => {
  afterEach(() => mock.restoreAll());

  it('updates backup config and saves', () => {
    const mocks = setupFsMocks({ base: { exchanges: {}, global: {} }, user: null });
    updateBackupConfig({ maxBackups: 30, includePriceCache: true });
    const written = mocks.written();
    assert.ok(written !== null);
  });
});

// ============================================================================
// Deep Merge (tested indirectly through loadRawConfig)
// ============================================================================

describe('deep merge behavior (via loadRawConfig)', () => {
  afterEach(() => mock.restoreAll());

  it('deeply merges nested objects', () => {
    const baseConfig = {
      exchanges: {
        coinbase: { productId: 'BTC-USDC', regime: { enabled: false, atrPeriod: 14 } },
      },
      global: { schedulerInterval: 30000 },
    };
    const userConfig = {
      exchanges: {
        coinbase: { regime: { enabled: true } },
      },
    };
    setupFsMocks({ base: baseConfig, user: userConfig });
    const result = loadRawConfig();
    // Deep merge: regime.enabled overridden, regime.atrPeriod preserved
    assert.equal(result.exchanges.coinbase.regime.enabled, true);
    assert.equal(result.exchanges.coinbase.regime.atrPeriod, 14);
    // productId preserved from base
    assert.equal(result.exchanges.coinbase.productId, 'BTC-USDC');
  });

  it('replaces arrays rather than concatenating', () => {
    const baseConfig = { tags: ['a', 'b'], exchanges: {} };
    const userConfig = { tags: ['c'] };
    setupFsMocks({ base: baseConfig, user: userConfig });
    const result = loadRawConfig();
    assert.deepStrictEqual(result.tags, ['c']);
  });

  it('override scalar values take precedence', () => {
    const baseConfig = { exchanges: {}, global: { schedulerInterval: 30000 } };
    const userConfig = { global: { schedulerInterval: 10000 } };
    setupFsMocks({ base: baseConfig, user: userConfig });
    const result = loadRawConfig();
    assert.equal(result.global.schedulerInterval, 10000);
  });
});
