const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { log, createContextLogger } = require('../src/logger');

describe('structured logger', () => {
  it('preserves legacy operator text while appending merged context', () => {
    const lines = [];
    const originalLog = console.log;
    console.log = line => lines.push(line);

    try {
      const logger = createContextLogger({ exchange: 'coinbase', pair: 'BTC-USDC' });
      logger.error('❌ [coinbase] Entry bid failed: timeout', {
        orderId: 'order-123',
        error: 'timeout',
      });
    } finally {
      console.log = originalLog;
    }

    assert.equal(
      lines[0],
      '❌ [coinbase] Entry bid failed: timeout {"exchange":"coinbase","pair":"BTC-USDC","orderId":"order-123","error":"timeout"}'
    );
  });

  it('retains canonical severity prefixes for existing log callers', () => {
    const lines = [];
    const originalLog = console.log;
    console.log = line => lines.push(line);

    try {
      log('WARN', 'connection degraded', { exchange: 'gemini' });
    } finally {
      console.log = originalLog;
    }

    assert.equal(lines[0], '⚠️ connection degraded {"exchange":"gemini"}');
  });
});
