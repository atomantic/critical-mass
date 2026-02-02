const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const stateTracker = require('./src/state-tracker');
const { syncOrderStatuses, runIntervalCycle, loadConfig, runAllExchangeCycles, executeConsolidation } = require('./src/dca-engine');
const { log, loadTransactionHistory, getLogFile } = require('./src/logger');
const backtestEngine = require('./src/backtest-engine');
const { runMigrationIfNeeded, getExchangeDataDir, getExchangeKeysPath } = require('./src/migration');
const {
  loadConfig: loadFullConfig,
  saveConfig,
  getExchangeConfig,
  getEnabledExchanges,
  getConfiguredExchanges,
  updateExchangeConfig,
  setExchangeEnabled,
  setExchangeDryRun,
  getGlobalConfig,
} = require('./src/config-utils');
const {
  normalizeConfig,
  getNextExecutionTime,
  getRunIdentifier,
  hasRunThisInterval,
  formatInterval,
  getTimeUntilNext,
  getIntervalConfig
} = require('./src/interval-utils');
const { createRegimeEngine } = require('./src/regime-engine');
const { getRegimeConfig, updateRegimeConfig, validateRegimeConfig } = require('./src/config-utils');

// Active regime engines by exchange
const regimeEngines = new Map();

// Run migration on startup
runMigrationIfNeeded();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});
const PORT = process.env.PORT || 5563;

// Middleware
app.use(cors());
app.use(express.json());

// Paths
const CONFIG_FILE = path.join(__dirname, 'config.json');
const DATA_DIR = path.join(__dirname, 'data');

// Helper to read JSON file
const readJSON = (filepath, defaultValue = {}) => {
  if (!fs.existsSync(filepath)) return defaultValue;
  const content = fs.readFileSync(filepath, 'utf8');
  if (!content || content.trim() === '') return defaultValue;
  try {
    return JSON.parse(content);
  } catch (err) {
    console.error(`Error parsing JSON from ${filepath}:`, err.message);
    return defaultValue;
  }
};

// Helper to write JSON file
const writeJSON = (filepath, data) => {
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
};

// Helper to parse TSV
const parseTSV = (filepath) => {
  if (!fs.existsSync(filepath)) return [];
  const content = fs.readFileSync(filepath, 'utf8');
  const lines = content.trim().split('\n');
  if (lines.length <= 1) return [];

  const headers = lines[0].split('\t');
  return lines.slice(1).map(line => {
    const values = line.split('\t');
    const record = {};
    headers.forEach((header, i) => {
      const value = values[i] || '';
      // Keep date/time columns as strings
      if (header === 'Date' || header === 'Timestamp') {
        record[header] = value;
      } else {
        const num = parseFloat(value);
        record[header] = isNaN(num) ? value : num;
      }
    });
    return record;
  });
};

// ============ Exchange Management API ============

// Get list of all exchanges
app.get('/api/exchanges', (req, res) => {
  const configured = getConfiguredExchanges();
  const enabled = getEnabledExchanges();

  const exchanges = configured.map(name => {
    const config = getExchangeConfig(name);
    return {
      name,
      enabled: config.enabled,
      dryRun: config.dryRun,
      productId: config.productId,
    };
  });

  res.json({ exchanges, enabled });
});

// ============ Per-Exchange API Routes ============

// Get config for an exchange
app.get('/api/:exchange/config', (req, res) => {
  const { exchange } = req.params;
  const config = getExchangeConfig(exchange);
  res.json(config);
});

// Update config for an exchange
app.put('/api/:exchange/config', (req, res) => {
  const { exchange } = req.params;
  const updates = req.body;
  const config = updateExchangeConfig(exchange, updates);
  res.json({ success: true, config: config.exchanges[exchange] });
});

// Toggle enabled/dryRun for an exchange
app.patch('/api/:exchange/config', (req, res) => {
  const { exchange } = req.params;
  const { enabled, dryRun } = req.body;

  if (typeof enabled === 'boolean') {
    setExchangeEnabled(exchange, enabled);
    log('INFO', `[${exchange}] Trading automation ${enabled ? 'ENABLED' : 'DISABLED'}`);
  }

  if (typeof dryRun === 'boolean') {
    setExchangeDryRun(exchange, dryRun);
    log('INFO', `[${exchange}] Dry-run mode ${dryRun ? 'ENABLED' : 'DISABLED'}`);
  }

  const config = getExchangeConfig(exchange);
  res.json({ success: true, config });
});

// Get state for an exchange
app.get('/api/:exchange/state', (req, res) => {
  const { exchange } = req.params;
  const config = getExchangeConfig(exchange);
  const state = stateTracker.loadState(config, exchange);
  res.json(state);
});

// Get transactions for an exchange
app.get('/api/:exchange/transactions', (req, res) => {
  const { exchange } = req.params;
  const logFile = getLogFile(exchange);
  const transactions = parseTSV(logFile);
  res.json(transactions);
});

// Get live status for an exchange
app.get('/api/:exchange/status', async (req, res) => {
  const { exchange } = req.params;
  const { getAdapter } = require('./src/adapters');

  const config = getExchangeConfig(exchange);
  const state = stateTracker.loadState(config, exchange);

  let currentPrice = 0;
  let quoteBalance = { available: 0, hold: 0 };
  let btcBalance = { available: 0, hold: 0 };
  let keysConfigured = false;
  let apiError = null;
  const quoteCurrency = exchange === 'gemini' ? 'USD' : 'USDC';

  const adapter = getAdapter(exchange);

  // Check if keys are configured before making API calls
  if (adapter.hasValidKeys && adapter.hasValidKeys()) {
    keysConfigured = true;
    try {
      currentPrice = await adapter.getCurrentPrice(config.productId);
      quoteBalance = await adapter.getAccountBalance(quoteCurrency);
      btcBalance = await adapter.getAccountBalance('BTC');
    } catch (err) {
      apiError = err.message || 'API connection failed';
      log('ERROR', `[${exchange}] Status check failed: ${apiError}`);
    }
  }

  res.json({
    exchange,
    currentPrice,
    quoteBalance,
    btcBalance,
    quoteCurrency,
    keysConfigured,
    apiError,
    config,
    state,
    lastUpdated: new Date().toISOString(),
  });
});

// Calculate cost basis from orders
const calculateCostBasis = (state, transactions) => {
  const orders = state.orders || [];
  const buys = transactions.filter(t => t.Type === 'BUY');

  let totalCostBasis = 0;
  let totalBTCFromOrders = 0;
  let reservesCostBasis = 0;
  let pendingCostBasis = 0;
  let pendingBTC = 0;

  orders.forEach(order => {
    const costBasis = order.buyCostBasis || (order.buyUSDC || (order.buyQuantityBTC * order.buyPrice));
    const btcAmount = order.buyQuantityBTC || 0;
    const holdback = order.holdbackBTC || 0;
    const sellQuantity = order.sellQuantityBTC || 0;
    const costPerBTC = btcAmount > 0 ? costBasis / btcAmount : 0;

    reservesCostBasis += holdback * costPerBTC;

    if (order.status === 'pending') {
      pendingCostBasis += sellQuantity * costPerBTC;
      pendingBTC += sellQuantity;
    }

    totalCostBasis += costBasis;
    totalBTCFromOrders += btcAmount;
  });

  if (orders.length === 0 && buys.length > 0) {
    buys.forEach(buy => {
      const cost = Math.abs(buy['USDC Amount'] || 0) + (buy['Net Fees'] || 0);
      const btc = buy['BTC Amount'] || 0;
      totalCostBasis += cost;
      totalBTCFromOrders += btc;
    });

    const avgCost = totalBTCFromOrders > 0 ? totalCostBasis / totalBTCFromOrders : 0;
    reservesCostBasis = (state.btcReserves || 0) * avgCost;
    pendingCostBasis = (state.outstandingOrdersBTC || 0) * avgCost;
    pendingBTC = state.outstandingOrdersBTC || 0;
  }

  const avgCostPerBTC = totalBTCFromOrders > 0 ? totalCostBasis / totalBTCFromOrders : 0;
  const reservesAvgCost = (state.btcReserves || 0) > 0 ? reservesCostBasis / state.btcReserves : avgCostPerBTC;

  return {
    totalCostBasis,
    totalBTCBought: totalBTCFromOrders,
    avgCostPerBTC,
    reservesBTC: state.btcReserves || 0,
    reservesCostBasis,
    reservesAvgCost,
    pendingBTC,
    pendingCostBasis,
    pendingAvgCost: pendingBTC > 0 ? pendingCostBasis / pendingBTC : 0,
    orderBreakdown: orders.map(order => {
      const costBasis = order.buyCostBasis || (order.buyUSDC || (order.buyQuantityBTC * order.buyPrice));
      const btcAmount = order.buyQuantityBTC || 0;
      const costPerBTC = btcAmount > 0 ? costBasis / btcAmount : 0;
      return {
        date: order.createdAt ? order.createdAt.split('T')[0] : 'Unknown',
        buyPrice: order.buyPrice,
        btcBought: btcAmount,
        costBasis,
        costPerBTC,
        fees: order.buyFees || 0,
        rebates: order.buyRebates || 0,
        netFees: order.buyNetFees || 0,
        holdback: order.holdbackBTC || 0,
        holdbackCost: (order.holdbackBTC || 0) * costPerBTC,
        sellQuantity: order.sellQuantityBTC || 0,
        sellPrice: order.sellPrice,
        status: order.status,
        realizedPnL: order.status === 'filled'
          ? (order.netProceeds || order.actualFillValue || 0) - ((order.sellQuantityBTC || 0) * costPerBTC)
          : null,
      };
    }),
  };
};

// Calculate next trade info for an exchange
const getNextTradeInfo = (config, state) => {
  const normalized = normalizeConfig(config);
  const { intervalType, intervalsToSpread, totalAllocation } = normalized;

  const ranThisInterval = hasRunThisInterval(state.lastRunId, intervalType);
  const nextExecutionTime = getNextExecutionTime(intervalType, state.lastRunTimestamp);
  const timeUntilNext = getTimeUntilNext(intervalType);

  const remaining = (totalAllocation || 0) - (state.totalAllocated || 0);
  const intervalAmount = Math.min(
    (totalAllocation || 0) / (intervalsToSpread || 1),
    remaining
  );

  const fullyAllocated = remaining <= 0;

  return {
    nextTradeTime: new Date(nextExecutionTime).toISOString(),
    nextTradeAmount: fullyAllocated ? 0 : intervalAmount,
    timeUntilNext: timeUntilNext.formatted,
    intervalType,
    intervalLabel: formatInterval(intervalType),
    ranThisInterval,
    fullyAllocated,
    remaining,
    enabled: config.enabled !== false,
    dryRun: config.dryRun === true,
  };
};

// Get summary for an exchange
app.get('/api/:exchange/summary', (req, res) => {
  const { exchange } = req.params;
  const config = getExchangeConfig(exchange);
  const state = stateTracker.loadState(config, exchange);
  const logFile = getLogFile(exchange);
  const transactions = parseTSV(logFile);

  const buys = transactions.filter(t => t.Type === 'BUY');
  const sells = transactions.filter(t => t.Type === 'SELL_FILLED');

  const totalBought = buys.reduce((sum, t) => sum + Math.abs(t['USDC Amount'] || 0), 0);
  const totalSold = sells.reduce((sum, t) => sum + (t['USDC Amount'] || 0), 0);
  const totalBTCBought = buys.reduce((sum, t) => sum + (t['BTC Amount'] || 0), 0);
  const totalBTCSold = sells.reduce((sum, t) => sum + Math.abs(t['BTC Amount'] || 0), 0);

  // Calculate realized profit from filled orders
  const filledOrders = (state.orders || []).filter(o => o.status === 'filled');
  const realizedProfit = filledOrders.reduce((sum, o) => {
    const proceeds = o.netProceeds || (o.sellQuantityBTC * (o.filledPrice || o.sellPrice));
    const cost = o.buyCostBasis || (o.buyQuantityBTC * o.buyPrice);
    const costForSold = o.buyQuantityBTC > 0 ? cost * (o.sellQuantityBTC / o.buyQuantityBTC) : 0;
    return sum + (proceeds - costForSold);
  }, 0);

  const costBasis = calculateCostBasis(state, transactions);
  const nextTrade = getNextTradeInfo(config, state);

  res.json({
    exchange,
    config,
    state,
    stats: {
      totalBuys: buys.length,
      totalSells: sells.length,
      pendingOrders: (state.orders || []).filter(o => o.status === 'pending').length,
      totalBought,
      totalSold,
      totalBTCBought,
      totalBTCSold,
      totalFees: state.totalFees || 0,
      totalRebates: state.totalRebates || 0,
      netFees: state.netFees || 0,
      btcReserves: state.btcReserves || 0,
      usdcFundSize: state.usdcFundSize || 0,
      outstandingOrdersUSDC: state.outstandingOrdersUSDC || 0,
      outstandingOrdersBTC: state.outstandingOrdersBTC || 0,
      allocationUsed: state.totalAllocated || 0,
      allocationRemaining: (config.totalAllocation || 0) - (state.totalAllocated || 0),
      intervalsRun: state.totalIntervalsRun || 0,
      realizedProfit,
    },
    costBasis,
    nextTrade,
    transactions: transactions.slice(-50),
  });
});

// Sync pending orders for an exchange
app.post('/api/:exchange/sync', async (req, res) => {
  const { exchange } = req.params;
  const config = getExchangeConfig(exchange);
  const state = stateTracker.loadState(config, exchange);

  const filledOrders = await syncOrderStatuses(state, exchange);
  if (filledOrders.length > 0) {
    stateTracker.saveState(state, exchange);
  }

  res.json({
    success: true,
    exchange,
    filledOrders: filledOrders.length,
    lastSyncTime: new Date().toISOString(),
  });
});

// Trigger trade for an exchange
app.post('/api/:exchange/trade', async (req, res) => {
  const { exchange } = req.params;
  log('INFO', `[${exchange}] Manual trade triggered via API`);

  const result = await runIntervalCycle(exchange);
  res.json({ ...result, triggeredAt: new Date().toISOString(), trigger: 'manual' });
});

// Consolidate pending orders for an exchange
app.post('/api/:exchange/consolidate', async (req, res) => {
  const { exchange } = req.params;
  const { orderIds } = req.body || {};

  log('INFO', `[${exchange}] Consolidation triggered via API`);

  // Check if we have enough orders
  const config = getExchangeConfig(exchange);
  const state = stateTracker.loadState(config, exchange);
  const pendingOrders = (state.orders || []).filter(o => o.status === 'pending');

  // Filter to specific order IDs if provided
  const ordersToConsolidate = orderIds && orderIds.length > 0
    ? pendingOrders.filter(o => orderIds.includes(o.orderId))
    : pendingOrders;

  if (ordersToConsolidate.length < 2) {
    return res.status(400).json({
      success: false,
      error: `Need at least 2 pending orders to consolidate, found ${ordersToConsolidate.length}`,
    });
  }

  const result = await executeConsolidation(exchange, orderIds);
  res.json({
    ...result,
    triggeredAt: new Date().toISOString(),
    trigger: 'manual',
  });
});

// ============ Regime Engine API ============

// Get regime configuration for an exchange
app.get('/api/:exchange/regime/config', (req, res) => {
  const { exchange } = req.params;
  const config = getRegimeConfig(exchange);
  res.json({ success: true, exchange, config });
});

// Update regime configuration for an exchange
app.put('/api/:exchange/regime/config', (req, res) => {
  const { exchange } = req.params;
  const updates = req.body;

  const validation = validateRegimeConfig({ ...getRegimeConfig(exchange), ...updates });
  if (!validation.valid) {
    return res.status(400).json({ success: false, errors: validation.errors });
  }

  const config = updateRegimeConfig(exchange, updates);
  log('INFO', `🔧 [${exchange}] Regime config updated`);

  // If engine is running, notify it of config change
  const engine = regimeEngines.get(exchange);
  if (engine) {
    engine.updateConfig(updates);
  }

  res.json({ success: true, exchange, config });
});

// Get regime engine status
app.get('/api/:exchange/regime/status', (req, res) => {
  const { exchange } = req.params;
  const engine = regimeEngines.get(exchange);

  if (!engine) {
    return res.json({
      success: true,
      exchange,
      running: false,
      status: null,
    });
  }

  const status = engine.getStatus();
  res.json({
    success: true,
    exchange,
    running: true,
    status,
  });
});

// Start regime engine for an exchange
app.post('/api/:exchange/regime/start', async (req, res) => {
  const { exchange } = req.params;
  const { getAdapter } = require('./src/adapters');

  // Check if already running
  if (regimeEngines.has(exchange)) {
    return res.status(400).json({
      success: false,
      error: 'Regime engine already running for this exchange',
    });
  }

  const exchangeConfig = getExchangeConfig(exchange);
  const adapter = getAdapter(exchange);

  // Check if keys are configured
  if (!adapter.hasValidKeys || !adapter.hasValidKeys()) {
    return res.status(400).json({
      success: false,
      error: 'API keys not configured for this exchange',
    });
  }

  // Create and start the engine
  const engine = createRegimeEngine(exchange, exchangeConfig, {
    onTradeEvent: (event) => io.emit('trade:event', event),
    onRegimeChange: (prevMode, newMode, reason) => io.emit('regime:change', { exchange, prevMode, newMode, reason, message: `${prevMode} -> ${newMode}` }),
    onHealthChange: (mode, reason) => io.emit('regime:health', { exchange, mode, reason, message: reason || `Health: ${mode}` }),
    onPositionUpdate: (data) => io.emit('regime:position', { exchange, ...data }),
    onStatusUpdate: (status) => io.emit('regime:status', { exchange, status }),
  });

  regimeEngines.set(exchange, engine);

  const startResult = await engine.start();

  if (!startResult.success) {
    regimeEngines.delete(exchange);
    return res.status(500).json({
      success: false,
      error: startResult.error || 'Failed to start regime engine',
    });
  }

  log('INFO', `🚀 [${exchange}] Regime engine started`);

  res.json({
    success: true,
    exchange,
    status: engine.getStatus(),
  });
});

// Stop regime engine for an exchange
app.post('/api/:exchange/regime/stop', async (req, res) => {
  const { exchange } = req.params;
  const engine = regimeEngines.get(exchange);

  if (!engine) {
    return res.status(400).json({
      success: false,
      error: 'Regime engine not running for this exchange',
    });
  }

  await engine.stop();
  regimeEngines.delete(exchange);

  log('INFO', `🛑 [${exchange}] Regime engine stopped`);

  res.json({
    success: true,
    exchange,
    stopped: true,
  });
});

// Pause regime engine (enter SAFE mode)
app.post('/api/:exchange/regime/pause', (req, res) => {
  const { exchange } = req.params;
  const { reason } = req.body;
  const engine = regimeEngines.get(exchange);

  if (!engine) {
    return res.status(400).json({
      success: false,
      error: 'Regime engine not running for this exchange',
    });
  }

  engine.pause(reason || 'Manual pause via API');

  log('INFO', `⏸️ [${exchange}] Regime engine paused: ${reason || 'manual'}`);

  res.json({
    success: true,
    exchange,
    paused: true,
    status: engine.getStatus(),
  });
});

// Resume regime engine (exit SAFE mode)
app.post('/api/:exchange/regime/resume', (req, res) => {
  const { exchange } = req.params;
  const engine = regimeEngines.get(exchange);

  if (!engine) {
    return res.status(400).json({
      success: false,
      error: 'Regime engine not running for this exchange',
    });
  }

  engine.resume();

  log('INFO', `▶️ [${exchange}] Regime engine resumed`);

  res.json({
    success: true,
    exchange,
    resumed: true,
    status: engine.getStatus(),
  });
});

// Force regime transition
app.post('/api/:exchange/regime/force-regime', (req, res) => {
  const { exchange } = req.params;
  const { regime, reason } = req.body;
  const engine = regimeEngines.get(exchange);

  if (!engine) {
    return res.status(400).json({
      success: false,
      error: 'Regime engine not running for this exchange',
    });
  }

  const validRegimes = ['HARVEST', 'CAUTION', 'TREND'];
  if (!regime || !validRegimes.includes(regime.toUpperCase())) {
    return res.status(400).json({
      success: false,
      error: `Invalid regime. Must be one of: ${validRegimes.join(', ')}`,
    });
  }

  engine.forceRegime(regime.toUpperCase(), reason || 'Forced via API');

  log('INFO', `🔄 [${exchange}] Regime forced to ${regime.toUpperCase()}: ${reason || 'manual'}`);

  res.json({
    success: true,
    exchange,
    regime: regime.toUpperCase(),
    status: engine.getStatus(),
  });
});

// Get regime engine fill ledger
app.get('/api/:exchange/regime/fills', (req, res) => {
  const { exchange } = req.params;
  const engine = regimeEngines.get(exchange);

  if (!engine) {
    // Try to load from disk if engine not running
    const { createFillLedger } = require('./src/fill-ledger');
    const ledger = createFillLedger(exchange);
    const fills = ledger.getAllFills();
    const stats = ledger.getStats();

    return res.json({
      success: true,
      exchange,
      running: false,
      fills,
      stats,
    });
  }

  const fills = engine.getFills();
  const stats = engine.getFillStats();

  res.json({
    success: true,
    exchange,
    running: true,
    fills,
    stats,
  });
});

// Get dry-run decision log
app.get('/api/:exchange/regime/dry-run/log', (req, res) => {
  const { exchange } = req.params;
  const limit = parseInt(req.query.limit) || 100;
  const engine = regimeEngines.get(exchange);

  if (!engine) {
    return res.status(400).json({
      success: false,
      error: 'Regime engine not running',
    });
  }

  if (!engine.isDryRun) {
    return res.status(400).json({
      success: false,
      error: 'Regime engine is not in dry-run mode',
    });
  }

  const log = engine.getDryRunLog(limit);
  res.json({
    success: true,
    exchange,
    isDryRun: true,
    log,
  });
});

// Get dry-run P&L summary
app.get('/api/:exchange/regime/dry-run/pnl', (req, res) => {
  const { exchange } = req.params;
  const engine = regimeEngines.get(exchange);

  if (!engine) {
    return res.status(400).json({
      success: false,
      error: 'Regime engine not running',
    });
  }

  if (!engine.isDryRun) {
    return res.status(400).json({
      success: false,
      error: 'Regime engine is not in dry-run mode',
    });
  }

  const pnl = engine.getDryRunPnL();
  const state = engine.getState();

  res.json({
    success: true,
    exchange,
    isDryRun: true,
    pnl,
    position: state.position,
    cyclesCompleted: state.position.cyclesCompleted,
    realizedPnL: state.position.realizedPnL,
    unrealizedPnL: state.position.unrealizedPnL,
  });
});

// Reset dry-run state
app.post('/api/:exchange/regime/dry-run/reset', (req, res) => {
  const { exchange } = req.params;
  const engine = regimeEngines.get(exchange);

  if (!engine) {
    return res.status(400).json({
      success: false,
      error: 'Regime engine not running',
    });
  }

  if (!engine.isDryRun) {
    return res.status(400).json({
      success: false,
      error: 'Regime engine is not in dry-run mode',
    });
  }

  const reset = engine.resetDryRun();
  res.json({
    success: reset,
    exchange,
    message: reset ? 'Dry-run state reset successfully' : 'Failed to reset dry-run state',
    status: engine.getStatus(),
  });
});

// Get full dry-run state (orders, fills, log, pnl)
app.get('/api/:exchange/regime/dry-run/state', (req, res) => {
  const { exchange } = req.params;
  const engine = regimeEngines.get(exchange);

  if (!engine) {
    return res.status(400).json({
      success: false,
      error: 'Regime engine not running',
    });
  }

  const state = engine.getState();

  if (!state.isDryRun) {
    return res.status(400).json({
      success: false,
      error: 'Regime engine is not in dry-run mode',
    });
  }

  res.json({
    success: true,
    exchange,
    isDryRun: true,
    dryRunState: state.dryRun,
    position: state.position,
    regime: state.regime,
    market: state.market,
  });
});

// ============ Keys Management API ============

// Check if keys exist for an exchange
app.get('/api/:exchange/keys/status', (req, res) => {
  const { exchange } = req.params;
  const keysPath = getExchangeKeysPath(exchange);
  const exists = fs.existsSync(keysPath);

  res.json({
    exchange,
    configured: exists,
    path: keysPath,
  });
});

// Get keys for an exchange (with secrets partially masked)
app.get('/api/:exchange/keys', (req, res) => {
  const { exchange } = req.params;
  const keysPath = getExchangeKeysPath(exchange);

  if (!fs.existsSync(keysPath)) {
    return res.json({ configured: false, keys: {} });
  }

  const keysData = JSON.parse(fs.readFileSync(keysPath, 'utf8'));

  // For Coinbase, show full name (API key ID) and masked privateKey
  // For Gemini, show full apiKey and masked apiSecret
  const maskedKeys = {};

  if (exchange === 'coinbase') {
    maskedKeys.name = keysData.name || keysData.apiKey || '';
    maskedKeys.privateKey = keysData.privateKey || keysData.apiSecret || '';
  } else {
    maskedKeys.apiKey = keysData.apiKey || keysData.key || '';
    maskedKeys.apiSecret = keysData.apiSecret || keysData.secret || '';
  }

  res.json({ configured: true, keys: maskedKeys });
});

// Save keys for an exchange (POST)
app.post('/api/:exchange/keys', (req, res) => {
  const { exchange } = req.params;
  const body = req.body;

  // Handle different key formats based on exchange
  let keysData;
  if (exchange === 'coinbase') {
    if (!body.name || !body.privateKey) {
      return res.status(400).json({ success: false, error: 'name and privateKey are required for Coinbase' });
    }
    keysData = {
      name: body.name,
      privateKey: body.privateKey,
      createdAt: new Date().toISOString(),
    };
  } else {
    if (!body.apiKey || !body.apiSecret) {
      return res.status(400).json({ success: false, error: 'apiKey and apiSecret are required' });
    }
    keysData = {
      apiKey: body.apiKey,
      apiSecret: body.apiSecret,
      createdAt: new Date().toISOString(),
    };
  }

  const keysPath = getExchangeKeysPath(exchange);

  // Ensure data directory exists
  const dir = path.dirname(keysPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(keysPath, JSON.stringify(keysData, null, 2));
  log('INFO', `[${exchange}] API keys configured`);

  res.json({ success: true, exchange, configured: true });
});

// Save keys for an exchange (PUT - same as POST)
app.put('/api/:exchange/keys', (req, res) => {
  const { exchange } = req.params;
  const body = req.body;

  // Handle different key formats based on exchange
  let keysData;
  if (exchange === 'coinbase') {
    if (!body.name || !body.privateKey) {
      return res.status(400).json({ success: false, error: 'name and privateKey are required for Coinbase' });
    }
    keysData = {
      name: body.name,
      privateKey: body.privateKey,
      createdAt: new Date().toISOString(),
    };
  } else {
    if (!body.apiKey || !body.apiSecret) {
      return res.status(400).json({ success: false, error: 'apiKey and apiSecret are required' });
    }
    keysData = {
      apiKey: body.apiKey,
      apiSecret: body.apiSecret,
      createdAt: new Date().toISOString(),
    };
  }

  const keysPath = getExchangeKeysPath(exchange);

  // Ensure data directory exists
  const dir = path.dirname(keysPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(keysPath, JSON.stringify(keysData, null, 2));
  log('INFO', `[${exchange}] API keys configured`);

  res.json({ success: true, exchange, configured: true });
});

// Test connection for an exchange
app.post('/api/:exchange/test-connection', async (req, res) => {
  const { exchange } = req.params;
  const { getAdapter } = require('./src/adapters');

  const adapter = getAdapter(exchange);

  // Get quote currency from config based on productId
  // loadConfig(exchange) returns exchange-specific config directly
  const exchangeConfig = loadConfig(exchange);
  const productId = exchangeConfig.productId || '';

  // Extract quote currency from productId (e.g., BTC-USDC -> USDC, BTC_USDT -> USDT)
  const parts = productId.replace('_', '-').split('-');
  let quoteCurrency = parts[1] || 'USD';

  // Handle Gemini special case (USDC -> USD)
  if (exchange === 'gemini' && quoteCurrency === 'USDC') {
    quoteCurrency = 'USD';
  }

  // Check if keys are configured
  if (!adapter.hasValidKeys || !adapter.hasValidKeys()) {
    return res.json({
      success: false,
      exchange,
      error: 'API keys not configured or invalid. Please save valid API keys first.',
    });
  }

  try {
    const balance = await adapter.getAccountBalance(quoteCurrency);
    res.json({
      success: true,
      exchange,
      balance,
      quoteCurrency,
    });
  } catch (err) {
    res.json({
      success: false,
      exchange,
      error: err.message || 'Connection failed',
    });
  }
});

// Delete keys for an exchange
app.delete('/api/:exchange/keys', (req, res) => {
  const { exchange } = req.params;
  const keysPath = getExchangeKeysPath(exchange);

  if (fs.existsSync(keysPath)) {
    fs.unlinkSync(keysPath);
    log('INFO', `[${exchange}] API keys deleted`);
  }

  res.json({ success: true, exchange, configured: false });
});

// ============ Legacy API Routes (backward compatibility) ============

// Get current config (returns coinbase config for backward compatibility)
app.get('/api/config', (req, res) => {
  const config = getExchangeConfig('coinbase');
  res.json(config);
});

// Update config (updates coinbase config for backward compatibility)
app.put('/api/config', (req, res) => {
  const config = req.body;
  updateExchangeConfig('coinbase', config);
  res.json({ success: true, config });
});

app.patch('/api/config', (req, res) => {
  const { enabled, dryRun } = req.body;

  if (typeof enabled === 'boolean') {
    setExchangeEnabled('coinbase', enabled);
  }

  if (typeof dryRun === 'boolean') {
    setExchangeDryRun('coinbase', dryRun);
  }

  const config = getExchangeConfig('coinbase');
  res.json({ success: true, config });
});

app.get('/api/state', (req, res) => {
  const config = getExchangeConfig('coinbase');
  const state = stateTracker.loadState(config, 'coinbase');
  res.json(state);
});

app.get('/api/transactions', (req, res) => {
  const logFile = getLogFile('coinbase');
  const transactions = parseTSV(logFile);
  res.json(transactions);
});

app.get('/api/status', async (req, res) => {
  const { getAdapter } = require('./src/adapters');
  const config = getExchangeConfig('coinbase');
  const state = stateTracker.loadState(config, 'coinbase');

  let currentPrice = 0;
  let usdcBalance = { available: 0, hold: 0 };
  let btcBalance = { available: 0, hold: 0 };
  let keysConfigured = false;
  let apiError = null;

  const adapter = getAdapter('coinbase');

  // Check if keys are configured before making API calls
  if (adapter.hasValidKeys && adapter.hasValidKeys()) {
    keysConfigured = true;
    try {
      currentPrice = await adapter.getCurrentPrice(config.productId);
      usdcBalance = await adapter.getAccountBalance('USDC');
      btcBalance = await adapter.getAccountBalance('BTC');
    } catch (err) {
      apiError = err.message || 'API connection failed';
      log('ERROR', `[coinbase] Status check failed: ${apiError}`);
    }
  }

  res.json({
    currentPrice,
    usdcBalance,
    btcBalance,
    keysConfigured,
    apiError,
    config,
    state,
    lastUpdated: new Date().toISOString(),
  });
});

app.get('/api/summary', (req, res) => {
  const config = getExchangeConfig('coinbase');
  const state = stateTracker.loadState(config, 'coinbase');
  const logFile = getLogFile('coinbase');
  const transactions = parseTSV(logFile);

  const buys = transactions.filter(t => t.Type === 'BUY');
  const sells = transactions.filter(t => t.Type === 'SELL_FILLED');

  const totalBought = buys.reduce((sum, t) => sum + Math.abs(t['USDC Amount'] || 0), 0);
  const totalSold = sells.reduce((sum, t) => sum + (t['USDC Amount'] || 0), 0);
  const totalBTCBought = buys.reduce((sum, t) => sum + (t['BTC Amount'] || 0), 0);
  const totalBTCSold = sells.reduce((sum, t) => sum + Math.abs(t['BTC Amount'] || 0), 0);

  const costBasis = calculateCostBasis(state, transactions);
  const nextTrade = getNextTradeInfo(config, state);

  res.json({
    config,
    state,
    stats: {
      totalBuys: buys.length,
      totalSells: sells.length,
      pendingOrders: (state.orders || []).filter(o => o.status === 'pending').length,
      totalBought,
      totalSold,
      totalBTCBought,
      totalBTCSold,
      totalFees: state.totalFees || 0,
      totalRebates: state.totalRebates || 0,
      netFees: state.netFees || 0,
      btcReserves: state.btcReserves || 0,
      usdcFundSize: state.usdcFundSize || 0,
      outstandingOrdersUSDC: state.outstandingOrdersUSDC || 0,
      outstandingOrdersBTC: state.outstandingOrdersBTC || 0,
      allocationUsed: state.totalAllocated || 0,
      allocationRemaining: (config.totalAllocation || 0) - (state.totalAllocated || 0),
      intervalsRun: state.totalIntervalsRun || 0,
    },
    costBasis,
    nextTrade,
    transactions: transactions.slice(-50),
  });
});

app.post('/api/sync', async (req, res) => {
  const config = getExchangeConfig('coinbase');
  const state = stateTracker.loadState(config, 'coinbase');
  const filledOrders = await syncOrderStatuses(state, 'coinbase');

  if (filledOrders.length > 0) {
    stateTracker.saveState(state, 'coinbase');
  }

  res.json({ success: true, filledOrders: filledOrders.length, lastSyncTime: new Date().toISOString() });
});

app.get('/api/sync', (req, res) => {
  res.json({ lastSyncTime: new Date().toISOString() });
});

app.post('/api/trade', async (req, res) => {
  log('INFO', 'Manual trade triggered via API');
  const result = await runIntervalCycle('coinbase');
  res.json({ ...result, triggeredAt: new Date().toISOString(), trigger: 'manual' });
});

app.get('/api/trade', (req, res) => {
  res.json({ status: 'no_trades_yet' });
});

// ============ Backtest API ============

app.get('/api/:exchange/backtest/prices', async (req, res) => {
  const { exchange } = req.params;
  const intervals = parseInt(req.query.intervals) || 365;
  const intervalType = req.query.intervalType || 'daily';

  const prices = await backtestEngine.getPriceData(intervals, intervalType, exchange);
  res.json({ success: true, count: prices.length, intervalType, exchange, prices });
});

app.post('/api/:exchange/backtest/run', async (req, res) => {
  const { exchange } = req.params;

  // Get productId from request or fall back to config
  // loadConfig(exchange) returns exchange-specific config directly
  const exchangeConfig = loadConfig(exchange);
  const configProductId = exchangeConfig.productId || null;

  const {
    intervalBuyAmount = 500,
    sellMarkupPercent = 10,
    holdbackPercent = 5,
    feePercent = 0.125,
    rebatePercent = 0.031,
    intervals = 365,
    intervalType = 'daily',
    fundSize = 0,
    productId = configProductId
  } = req.body;

  const fundInfo = fundSize > 0 ? `, $${fundSize} fund` : ', unlimited funds';
  const intervalLabel = formatInterval(intervalType);
  log('INFO', `[${exchange}] Running backtest for ${productId}: ${intervals} ${intervalLabel} intervals, $${intervalBuyAmount}/interval, +${sellMarkupPercent}% markup, ${holdbackPercent}% holdback${fundInfo}`);

  const results = await backtestEngine.runBacktest({
    intervalBuyAmount,
    sellMarkupPercent,
    holdbackPercent,
    feePercent,
    rebatePercent,
    intervals,
    intervalType,
    fundSize,
    exchange,
    productId
  });

  log('INFO', `[${exchange}] Backtest complete: ROI ${results.metrics.roi.toFixed(2)}%, ${results.metrics.sellsFilled}/${results.metrics.totalSells} sells filled`);
  res.json({ success: true, ...results });
});

// ============ Optimizer API ============

const optimizerEngine = require('./src/optimizer-engine');

const getOptimizerCacheFile = (exchange) => path.join(DATA_DIR, exchange, 'optimizer-cache.json');

app.get('/api/:exchange/optimizer/cache', (req, res) => {
  const { exchange } = req.params;
  const cacheFile = getOptimizerCacheFile(exchange);
  const cache = readJSON(cacheFile, null);
  if (cache) {
    res.json({ success: true, cached: true, ...cache });
  } else {
    res.json({ success: true, cached: false });
  }
});

app.delete('/api/:exchange/optimizer/cache', (req, res) => {
  const { exchange } = req.params;
  const cacheFile = getOptimizerCacheFile(exchange);
  if (fs.existsSync(cacheFile)) {
    fs.unlinkSync(cacheFile);
    log('INFO', `Optimizer cache cleared for ${exchange}`);
  }
  res.json({ success: true, message: 'Cache cleared' });
});

let currentBestResult = null;

app.post('/api/:exchange/optimizer/run', (req, res) => {
  const { exchange } = req.params;

  // Get productId from config - loadConfig(exchange) returns exchange-specific config directly
  const exchangeConfig = loadConfig(exchange);
  const configProductId = exchangeConfig.productId || null;

  const {
    fundSize = 10000,
    forceRefresh = false,
    productId = configProductId,
    intervals = null,  // Custom intervals to test (null = use defaults)
    markups = null,    // Custom markups to test (null = use defaults)
    periods = null,    // Custom periods to test (null = use defaults)
    buyAmounts = null  // Custom buy amounts per interval (null = use defaults)
  } = req.body;
  const cacheFile = getOptimizerCacheFile(exchange);

  // Create a config key for cache validation (includes selected options)
  const configKey = JSON.stringify({ intervals, markups, periods });

  if (!forceRefresh) {
    const cache = readJSON(cacheFile, null);
    // Check cache matches fundSize, productId, and config options
    const cacheConfigKey = JSON.stringify({
      intervals: cache?.config?.intervals,
      markups: cache?.config?.markups,
      periods: cache?.config?.periods
    });
    if (cache && cache.fundSize === fundSize && cache.productId === productId && configKey === cacheConfigKey) {
      log('INFO', `[${exchange}] Returning cached optimizer results for ${productId}, fund size: $${fundSize}`);
      res.json({ success: true, cached: true, ...cache });
      return;
    }
  }

  const totalTests = (intervals?.length || 6) * (markups?.length || 9) * (periods?.length || 4);
  log('INFO', `[${exchange}] Running optimizer for ${productId} with fund size: $${fundSize} (${totalTests} combinations)`);
  currentBestResult = null;

  // Respond immediately - results will come via WebSocket
  res.json({ success: true, streaming: true, message: 'Optimizer started, results will stream via WebSocket' });

  optimizerEngine.runOptimizer({
    fundSize,
    exchange,
    forceRefresh,
    productId,
    intervals,
    markups,
    periods,
    buyAmounts,
    onProgress: (progress) => {
      io.emit('optimizer:progress', progress);

      if (progress.latestResult) {
        if (!currentBestResult || progress.latestResult.metrics.totalValue > currentBestResult.metrics.totalValue) {
          currentBestResult = progress.latestResult;
          io.emit('optimizer:newBest', currentBestResult);
        }
      }

      if (progress.current % 20 === 0 || progress.phase === 'prefetch') {
        log('INFO', `[${exchange}] Optimizer: ${progress.message} (${progress.percentComplete}%)`);
      }
    }
  })
    .then(result => {
      log('INFO', `[${exchange}] Optimizer complete: ${result.totalCombinations} combinations in ${(result.duration / 1000).toFixed(1)}s`);
      log('INFO', `[${exchange}] Best result: ${result.bestResult.params.intervalType} ${result.bestResult.params.sellMarkupPercent}% markup -> $${result.bestResult.metrics.totalValue.toFixed(2)}`);

      const topResults = optimizerEngine.getTopResults(result.results, 20);
      const response = {
        success: true,
        cached: false,
        cachedAt: new Date().toISOString(),
        fundSize,
        productId: result.productId,
        totalCombinations: result.totalCombinations,
        duration: result.duration,
        bestResult: result.bestResult,
        topResults,
        config: result.config
      };

      writeJSON(cacheFile, response);
      log('INFO', `[${exchange}] Optimizer results cached`);

      io.emit('optimizer:complete', response);
    })
    .catch(err => {
      log('ERROR', `[${exchange}] Optimizer failed: ${err.message}`);
      io.emit('optimizer:error', { error: err.message });
      // Don't try to send response here - we already responded with streaming: true
    });
});

// ============ Static Files ============

app.use(express.static(path.join(__dirname, 'admin', 'dist')));

app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'admin', 'dist', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Admin UI not built. Run: cd admin && npm run build');
  }
});

// ============ WebSocket ============

// Import trade events for real-time updates
const { tradeEvents } = require('./src/trade-events');

// Broadcast trade events to all connected clients
tradeEvents.on('trade', (event) => {
  io.emit('trade:event', event);
});

io.on('connection', (socket) => {
  log('INFO', `WebSocket client connected: ${socket.id}`);
  socket.on('disconnect', () => {
    log('INFO', `WebSocket client disconnected: ${socket.id}`);
  });
});

// ============ Scheduler ============

const schedulerState = {};

const checkAndRunIntervalTrade = () => {
  const enabledExchanges = getEnabledExchanges();

  for (const exchange of enabledExchanges) {
    const config = normalizeConfig(getExchangeConfig(exchange));
    const { intervalType } = config;

    if (!schedulerState[exchange]) {
      // Initialize with nextExecutionTime=0 so first check passes immediately
      // The duplicate-prevention is handled by hasRunThisInterval check
      schedulerState[exchange] = { lastRunId: null, nextExecutionTime: 0 };
    }

    if (hasRunThisInterval(schedulerState[exchange].lastRunId, intervalType)) {
      continue;
    }

    const now = Date.now();
    const nextExec = schedulerState[exchange].nextExecutionTime;

    if (now >= nextExec) {
      const intervalLabel = formatInterval(intervalType);
      log('INFO', `[${exchange}] Scheduled ${intervalLabel} trade starting at ${new Date().toISOString()}`);
      schedulerState[exchange].lastRunId = getRunIdentifier(intervalType);
      schedulerState[exchange].nextExecutionTime = getNextExecutionTime(intervalType);

      runIntervalCycle(exchange)
        .then(result => {
          log('INFO', `[${exchange}] Scheduled trade complete: ${result.status}`);
        })
        .catch(err => {
          log('ERROR', `[${exchange}] Scheduled trade failed: ${err.message}`);
        });
    }
  }
};

// ============ Start Server ============

server.listen(PORT, () => {
  const enabledExchanges = getEnabledExchanges();

  log('INFO', `DCA Trading Bot running on http://localhost:${PORT}`);
  log('INFO', `Configured exchanges: ${getConfiguredExchanges().join(', ')}`);
  log('INFO', `Enabled exchanges: ${enabledExchanges.length > 0 ? enabledExchanges.join(', ') : 'none'}`);

  // Show next trade time for each enabled exchange
  for (const exchange of enabledExchanges) {
    const config = normalizeConfig(getExchangeConfig(exchange));
    const intervalLabel = formatInterval(config.intervalType);
    const timeUntilNext = getTimeUntilNext(config.intervalType);
    log('INFO', `[${exchange}] Interval: ${intervalLabel}, next trade in ${timeUntilNext.formatted}`);
  }

  // Check for scheduled trades every 30 seconds
  const globalConfig = getGlobalConfig();
  setInterval(checkAndRunIntervalTrade, globalConfig.schedulerInterval || 30000);

  // Check immediately on startup
  checkAndRunIntervalTrade();
});
