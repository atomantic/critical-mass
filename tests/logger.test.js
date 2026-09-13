const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { log, createContextLogger } = require('../src/logger');

/**
 * Stub console.log/warn/error and record which channel each call landed on.
 * @returns {{ calls: Array<{channel: 'log'|'warn'|'error', line: string}>, restore: () => void }}
 */
const captureConsole = () => {
  const calls = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = line => calls.push({ channel: 'log', line });
  console.warn = line => calls.push({ channel: 'warn', line });
  console.error = line => calls.push({ channel: 'error', line });
  return {
    calls,
    restore: () => {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
    },
  };
};

describe('structured logger', () => {
  it('routes contextual ERROR to console.error while preserving legacy operator text and merged context', () => {
    const capture = captureConsole();

    try {
      const logger = createContextLogger({ exchange: 'coinbase', pair: 'BTC-USDC' });
      logger.error('❌ [coinbase] Entry bid failed: timeout', {
        orderId: 'order-123',
        error: 'timeout',
      });
    } finally {
      capture.restore();
    }

    assert.equal(capture.calls.length, 1);
    assert.equal(capture.calls[0].channel, 'error');
    assert.equal(
      capture.calls[0].line,
      '❌ [coinbase] Entry bid failed: timeout {"exchange":"coinbase","pair":"BTC-USDC","orderId":"order-123","error":"timeout"}'
    );
  });

  it('routes contextual WARN to console.warn while preserving text and merged context', () => {
    const capture = captureConsole();

    try {
      const logger = createContextLogger({ exchange: 'gemini', pair: 'ETH-USD' });
      logger.warn('⚠️ [gemini] rate limit approaching', { remaining: 3 });
    } finally {
      capture.restore();
    }

    assert.equal(capture.calls.length, 1);
    assert.equal(capture.calls[0].channel, 'warn');
    assert.equal(
      capture.calls[0].line,
      '⚠️ [gemini] rate limit approaching {"exchange":"gemini","pair":"ETH-USD","remaining":3}'
    );
  });

  it('routes contextual INFO to console.log while preserving text and merged context', () => {
    const capture = captureConsole();

    try {
      const logger = createContextLogger({ exchange: 'coinbase', pair: 'BTC-USDC' });
      logger.info('Cycle complete', { cycleId: 'c-1' });
    } finally {
      capture.restore();
    }

    assert.equal(capture.calls.length, 1);
    assert.equal(capture.calls[0].channel, 'log');
    assert.equal(
      capture.calls[0].line,
      'Cycle complete {"exchange":"coinbase","pair":"BTC-USDC","cycleId":"c-1"}'
    );
  });

  it('retains canonical severity prefixes and routes legacy WARN callers to console.warn', () => {
    const capture = captureConsole();

    try {
      log('WARN', 'connection degraded', { exchange: 'gemini' });
    } finally {
      capture.restore();
    }

    assert.equal(capture.calls.length, 1);
    assert.equal(capture.calls[0].channel, 'warn');
    assert.equal(capture.calls[0].line, '⚠️ connection degraded {"exchange":"gemini"}');
  });

  it('retains canonical severity prefixes and routes legacy ERROR callers to console.error', () => {
    const capture = captureConsole();

    try {
      log('ERROR', 'order rejected', { exchange: 'coinbase' });
    } finally {
      capture.restore();
    }

    assert.equal(capture.calls.length, 1);
    assert.equal(capture.calls[0].channel, 'error');
    assert.equal(capture.calls[0].line, '❌ order rejected {"exchange":"coinbase"}');
  });

  it('retains canonical severity prefixes and routes legacy INFO callers to console.log', () => {
    const capture = captureConsole();

    try {
      log('INFO', 'startup complete', { exchange: 'coinbase' });
    } finally {
      capture.restore();
    }

    assert.equal(capture.calls.length, 1);
    assert.equal(capture.calls[0].channel, 'log');
    assert.equal(capture.calls[0].line, 'ℹ️ startup complete {"exchange":"coinbase"}');
  });
});

describe('getLogFile / loadTransactionHistory route per fund (issue #543)', () => {
  const pathsModulePath = require.resolve('../src/paths');
  const migrationModulePath = require.resolve('../src/migration');
  const loggerModulePath = require.resolve('../src/logger');
  const configUtilsModulePath = require.resolve('../src/config-utils');

  /** @type {string|null} */
  let tmpDir = null;
  /** @type {any} */
  let loggerModule = null;
  /** @type {any} */
  let configUtils = null;
  /** @type {(() => (string|null))|null} */
  let originalGetDefaultPair = null;

  // Force paths.js/migration.js/logger.js to re-evaluate their top-level
  // `require`s against a freshly-mutated DATA_DIR, the same delete-cache/
  // re-require idiom tests/migration-pair-layout.test.js uses.
  const freshLogger = (dataDir) => {
    const pathsModule = require('../src/paths');
    pathsModule.DATA_DIR = dataDir;
    delete require.cache[migrationModulePath];
    delete require.cache[loggerModulePath];
    return require('../src/logger');
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-per-fund-test-'));
    configUtils = require('../src/config-utils');
    originalGetDefaultPair = configUtils.getDefaultPair;
    configUtils.getDefaultPair = () => 'BTC-USDC';
    loggerModule = freshLogger(tmpDir);
  });

  afterEach(() => {
    configUtils.getDefaultPair = originalGetDefaultPair;
    delete require.cache[migrationModulePath];
    delete require.cache[loggerModulePath];
    delete require.cache[configUtilsModulePath];
    delete require.cache[pathsModulePath];
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
    loggerModule = null;
    configUtils = null;
  });

  it('resolves a named pair under the pair directory', () => {
    const logFile = loggerModule.getLogFile('coinbase', 'ETH-USDC');
    assert.equal(logFile, path.join(tmpDir, 'coinbase', 'ETH-USDC', 'transactions.tsv'));
  });

  it('omitting pair falls back to the exchange default pair', () => {
    const logFile = loggerModule.getLogFile('coinbase');
    assert.equal(logFile, path.join(tmpDir, 'coinbase', 'BTC-USDC', 'transactions.tsv'));
  });

  it('two funds on one exchange write to distinct files', () => {
    const state = { usdcFundSize: 100, assetReserves: 0, outstandingOrdersUSDC: 0, outstandingOrdersAsset: 0 };
    loggerModule.logBuy({ price: 100, assetAmount: 1, usdcAmount: 100, orderId: 'buy-btc' }, state, 'coinbase', 'BTC-USDC');
    loggerModule.logBuy({ price: 3000, assetAmount: 1, usdcAmount: 3000, orderId: 'buy-eth' }, state, 'coinbase', 'ETH-USDC');

    const btcFile = path.join(tmpDir, 'coinbase', 'BTC-USDC', 'transactions.tsv');
    const ethFile = path.join(tmpDir, 'coinbase', 'ETH-USDC', 'transactions.tsv');
    assert.ok(fs.existsSync(btcFile));
    assert.ok(fs.existsSync(ethFile));

    const btcHistory = loggerModule.loadTransactionHistory('coinbase', 'BTC-USDC');
    const ethHistory = loggerModule.loadTransactionHistory('coinbase', 'ETH-USDC');
    assert.equal(btcHistory.length, 1);
    assert.equal(ethHistory.length, 1);
    assert.equal(btcHistory[0]['Order ID'], 'buy-btc');
    assert.equal(ethHistory[0]['Order ID'], 'buy-eth');
  });

  it('loadTransactionHistory omitting pair reads the default-pair fund file', () => {
    const state = { usdcFundSize: 100, assetReserves: 0, outstandingOrdersUSDC: 0, outstandingOrdersAsset: 0 };
    loggerModule.logBuy({ price: 100, assetAmount: 1, usdcAmount: 100, orderId: 'buy-default' }, state, 'coinbase');

    const history = loggerModule.loadTransactionHistory('coinbase');
    assert.equal(history.length, 1);
    assert.equal(history[0]['Order ID'], 'buy-default');
  });
});

describe('logger channel routing (real process streams)', () => {
  it('sends INFO to stdout and WARN/ERROR to stderr, each call emitted exactly once', () => {
    const fixture = path.join(__dirname, 'fixtures', 'logger-channel-check.js');
    const result = spawnSync(process.execPath, [fixture], { encoding: 'utf8' });

    assert.equal(result.status, 0, `fixture process exited nonzero: ${result.stderr}`);

    const stdoutLines = result.stdout.split('\n').filter(Boolean);
    const stderrLines = result.stderr.split('\n').filter(Boolean);
    const countOn = (lines, needle) => lines.filter(line => line.includes(needle)).length;

    // Legacy log(level, message) callers.
    assert.equal(countOn(stdoutLines, 'fixture info message'), 1);
    assert.equal(countOn(stderrLines, 'fixture warn message'), 1);
    assert.equal(countOn(stderrLines, 'fixture error message'), 1);
    assert.equal(countOn(stdoutLines, 'fixture warn message'), 0, 'WARN must not also land on stdout');
    assert.equal(countOn(stdoutLines, 'fixture error message'), 0, 'ERROR must not also land on stdout');

    // Contextual createContextLogger() callers.
    assert.equal(countOn(stdoutLines, 'fixture contextual info'), 1);
    assert.equal(countOn(stderrLines, 'fixture contextual warn'), 1);
    assert.equal(countOn(stderrLines, 'fixture contextual error'), 1);

    // Exactly 6 log lines total, split 2 stdout / 4 stderr — no duplicate
    // emission onto both streams.
    assert.equal(stdoutLines.length, 2);
    assert.equal(stderrLines.length, 4);
  });
});
