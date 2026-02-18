const express = require('express');
const cors = require('cors');

const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const stateTracker = require('./src/state-tracker');
const { log } = require('./src/logger');
const { runMigrationIfNeeded } = require('./src/migration');
const {
  getExchangeConfig,
  getEnabledExchanges,
  getConfiguredExchanges,
  getGlobalConfig,
  getRegimeConfig,
  getBackupConfig,
  getKalshiConfig,
} = require('./src/config-utils');
const {
  normalizeConfig,
  getNextExecutionTime,
  getRunIdentifier,
  hasRunThisInterval,
  formatInterval,
  getTimeUntilNext,
} = require('./src/interval-utils');
const { runIntervalCycle } = require('./src/dca-engine');
const { createRegimeEngine } = require('./src/regime-engine');
const { startMarketDataService, stopAllMarketDataServices, getMarketDataService } = require('./src/market-data-service');
const { getChartDataBuffer, shutdownAllBuffers } = require('./src/chart-data-buffer');
const { createNotifier } = require('./src/notifier');
const { createBackup, pruneBackups } = require('./src/backup-service');

// Run migration on startup
runMigrationIfNeeded();

// ============ Server Setup ============

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5563;

// CORS allowlist -- only local dev and the server itself
const CORS_ORIGINS = (process.env.CORS_ORIGINS || `http://localhost:${PORT},http://localhost:5564`).split(',').map(s => s.trim());

const io = new Server(server, {
  cors: { origin: CORS_ORIGINS }
});

// Active regime engines by exchange
const regimeEngines = new Map();

// ============ Shared Helpers ============

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

// Helper to write JSON file (atomic: write .tmp then rename to prevent corruption)
const { atomicWriteSync } = stateTracker;
const writeJSON = (filepath, data) => {
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  atomicWriteSync(filepath, JSON.stringify(data, null, 2));
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

// ============ Regime Engine Helpers ============

const getRegimeRunningFlagPath = (exchange) => path.join(__dirname, 'data', exchange, 'regime-engine-running.json');

const saveRegimeRunningFlag = (exchange, isRunning) => {
  const flagPath = getRegimeRunningFlagPath(exchange);
  const dir = path.dirname(flagPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (isRunning) {
    fs.writeFileSync(flagPath, JSON.stringify({ running: true, startedAt: new Date().toISOString() }));
  } else if (fs.existsSync(flagPath)) {
    fs.unlinkSync(flagPath);
  }
};

const shouldAutoResumeRegime = (exchange) => {
  const flagPath = getRegimeRunningFlagPath(exchange);
  return fs.existsSync(flagPath);
};

const wireMarketDataCallbacks = (exchange) => {
  const service = getMarketDataService(exchange);
  if (!service) return;
  service.setOnStatusUpdate((status) => {
    getChartDataBuffer(exchange).processStatus(status);
    io.emit('regime:status', { exchange, status });
  });
};

// Notification system
const notifier = createNotifier();

// ============ Middleware ============

app.use(cors({ origin: CORS_ORIGINS }));
app.use(express.json());


// Exchange param validation middleware
const KNOWN_EXCHANGES = new Set(getConfiguredExchanges());
setInterval(() => { for (const e of getConfiguredExchanges()) KNOWN_EXCHANGES.add(e); }, 60_000);

app.param('exchange', (req, res, next, exchange) => {
  if (!/^[a-z0-9_-]+$/.test(exchange)) {
    return res.status(400).json({ success: false, error: `Invalid exchange name: ${exchange}` });
  }
  if (!KNOWN_EXCHANGES.has(exchange)) {
    return res.status(400).json({ success: false, error: `Unknown exchange: ${exchange}. Configured: ${[...KNOWN_EXCHANGES].join(', ')}` });
  }
  next();
});

// ============ Backup Scheduler ============

let backupTimer = null;

const rescheduleBackupTimer = () => {
  if (backupTimer) {
    clearInterval(backupTimer);
    backupTimer = null;
  }

  const backupConfig = getBackupConfig();
  if (!backupConfig.enabled) {
    log('INFO', '💾 Backup scheduler disabled');
    return;
  }

  backupTimer = setInterval(() => {
    const config = getBackupConfig();
    if (!config.enabled) return;

    log('INFO', '💾 Running scheduled backup...');
    const result = createBackup({ includePriceCache: config.includePriceCache });
    if (result.success) {
      const sizeMB = (result.sizeBytes / 1024 / 1024).toFixed(1);
      log('INFO', `💾 Scheduled backup created: ${result.filename} (${sizeMB} MB)`);
      const pruneResult = pruneBackups(config.maxBackups);
      if (pruneResult.pruned > 0) {
        log('INFO', `💾 Pruned ${pruneResult.pruned} old backups, ${pruneResult.remaining} remaining`);
      }
    } else {
      log('ERROR', `💾 Scheduled backup failed: ${result.error}`);
    }
  }, backupConfig.intervalMs);

  const hours = (backupConfig.intervalMs / 3600000).toFixed(1);
  log('INFO', `💾 Backup scheduler started: every ${hours}h, max ${backupConfig.maxBackups} backups`);
};

// ============ Route Modules ============

const sharedDeps = { regimeEngines, io, parseTSV, calculateCostBasis, getNextTradeInfo, readJSON, writeJSON, DATA_DIR, notifier, wireMarketDataCallbacks, saveRegimeRunningFlag, rescheduleBackupTimer };

// Kalshi prediction market routes (mounted before exchange routes to prevent /api/:exchange/* from intercepting /api/kalshi/*)
let kalshiLifecycle = null;
const kalshiConfig = getKalshiConfig();
if (kalshiConfig.enabled) {
  kalshiLifecycle = require('./src/routes/kalshi-routes')(app, sharedDeps);
  log('INFO', '📊 Kalshi routes mounted at /api/kalshi/');
} else {
  // Return proper JSON errors when Kalshi is disabled (instead of falling through to HTML catch-all)
  app.all('/api/kalshi/*', (req, res) => {
    res.status(503).json({ error: 'Kalshi is not enabled. Set kalshi.enabled to true in config.json and restart the server.' });
  });
  log('INFO', '📊 Kalshi disabled — /api/kalshi/* returns 503');
}

require('./src/routes/ai-routes')(app, sharedDeps);
require('./src/routes/settings-routes')(app, sharedDeps);
require('./src/routes/exchange-routes')(app, sharedDeps);
const { createEngineCallbacks } = require('./src/routes/regime-routes')(app, sharedDeps);
require('./src/routes/keys-routes')(app, sharedDeps);
require('./src/routes/backtest-routes')(app, sharedDeps);
require('./src/routes/legacy-routes')(app, sharedDeps);

// ============ Static Files ============

// Catch-all for unhandled API routes — return JSON 404 instead of falling through to HTML
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

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

const { tradeEvents } = require('./src/trade-events');

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
  if (!getGlobalConfig().simpleDcaEnabled) return;

  const enabledExchanges = getEnabledExchanges();

  for (const exchange of enabledExchanges) {
    const config = normalizeConfig(getExchangeConfig(exchange));
    const { intervalType } = config;

    if (!schedulerState[exchange]) {
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

server.listen(PORT, async () => {
  const enabledExchanges = getEnabledExchanges();

  const { version } = require('./package.json');
  log('INFO', `\n⚛  Critical Mass v${version}\n·  ·  · ◉ ·  ·  ·\nBTC Accumulation Engine\n`);
  log('INFO', `Critical Mass running on http://localhost:${PORT}`);
  log('INFO', `Configured exchanges: ${getConfiguredExchanges().join(', ')}`);
  log('INFO', `Enabled exchanges: ${enabledExchanges.length > 0 ? enabledExchanges.join(', ') : 'none'}`);

  for (const exchange of enabledExchanges) {
    const config = normalizeConfig(getExchangeConfig(exchange));
    const intervalLabel = formatInterval(config.intervalType);
    const timeUntilNext = getTimeUntilNext(config.intervalType);
    log('INFO', `[${exchange}] Interval: ${intervalLabel}, next trade in ${timeUntilNext.formatted}`);
  }

  // Auto-resume regime engines that were running before restart
  const configuredExchanges = getConfiguredExchanges();
  for (const exchange of configuredExchanges) {
    if (shouldAutoResumeRegime(exchange)) {
      log('INFO', `🔄 [${exchange}] Auto-resuming regime engine from previous session...`);

      const { getAdapter } = require('./src/adapters');
      const exchangeConfig = getExchangeConfig(exchange);
      const adapter = getAdapter(exchange);

      if (adapter.hasValidKeys && adapter.hasValidKeys()) {
        const engine = createRegimeEngine(exchange, exchangeConfig, createEngineCallbacks(exchange));
        regimeEngines.set(exchange, engine);

        const startResult = await engine.start();
        if (startResult.success) {
          log('INFO', `✅ [${exchange}] Regime engine auto-resumed successfully`);
        } else {
          log('ERROR', `❌ [${exchange}] Failed to auto-resume regime engine: ${startResult.error}`);
          regimeEngines.delete(exchange);
          saveRegimeRunningFlag(exchange, false);
        }
      } else {
        log('WARN', `⚠️ [${exchange}] Cannot auto-resume regime engine: API keys not configured`);
        saveRegimeRunningFlag(exchange, false);
      }
    }
  }

  // Start market data services for exchanges with regime config (but not running engines)
  for (const exchange of configuredExchanges) {
    const regimeConfig = getRegimeConfig(exchange);
    if (regimeConfig && Object.keys(regimeConfig).length > 0 && !regimeEngines.has(exchange)) {
      log('INFO', `📊 [${exchange}] Starting market data service for live price streaming...`);
      startMarketDataService(exchange).then(() => wireMarketDataCallbacks(exchange)).catch(err => {
        log('WARN', `⚠️ [${exchange}] Failed to start market data service: ${err.message}`);
      });
    }
  }

  // Auto-start Kalshi engine if it was running before restart
  if (kalshiLifecycle) {
    kalshiLifecycle.autoStartEngine().catch(err => {
      log('WARN', `⚠️ Kalshi auto-start failed: ${err.message}`);
    });
  }

  // Start notification system
  notifier.start(() => regimeEngines);

  // Start backup scheduler
  rescheduleBackupTimer();

  // Check for scheduled trades every 30 seconds
  const globalConfig = getGlobalConfig();
  setInterval(checkAndRunIntervalTrade, globalConfig.schedulerInterval || 30000);

  // Check immediately on startup
  checkAndRunIntervalTrade();
});

// ============ Graceful Shutdown ============

const gracefulShutdown = async (signal) => {
  log('INFO', `Received ${signal}, shutting down gracefully...`);

  log('INFO', 'Stopping market data services...');
  stopAllMarketDataServices();

  const stopPromises = [];
  for (const [exchange, engine] of regimeEngines) {
    log('INFO', `Stopping regime engine for ${exchange}...`);
    stopPromises.push(engine.stop());
  }

  await Promise.all(stopPromises);
  log('INFO', 'All regime engines stopped');

  // Stop Kalshi services (preserves engineRunning flag for auto-restart)
  if (kalshiLifecycle) {
    kalshiLifecycle.shutdown();
  }

  notifier.stop();

  if (backupTimer) {
    clearInterval(backupTimer);
    backupTimer = null;
  }

  shutdownAllBuffers();

  server.close(() => {
    log('INFO', 'Server closed');
    process.exit(0);
  });

  setTimeout(() => {
    log('WARN', 'Forcing exit after timeout');
    process.exit(1);
  }, 5000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
