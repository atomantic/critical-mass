const { runDailyCycle, checkStatus } = require('./src/dca-engine');
const { log } = require('./src/logger');
const api = require('./src/api');

/**
 * Main entry point
 */
const main = async () => {
  const args = process.argv.slice(2);
  const command = args[0] || 'run';

  log('INFO', `Starting DCA bot (command: ${command})`);

  if (command === 'status') {
    // Check status only
    const status = await checkStatus();
    console.log('\n=== DCA Bot Status ===');
    console.log(`Product: ${status.config.productId}`);
    console.log(`Current Price: $${status.currentPrice.toFixed(2)}`);
    console.log(`Enabled: ${status.config.enabled}`);
    console.log('');
    console.log('--- Allocation ---');
    console.log(`Total: $${status.config.totalAllocation.toFixed(2)}`);
    console.log(`Used: $${status.state.totalAllocated.toFixed(2)}`);
    console.log(`Remaining: $${status.state.remaining.toFixed(2)}`);
    console.log(`Daily Amount: $${status.state.dailyAmount.toFixed(2)}`);
    console.log('');
    console.log('--- Holdings ---');
    console.log(`USDC Fund Size: $${status.state.usdcFundSize.toFixed(2)}`);
    console.log(`BTC Reserves: ${status.state.btcReserves.toFixed(8)} BTC`);
    console.log(`Outstanding Sells: ${status.state.outstandingOrdersBTC.toFixed(8)} BTC ($${status.state.outstandingOrdersUSDC.toFixed(2)})`);
    console.log(`Pending Orders: ${status.state.pendingOrders}`);
    console.log('');
    console.log('--- History ---');
    console.log(`Days Run: ${status.state.totalDaysRun}`);
    console.log(`Last Run: ${status.state.lastRunDate || 'Never'}`);
    console.log(`Recent Fills: ${status.recentFills}`);
    console.log('');
    console.log('--- Config ---');
    console.log(`Sell Markup: +${status.config.sellMarkupPercent}%`);
    console.log(`Holdback: ${status.config.holdbackPercent}%`);
    console.log(`Max Buy Price: $${status.config.maxBuyPrice.toFixed(2)}`);

    return;
  }

  if (command === 'run') {
    // Run the daily cycle
    const result = await runDailyCycle();

    console.log('');
    console.log('=== Cycle Result ===');
    console.log(`Status: ${result.status}`);

    if (result.status === 'success') {
      console.log(`Bought: ${result.buyResult.btcAmount.toFixed(8)} BTC at $${result.buyResult.price.toFixed(2)}`);
      console.log(`Sell Order: ${result.sellOrder.baseSize.toFixed(8)} BTC at $${result.sellOrder.limitPrice.toFixed(2)}`);
      console.log(`Holdback: ${result.holdbackBTC.toFixed(8)} BTC`);
      console.log(`Total Reserves: ${result.state.btcReserves.toFixed(8)} BTC`);
      console.log(`Days Run: ${result.state.daysRun}`);
    } else if (result.status === 'already_ran') {
      console.log(`Last run: ${result.lastRunDate}`);
    } else if (result.status === 'price_too_high') {
      console.log(`Current: $${result.currentPrice.toFixed(2)}, Max: $${result.maxBuyPrice.toFixed(2)}`);
    } else if (result.status === 'insufficient_balance') {
      console.log(`Available: $${result.available.toFixed(2)}, Required: $${result.required.toFixed(2)}`);
    }

    return;
  }

  if (command === 'debug') {
    // Debug mode - show raw account info
    console.log('\n=== Debug: Account Information ===\n');

    const { getAuthHeaders } = require('./src/auth');
    const axios = require('axios');
    const keys = require('./keys.json');
    const apiKey = keys.name || keys.apiKey;
    const apiSecret = keys.privateKey || keys.apiSecret;

    console.log('API Key:', apiKey.substring(0, 30) + '...');
    console.log('');

    // Fetch ALL accounts with pagination
    let allAccounts = [];
    let cursor = null;
    let pageCount = 0;

    do {
      const path = cursor
        ? `/api/v3/brokerage/accounts?limit=250&cursor=${cursor}`
        : '/api/v3/brokerage/accounts?limit=250';
      const headers = getAuthHeaders(apiKey, apiSecret, 'GET', path);
      const response = await axios.get(`https://api.coinbase.com${path}`, { headers });

      allAccounts = allAccounts.concat(response.data.accounts || []);
      cursor = response.data.cursor;
      pageCount++;
      console.log(`Fetched page ${pageCount}: ${response.data.accounts?.length || 0} accounts (cursor: ${cursor ? 'yes' : 'no'})`);
    } while (cursor);

    console.log(`\nTotal accounts fetched: ${allAccounts.length}\n`);

    // Show accounts with balances
    console.log('--- Accounts with Balances ---');
    const accountsWithBalance = allAccounts.filter(a => {
      const available = parseFloat(a.available_balance?.value || 0);
      const hold = parseFloat(a.hold?.value || 0);
      return (available + hold) > 0;
    });

    if (accountsWithBalance.length === 0) {
      console.log('No accounts with balances found!\n');
    } else {
      for (const account of accountsWithBalance) {
        const available = parseFloat(account.available_balance?.value || 0);
        const hold = parseFloat(account.hold?.value || 0);
        console.log(`${account.currency}: ${available.toFixed(8)} available, ${hold.toFixed(8)} hold`);
        console.log(`  UUID: ${account.uuid}`);
        console.log(`  Type: ${account.type}`);
        console.log('');
      }
    }

    // Show USDC specifically
    console.log('--- USDC Account ---');
    const usdcAccount = allAccounts.find(a => a.currency === 'USDC');
    if (usdcAccount) {
      console.log(JSON.stringify(usdcAccount, null, 2));
    } else {
      console.log('No USDC account found in any page!');
    }

    // Show BTC (prefer non-vault with balance)
    console.log('\n--- BTC Account ---');
    const btcAccounts = allAccounts.filter(a => a.currency === 'BTC');
    const btcAccount = btcAccounts.find(a =>
      a.type === 'ACCOUNT_TYPE_CRYPTO' &&
      (parseFloat(a.available_balance?.value || 0) > 0 || parseFloat(a.hold?.value || 0) > 0)
    ) || btcAccounts.find(a => a.default === true)
      || btcAccounts.find(a => a.type === 'ACCOUNT_TYPE_CRYPTO')
      || btcAccounts[0];
    if (btcAccount) {
      console.log(JSON.stringify(btcAccount, null, 2));
      if (btcAccounts.length > 1) {
        console.log(`\n(Found ${btcAccounts.length} BTC accounts, showing the one with balance)`);
      }
    } else {
      console.log('No BTC account found in any page!');
    }

    // Test product fetch
    console.log('\n--- Product: BTC-USDC ---');
    const config = require('./config.json');
    const productDetails = await api.getProductDetails(config.productId);
    console.log(JSON.stringify(productDetails, null, 2));

    return;
  }

  console.log('Usage: node index.js [command]');
  console.log('Commands:');
  console.log('  run     - Execute daily DCA cycle (default)');
  console.log('  status  - Check current status without trading');
  console.log('  debug   - Show raw account information');
};

main().catch(err => {
  log('ERROR', `Fatal error: ${err.message}`);
  console.error(err);
  process.exit(1);
});
