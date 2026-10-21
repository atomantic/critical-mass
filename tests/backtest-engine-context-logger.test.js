// @ts-check
/**
 * Backtest diagnostics (fetch progress, fetch errors, empty-data warnings) go
 * through `createContextLogger` so each line carries structured
 * `{ exchange, pair }` context, the same as the rest of src/. Raw console
 * calls here used to emit unstructured WARN/ERROR lines with no context.
 *
 * Fund-data resolution and the Gemini adapter are stubbed BEFORE
 * backtest-engine is loaded, as in backtest-price-cache-durability.test.js.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const migration = require('../src/migration');
const adapters = require('../src/adapters');

const EXCHANGE = 'gemini';
const PRODUCT = 'BTCUSD';
const ENGINE_PATH = require.resolve('../src/backtest-engine');
const CONTEXT = '{"exchange":"gemini","pair":"BTCUSD"}';

describe('backtest-engine diagnostics use the context logger', () => {
  let tmpRoot;
  let originalGetExchangeDataDir;
  let originalGetAdapter;
  let engine;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-backtest-logger-'));
    originalGetExchangeDataDir = migration.getExchangeDataDir;
    originalGetAdapter = adapters.getAdapter;
    migration.getExchangeDataDir = (exchange) => {
      const dir = path.join(tmpRoot, exchange);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    adapters.getAdapter = () => ({
      getCandles: async () => { throw new Error('503 Service Unavailable'); },
    });
    delete require.cache[ENGINE_PATH];
    engine = require('../src/backtest-engine');
  });

  afterEach(() => {
    migration.getExchangeDataDir = originalGetExchangeDataDir;
    adapters.getAdapter = originalGetAdapter;
    delete require.cache[ENGINE_PATH];
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('emits fetch errors and empty-data warnings with exchange and pair context', async (t) => {
    const errors = [];
    const warnings = [];
    t.mock.method(console, 'error', (...args) => { errors.push(args.join(' ')); });
    t.mock.method(console, 'warn', (...args) => { warnings.push(args.join(' ')); });
    t.mock.method(console, 'log', () => {});

    await engine.getPriceData(3, 'daily', EXCHANGE, { productId: PRODUCT });

    const fetchError = errors.find(line => line.includes('Error fetching candles from gemini'));
    assert.ok(fetchError, 'fetch failure is logged through console.error');
    assert.ok(fetchError.includes(CONTEXT), `fetch error carries structured context: ${fetchError}`);

    const emptyWarning = warnings.find(line => line.includes('No more candles available from gemini'));
    assert.ok(emptyWarning, 'empty-data warning is logged through console.warn');
    assert.ok(emptyWarning.includes(CONTEXT), `warning carries structured context: ${emptyWarning}`);
  });
});
