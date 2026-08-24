const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createOrderExecutor } = require('../src/order-executor');

const contextFor = (lines, prefix) => {
  const line = lines.find(candidate => candidate.startsWith(prefix));
  assert.ok(line, `missing log line starting with: ${prefix}`);
  const contextStart = line.lastIndexOf(' {');
  assert.notEqual(contextStart, -1, `missing structured context: ${line}`);
  return JSON.parse(line.slice(contextStart + 1));
};

describe('execution lifecycle structured logging', () => {
  it('keeps order and WebSocket lifecycle modules off direct console calls', () => {
    for (const relativePath of [
      '../src/order-executor.js',
      '../src/websocket-feed.js',
      '../src/adapters/gemini/websocket.js',
      '../src/adapters/cryptocom/websocket.js',
    ]) {
      const source = fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
      assert.doesNotMatch(source, /\bconsole\.(?:log|warn|error)\b/, relativePath);
      assert.match(source, /createContextLogger\(/, relativePath);
    }
  });

  it('preserves the entry-cancel summary and appends fund and outcome context', async () => {
    const lines = [];
    const originalLog = console.log;
    console.log = line => lines.push(line);

    try {
      const executor = createOrderExecutor('coinbase', {
        orderStaleMs: 60_000,
        cancelRateLimitMs: 0,
      }, {
        cancelOrder: async () => ({ success: true }),
      }, 'BTC-USDC');
      executor.restorePendingOrder('entry-order-123', {
        type: 'entry',
        price: 100_000,
        size: 0.001,
        sizeUsdc: 100,
        placedAt: Date.now(),
      });

      await executor.cancelAllEntries();
    } finally {
      console.log = originalLog;
    }

    assert.deepEqual(
      contextFor(lines, '🚫 [coinbase] Cancelled 1 entry orders'),
      {
        exchange: 'coinbase',
        pair: 'BTC-USDC',
        orderType: 'entry',
        cancelled: 1,
        filled: 0,
        failed: 0,
      }
    );
  });
});
