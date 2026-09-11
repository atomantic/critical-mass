const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
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
