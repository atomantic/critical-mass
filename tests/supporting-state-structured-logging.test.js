const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { attachSellOrder, markSellPlacementFailed } = require('../src/state-tracker');

const contextFor = (lines, prefix) => {
  const line = lines.find(candidate => candidate.startsWith(prefix));
  assert.ok(line, `missing log line starting with: ${prefix}`);
  const contextStart = line.lastIndexOf(' {');
  assert.notEqual(contextStart, -1, `missing structured context: ${line}`);
  return JSON.parse(line.slice(contextStart + 1));
};

describe('supporting state structured logging', () => {
  it('keeps persistent trading-state modules off direct console calls', () => {
    for (const relativePath of [
      '../src/state-tracker.js',
      '../src/dry-run-state.js',
      '../src/closed-trades.js',
      '../src/manual-trades.js',
      '../src/chart-data-buffer.js',
    ]) {
      const source = fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
      assert.doesNotMatch(source, /\bconsole\.(?:log|warn|error)\b/, relativePath);
      assert.match(source, /createContextLogger\(/, relativePath);
    }
  });

  it('preserves state-link failure messages and appends order and error context', () => {
    const lines = [];
    const originalLog = console.log;
    console.log = line => lines.push(line);

    try {
      attachSellOrder({ orders: [] }, 'buy-123', { orderId: 'sell-456' });
      markSellPlacementFailed({ orders: [] }, 'buy-789', 'exchange unavailable');
    } finally {
      console.log = originalLog;
    }

    assert.deepEqual(
      contextFor(lines, '⚠️ attachSellOrder: no awaiting_sell order for buy buy-123 — sell sell-456 not linked'),
      {
        module: 'state-tracker',
        buyOrderId: 'buy-123',
        sellOrderId: 'sell-456',
      }
    );
    assert.deepEqual(
      contextFor(lines, '⚠️ markSellPlacementFailed: no awaiting_sell order for buy buy-789 — failure not recorded (reason: exchange unavailable)'),
      {
        module: 'state-tracker',
        buyOrderId: 'buy-789',
        error: 'exchange unavailable',
      }
    );
  });
});
