const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./helpers/regime-aggregate-fixture');

test('legacy client cycle, chart and cost-basis calculations on linked partial fills', async () => {
  const { deriveRegimeFillGroups, deriveRegimeCumulativePnl } = await import('../admin/src/utils/regimeFillGroups.mjs');
  const rows = fixture();
  const history = deriveRegimeFillGroups(rows);
  const points = deriveRegimeCumulativePnl({ fills: rows });
  const costCycles = new Map();
  for (const fill of rows) {
    const cycle = costCycles.get(fill.cycleId) || { bought: 0, sold: 0, cost: 0, proceeds: 0, entries: 0, exits: 0 };
    if (fill.side === 'buy') {
      cycle.bought += fill.size;
      cycle.cost += fill.quoteAmount + fill.netFee;
      cycle.entries++;
    } else {
      cycle.sold += fill.size;
      cycle.proceeds += fill.quoteAmount - fill.netFee;
      cycle.exits++;
    }
    costCycles.set(fill.cycleId, cycle);
  }
  assert.deepEqual(history.cycleGroups.map(c => [c.cycleId, c.totalPnl, c.totalHoldback, c.buyCount]), [
    ['cycle-2', 75.6, 0.19999999999999996, 1],
    ['cycle-1', 30, 0.15000000000000002, 2],
  ]);
  assert.equal(history.totalPnl, 105.6);
  assert.ok(Math.abs(history.totalHoldback - 0.35) < 1e-10);
  assert.deepEqual(points.map(p => [p.date.getTime(), p.pnl, p.cumulative]), [
    [3000, 30, 30], [6000, 75.6, 105.6],
  ]);
  assert.deepEqual([...costCycles], [
    ['cycle-1', { bought: 2, sold: 1.8, cost: 303, proceeds: 268, entries: 2, exits: 2 }],
    ['cycle-2', { bought: 1.2, sold: 0.8, cost: 363.5, proceeds: 318, entries: 2, exits: 1 }],
  ]);
});
