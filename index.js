const { runIntervalCycle, checkStatus } = require('./src/dca-engine');
const { log } = require('./src/logger');
const { getAdapter } = require('./src/adapters');
const { getExchangeConfig, getConfiguredExchanges } = require('./src/config-utils');
const { runMigrationIfNeeded } = require('./src/migration');

// Run migration on startup
runMigrationIfNeeded();

/**
 * Parse command line arguments
 * @returns {{command: string, exchange: string, flags: Object}}
 */
const parseArgs = () => {
  const args = process.argv.slice(2);
  const result = {
    command: 'run',
    exchange: 'coinbase',
    flags: {},
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--exchange' || arg === '-e') {
      result.exchange = args[++i] || 'coinbase';
    } else if (arg.startsWith('--exchange=')) {
      result.exchange = arg.split('=')[1];
    } else if (arg.startsWith('-')) {
      const key = arg.replace(/^-+/, '');
      result.flags[key] = true;
    } else if (!result.command || result.command === 'run') {
      result.command = arg;
    }
  }

  return result;
};

/**
 * Main entry point
 */
const main = async () => {
  const { command, exchange, flags } = parseArgs();

  log('INFO', `Starting Critical Mass (command: ${command}, exchange: ${exchange})`);

  // Validate exchange
  const configuredExchanges = getConfiguredExchanges();
  if (!configuredExchanges.includes(exchange)) {
    console.log(`Error: Unknown exchange '${exchange}'`);
    console.log(`Configured exchanges: ${configuredExchanges.join(', ')}`);
    process.exit(1);
  }

  if (command === 'status') {
    // Check status only
    const status = await checkStatus(exchange);
    console.log(`\n=== Critical Mass Status (${exchange}) ===`);
    console.log(`Product: ${status.config.productId}`);
    console.log(`Current Price: $${status.currentPrice.toFixed(2)}`);
    console.log(`Enabled: ${status.config.enabled}`);
    console.log(`Dry-Run: ${status.config.dryRun}`);
    console.log('');
    console.log('--- Allocation ---');
    console.log(`Total: $${status.config.totalAllocation.toFixed(2)}`);
    console.log(`Used: $${status.state.totalAllocated.toFixed(2)}`);
    console.log(`Remaining: $${status.state.remaining.toFixed(2)}`);
    console.log(`Interval Amount: $${status.state.intervalAmount.toFixed(2)}`);
    console.log('');
    console.log('--- Holdings ---');
    console.log(`Fund Size: $${status.state.usdcFundSize.toFixed(2)}`);
    console.log(`BTC Reserves: ${status.state.btcReserves.toFixed(8)} BTC`);
    console.log(`Outstanding Sells: ${status.state.outstandingOrdersBTC.toFixed(8)} BTC ($${status.state.outstandingOrdersUSDC.toFixed(2)})`);
    console.log(`Pending Orders: ${status.state.pendingOrders}`);
    console.log('');
    console.log('--- History ---');
    console.log(`Intervals Run: ${status.state.totalIntervalsRun}`);
    console.log(`Last Run: ${status.state.lastRunId || 'Never'}`);
    console.log(`Recent Fills: ${status.recentFills}`);
    console.log('');
    console.log('--- Config ---');
    console.log(`Interval Type: ${status.config.intervalType}`);
    console.log(`Sell Markup: +${status.config.sellMarkupPercent}%`);
    console.log(`Holdback: ${status.config.holdbackPercent}%`);
    console.log(`Max Buy Price: $${status.config.maxBuyPrice.toFixed(2)}`);

    return;
  }

  if (command === 'run') {
    // Run the interval cycle
    const result = await runIntervalCycle(exchange);

    console.log('');
    console.log(`=== Cycle Result (${exchange}) ===`);
    console.log(`Status: ${result.status}`);

    if (result.status === 'success' || result.status === 'dry_run_success') {
      console.log(`Bought: ${result.buyResult.btcAmount.toFixed(8)} BTC at $${result.buyResult.price.toFixed(2)}`);
      console.log(`Sell Order: ${result.sellOrder.baseSize.toFixed(8)} BTC at $${result.sellOrder.limitPrice.toFixed(2)}`);
      console.log(`Holdback: ${result.holdbackBTC.toFixed(8)} BTC`);
      console.log(`Total Reserves: ${result.state.btcReserves.toFixed(8)} BTC`);
      console.log(`Intervals Run: ${result.state.intervalsRun}`);
    } else if (result.status === 'already_ran') {
      console.log(`Last run: ${result.lastRunId}`);
    } else if (result.status === 'price_too_high') {
      console.log(`Current: $${result.currentPrice.toFixed(2)}, Max: $${result.maxBuyPrice.toFixed(2)}`);
    } else if (result.status === 'insufficient_balance') {
      console.log(`Available: $${result.available.toFixed(2)}, Required: $${result.required.toFixed(2)}`);
    } else if (result.status === 'disabled') {
      console.log(`Bot is disabled for ${exchange}. Enable in config to run.`);
    }

    return;
  }

  if (command === 'debug') {
    // Debug mode - show raw account info
    console.log(`\n=== Debug: Account Information (${exchange}) ===\n`);

    const adapter = getAdapter(exchange);
    const config = getExchangeConfig(exchange);
    const quoteCurrency = exchange === 'gemini' ? 'USD' : 'USDC';

    // Show balances
    console.log(`--- ${quoteCurrency} Balance ---`);
    const quoteBalance = await adapter.getAccountBalance(quoteCurrency);
    console.log(`Available: ${quoteBalance.available.toFixed(2)}`);
    console.log(`Hold: ${quoteBalance.hold.toFixed(2)}`);
    console.log(`Total: ${quoteBalance.total.toFixed(2)}`);

    console.log('\n--- BTC Balance ---');
    const btcBalance = await adapter.getAccountBalance('BTC');
    console.log(`Available: ${btcBalance.available.toFixed(8)}`);
    console.log(`Hold: ${btcBalance.hold.toFixed(8)}`);
    console.log(`Total: ${btcBalance.total.toFixed(8)}`);

    // Show product details
    console.log(`\n--- Product: ${config.productId} ---`);
    const productDetails = await adapter.getProductDetails(config.productId);
    console.log(JSON.stringify(productDetails, null, 2));

    return;
  }

  if (command === 'exchanges') {
    // List all configured exchanges
    console.log('\n=== Configured Exchanges ===\n');

    for (const ex of configuredExchanges) {
      const config = getExchangeConfig(ex);
      console.log(`${ex}:`);
      console.log(`  Product: ${config.productId}`);
      console.log(`  Enabled: ${config.enabled}`);
      console.log(`  Dry-Run: ${config.dryRun}`);
      console.log(`  Allocation: $${config.totalAllocation}`);
      console.log('');
    }

    return;
  }

  console.log('Usage: node index.js [command] [--exchange <exchange>]');
  console.log('');
  console.log('Commands:');
  console.log('  run        - Execute interval DCA cycle (default)');
  console.log('  status     - Check current status without trading');
  console.log('  debug      - Show raw account information');
  console.log('  exchanges  - List all configured exchanges');
  console.log('');
  console.log('Options:');
  console.log('  --exchange, -e <name>  - Specify exchange (default: coinbase)');
  console.log('');
  console.log('Examples:');
  console.log('  node index.js status');
  console.log('  node index.js status --exchange gemini');
  console.log('  node index.js run -e coinbase');
};

main().catch(err => {
  log('ERROR', `Fatal error: ${err.message}`);
  console.error(err);
  process.exit(1);
});
