const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { getBaseCurrency, getQuoteCurrency } = require('../src/config-utils');

// Evaluate the actual entrypoint, allowing only inert producers: no adapters,
// migrations, credentials, network or data writes can escape this sandbox.
const source = fs.readFileSync(require.resolve('../index.js'), 'utf8');
const runCli = async (command, productId, cycleStatus = 'dry_run_success',
  { simpleDcaEnabled = true, gatewaySafe = true, claimable = true } = {}) => {
  const output = [];
  const errors = [];
  const calls = [];
  let exitCode = 0;
  const config = { productId, enabled: true, dryRun: true, totalAllocation: 100,
    intervalType: 'daily', sellMarkupPercent: 2, holdbackPercent: 10, maxBuyPrice: 3000 };
  const modules = {
    './src/runtime-env': { loadRuntimeEnv: () => {} },
    './src/migration': { guardLegacyMigration: () => ({ blocked: false }) },
    './src/restore-apply': { guardIncompleteRestore: ({ processLabel }) => {
      calls.push(['restore-recovery', processLabel]);
      return { pending: false, recovered: false, blocked: false };
    } },
    './src/engine-liveness': {
      checkGatewayStopped: async () => {
        calls.push(['gateway-probe']);
        return gatewaySafe
          ? { safe: true, reason: 'no gateway is listening on port 5570' }
          : { safe: false, reason: 'the gateway is accepting connections on 127.0.0.1:5570' };
      },
      claimGatewayListeners: async () => {
        calls.push(['gateway-claim']);
        return claimable
          ? { claimed: true, release: async () => { calls.push(['gateway-release']); } }
          : { claimed: false, reason: 'the gateway (or another CLI write) holds 127.0.0.1:5570' };
      },
    },
    './src/logger': { log: (level, message) => { if (level === 'ERROR') errors.push(message); } },
    './src/adapters': {
      getAdapter: () => ({
        getAccountBalance: async () => ({ available: 12.34, hold: 0, total: 12.34 }),
        getProductDetails: async pid => ({ id: pid, status: 'online' }),
      }),
    },
    './src/config-utils': { getConfiguredExchanges: () => ['coinbase'],
      getExchangeConfig: () => config, getBaseCurrency, getQuoteCurrency,
      getGlobalConfig: () => ({ simpleDcaEnabled }) },
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
  await new Promise(resolve => setImmediate(resolve));
  return { output: output.join('\n'), errors, exitCode, calls };
};

const invokeCli = async (command, productId, cycleStatus) => {
  const { output, errors, exitCode, calls } = await runCli(command, productId, cycleStatus);
  assert.deepEqual(errors, []);
  assert.equal(exitCode, 0);
  assert.deepEqual(calls, command === 'debug'
    ? []
    : [['gateway-probe'], ['gateway-claim'], ['restore-recovery', 'CLI'], [command, 'coinbase'], ['gateway-release']]);
  return output;
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
  test(`debug prints current producer contract for ${productId}`, async () => {
    const output = await invokeCli('debug', productId);
    assert.ok(output.includes(`--- ${quote} Balance ---`));
    assert.ok(output.includes(`--- ${base} Balance ---`));
    assert.ok(output.includes(`--- Product: ${productId} ---`));
  });
}

// The gateway serializes each fund's state.json writes under a process-local
// lock; a CLI cycle beside it would race those saves (double buy / lost booking).
for (const command of ['run', 'status']) {
  test(`${command} refuses while the gateway is running, before any recovery or fund write`, async () => {
    const { output, exitCode, calls } = await runCli(command, 'BTC-USDC', 'success', { gatewaySafe: false });
    assert.equal(exitCode, 1);
    assert.deepEqual(calls, [['gateway-probe']]);
    assert.ok(output.includes(`Refusing to ${command}: the gateway is accepting connections`));
  });
}

test('run honors the gateway Simple DCA gate instead of buying against a regime fund', async () => {
  const { output, exitCode, calls } = await runCli('run', 'BTC-USDC', 'success', { simpleDcaEnabled: false });
  assert.equal(exitCode, 1);
  assert.deepEqual(calls, []);
  assert.ok(output.includes('Simple DCA is disabled'));
});

test('status still reconciles with Simple DCA disabled once the gateway is stopped', async () => {
  const { exitCode, calls } = await runCli('status', 'BTC-USDC', 'success', { simpleDcaEnabled: false });
  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [['gateway-probe'], ['gateway-claim'], ['restore-recovery', 'CLI'], ['status', 'coinbase'], ['gateway-release']]);
});

// A probe is point-in-time; the held claim is what keeps a gateway from
// starting mid-command, so a failed claim (gateway or a second CLI write) refuses.
test('run refuses when the gateway addresses cannot be claimed', async () => {
  const { output, exitCode, calls } = await runCli('run', 'BTC-USDC', 'success', { claimable: false });
  assert.equal(exitCode, 1);
  assert.deepEqual(calls, [['gateway-probe'], ['gateway-claim']]);
  assert.ok(output.includes('Refusing to run: the gateway (or another CLI write) holds'));
});
