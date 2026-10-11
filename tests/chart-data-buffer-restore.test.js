const { it, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createIsolatedDataDir } = require('./test-data-dir');
const isolated = createIsolatedDataDir('cm-chart-restore');
const { getChartDataBuffer, removeAllChartDataBuffers } = require('../src/chart-data-buffer');

it('retires chart timers and reloads restored history into a fresh buffer', (t) => {
  const now = Date.now();
  mock.timers.enable({ apis: ['setInterval', 'Date'], now });
  t.after(() => { removeAllChartDataBuffers(); mock.timers.reset(); isolated.cleanup(); });
  const pair = '__testchartrestore__';
  const old = getChartDataBuffer('coinbase', pair);
  old.processStatus({ market: { lastPrice: 7 } });
  removeAllChartDataBuffers();
  const file = path.join(isolated.root, 'coinbase', pair, 'chart-data-buffer.json');
  const restored = { priceHistory: [{ timestamp: now, price: 99 }], atrHistory: [], regimeHistory: [], savedAt: now };
  fs.writeFileSync(file, JSON.stringify(restored));
  mock.timers.tick(30_000);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), restored, 'old periodic save must never overwrite restore');
  const fresh = getChartDataBuffer('coinbase', pair);
  assert.notEqual(fresh, old, 'a restarted fund cannot reuse pre-restore history');
  assert.equal(fresh.getData().priceHistory[0].price, 99);
});
