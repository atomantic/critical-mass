const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { getBaseCurrency, getQuoteCurrency } = require('../src/config-utils');

// Evaluate the actual entrypoint, allowing only inert producers: no adapters,
// migrations, credentials, network or data writes can escape this sandbox.
const source = fs.readFileSync(require.resolve('../index.js'), 'utf8');
const invokeCli = async (command, productId, cycleStatus = 'dry_run_success') => {
  const output = [];
  const errors = [];
  const calls = [];
  let exitCode = 0;
  const config = { productId, enabled: true, dryRun: true, totalAllocation: 100,
    intervalType: 'daily', sellMarkupPercent: 2, holdbackPercent: 10, maxBuyPrice: 3000 };
  const modules = {
    './src/runtime-env': { loadRuntimeEnv: () => {} },
    './src/migration': { guardLegacyMigration: () => ({ blocked: false }) },
    './src/logger': { log: (level, message) => { if (level === 'ERROR') errors.push(message); } },
    './src/adapters': { getAdapter: () => { throw new Error('Unexpected adapter access'); } },
    './src/config-utils': { getConfiguredExchanges: () => ['coinbase'],
      getExchangeConfig: () => config, getBaseCurrency, getQuoteCurrency },
    './src/dca-engine': {
      runIntervalCycle: async exchange => {
        calls.push(['run', exchange]);
        return { status: cycleStatus, buyResult: { assetAmount: 0.5, price: 2000 },
          sellOrder: { baseSize: 0.45, limitPrice: 2040 }, holdbackAsset: 0.05,
          state: { assetReserves: 0.15, intervalsRun: 3 } };
      },
      checkStatus: async exchange => {
        calls.push(['status', exchange]);
        return { config, currentPrice: 2000, recentFills: 1,
          state: { totalAllocated: 20, remaining: 80, intervalAmount: 10,
            usdcFundSize: 25, assetReserves: 0.15, outstandingOrdersAsset: 0.45,
            outstandingOrdersUSDC: 918, pendingOrders: 1, totalIntervalsRun: 3 } };
      },
    },
  };
  vm.runInNewContext(source, {
    require: name => { assert.ok(Object.hasOwn(modules, name), `Unexpected require: ${name}`); return modules[name]; },
    process: { argv: ['node', 'index.js', command, '--exchange', 'coinbase'], exit: code => { exitCode = code; } },
    console: { log: message => output.push(message), error: error => errors.push(String(error)) },
  }, { filename: 'index.js' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, []);
  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [[command, 'coinbase']]);
  return output.join('\n');
};

for (const productId of ['BTC-USDC', 'ETH-USDT', 'ethusd', 'CRO_USD']) {
  const base = getBaseCurrency(productId);
  const quote = getQuoteCurrency(productId);
  for (const status of ['success', 'dry_run_success']) {
    test(`run prints current producer contract for ${productId} (${status})`, async () => {
      const output = await invokeCli('run', productId, status);
      assert.ok(output.includes(`Bought: 0.50000000 ${base} at 2000.00 ${quote}`));
      assert.ok(output.includes(`Sell Order: 0.45000000 ${base} at 2040.00 ${quote}`));
      assert.ok(output.includes(`Holdback: 0.05000000 ${base}`));
      assert.ok(output.includes(`Total Reserves: 0.15000000 ${base}`));
      assert.ok(output.includes('Intervals Run: 3'));
    });
  }
  test(`status prints current producer contract for ${productId}`, async () => {
    const output = await invokeCli('status', productId);
    assert.ok(output.includes(`${base} Reserves: 0.15000000 ${base}`));
    assert.ok(output.includes(`Outstanding Sells: 0.45000000 ${base} (918.00 ${quote})`));
    assert.ok(output.includes(`Fund Size: 25.00 ${quote}`));
    assert.ok(output.includes('Recent Fills: 1'));
  });
}
