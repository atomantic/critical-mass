const express = require('express');
const { spawn } = require('child_process');

const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const { log } = require('./src/logger');
const { runMigrationIfNeeded } = require('./src/migration');
const { apiAuthMiddleware, validateSocketToken } = require('./src/auth-middleware');
const rateLimit = require('express-rate-limit');
const {
  getExchangeConfig,
  getEnabledExchanges,
  getConfiguredExchanges,
  getGlobalConfig,
  getBackupConfig,
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
const { createNotifier } = require('./src/notifier');
const { createBackup, pruneBackups } = require('./src/backup-service');
const { DATA_DIR } = require('./src/paths');
const {
  readJSON,
  writeJSON,
  parseTSV,
  calculateCostBasis,
  getNextTradeInfo,
} = require('./src/shared-utils');
const { createIPCClient } = require('./src/ipc/ipc-client');
const { createUpDownService } = require('./src/updown/updown-service');
const { createCandleCache } = require('./src/candle-cache');
const { createSentinelService } = require('./src/sentinel/sentinel-service');
const { getSentinelConfig, updateSentinelConfig } = require('./src/config-utils');

// Run migration on startup
runMigrationIfNeeded();

// ============ Server Setup ============

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5563;

// Trust the first hop when running behind a reverse proxy (e.g. Umbrel app_proxy).
// This ensures rate limiters use the real client IP from X-Forwarded-For instead of
// treating all requests as coming from the proxy/container address.
app.set('trust proxy', 1);

// CORS allowlist -- only local dev and the server itself
const CORS_ORIGINS = (process.env.CORS_ORIGINS || `http://localhost:${PORT},http://localhost:5564`).split(',').map(s => s.trim());

const io = new Server(server, {
  cors: { origin: CORS_ORIGINS }
});

// Notification system
const notifier = createNotifier();

// ============ Middleware ============

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (CORS_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});

// ============ Rate Limiting ============
// Mounted BEFORE express.json() so the body is not parsed for rate-limited requests.

// Global rate limit: 100 requests per minute across all /api/* routes.
const globalApiLimiter = rateLimit({
  windowMs: 60_000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later.' },
});

// Tighter limit for the screenshot analysis endpoint (AI calls are expensive).
const screenshotLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Screenshot endpoint rate limit exceeded (5/min).' },
});

app.use('/api/', globalApiLimiter);
app.use('/api/updown/screenshot', screenshotLimiter);

// ============ API Authentication ============
// Mounted BEFORE express.json() so unauthenticated request bodies are not parsed.

// Bearer token auth — protects all /api/* routes.
// When API_TOKEN env var is set, requests must supply:
//   Authorization: Bearer <token>
// Fails closed by default — set ALLOW_UNAUTHENTICATED_API=true for development only.
app.use('/api/', apiAuthMiddleware);

// Parse JSON bodies after rate limiting and auth to reduce wasted CPU/memory.
app.use(express.json({ limit: '1mb' }));

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

// ============ Crypto Exchange Engine IPC ============

const COINBASE_IPC_PORT = parseInt(process.env.COINBASE_IPC_PORT) || 5570;
const GEMINI_IPC_PORT = parseInt(process.env.GEMINI_IPC_PORT) || 5571;
const CRYPTOCOM_IPC_PORT = parseInt(process.env.CRYPTOCOM_IPC_PORT) || 5574;

/** @type {Array<(name: string, msg: Object) => void>} */
const ipcEventListeners = [];

const createExchangeIPC = (port, name) => {
  const client = createIPCClient(`ws://127.0.0.1:${port}`, name, {
    onEvent: (msg) => {
      if (msg.room) {
        io.to(msg.room).emit(msg.channel, msg.payload);
      } else {
        io.emit(msg.channel, msg.payload);
      }
      for (const listener of ipcEventListeners) listener(name, msg);
    },
    onConnect: () => log('INFO', `🔗 Gateway connected to ${name} engine IPC`),
    onDisconnect: () => log('INFO', `🔗 Gateway disconnected from ${name} engine IPC`),
  });
  client.connect();
  return client;
};

const coinbaseIPC = createExchangeIPC(COINBASE_IPC_PORT, 'coinbase');
const geminiIPC = createExchangeIPC(GEMINI_IPC_PORT, 'gemini');
const cryptocomIPC = createExchangeIPC(CRYPTOCOM_IPC_PORT, 'cryptocom');

const exchangeIPCMap = { coinbase: coinbaseIPC, gemini: geminiIPC, cryptocom: cryptocomIPC };

// ============ Shared Candle Cache ============

const candleCache = createCandleCache();

// Feed ALL exchange IPC ticks into the shared candle cache
ipcEventListeners.push((name, msg) => {
  if (msg.channel === 'regime:status') {
    const market = msg.payload?.status?.market || msg.payload?.market;
    if (market?.lastPrice) {
      const price = parseFloat(market.lastPrice);
      if (!Number.isFinite(price) || price <= 0) return;
      candleCache.processTick(name, price, Date.now(), parseFloat(market.volume24h) || 0);
    }
  }
});

// Seed candle cache from public APIs (non-blocking)
candleCache.seedAll();

// ============ UpDown Service ============

const updownService = createUpDownService(io, { exchangeIPCMap, readJSON, writeJSON, DATA_DIR, candleCache });

// Forward coinbase BTC price data to updown service for Socket.IO emission + P&L
ipcEventListeners.push((name, msg) => {
  if (name === 'coinbase' && msg.channel === 'regime:status') {
    const market = msg.payload?.status?.market || msg.payload?.market;
    if (market?.lastPrice) {
      const price = parseFloat(market.lastPrice);
      if (!Number.isFinite(price) || price <= 0) return;
      updownService.handlePriceTick(price, Date.now());
    }
  }
});

updownService.start();

// ============ Sentinel Service ============

const sentinelService = createSentinelService(io, { readJSON, writeJSON, DATA_DIR, getSentinelConfig });
sentinelService.start();

// ============ Route Modules ============

const sharedDeps = { io, parseTSV, calculateCostBasis, getNextTradeInfo, readJSON, writeJSON, DATA_DIR, notifier, exchangeIPCMap, rescheduleBackupTimer };

require('./src/routes/sentinel-routes')(app, { ...sharedDeps, sentinelService, getSentinelConfig, updateSentinelConfig });
require('./src/routes/ai-routes')(app, sharedDeps);
require('./src/routes/settings-routes')(app, sharedDeps);
require('./src/routes/candle-routes')(app, { candleCache });
require('./src/routes/updown-routes')(app, { ...sharedDeps, updownService, candleCache });
require('./src/routes/exchange-routes')(app, sharedDeps);
require('./src/routes/regime-routes')(app, sharedDeps);
require('./src/routes/keys-routes')(app, sharedDeps);
require('./src/routes/backtest-routes')(app, sharedDeps);
require('./src/routes/legacy-routes')(app, sharedDeps);

// ============ Health Aggregation ============

app.get('/api/health', async (req, res) => {
  const timeout = 3000;
  const engines = {};
  let overallStatus = 'ok';

  // Fan out IPC health checks to all exchange engines
  const exchangeChecks = Object.entries(exchangeIPCMap).map(async ([name, ipc]) => {
    if (!ipc.isConnected()) {
      engines[name] = { status: 'unreachable', connected: false };
      overallStatus = 'degraded';
      return;
    }
    const status = await ipc.request('regime:status', {}, name, timeout).catch(() => null);
    engines[name] = {
      status: status?.health?.mode?.toLowerCase() || (status ? 'ok' : 'timeout'),
      connected: true,
      isRunning: status?.isRunning ?? false,
      mode: status?.health?.mode ?? null,
      uptime: status?.uptime ?? null,
    };
    if (engines[name].status === 'timeout') overallStatus = 'degraded';
  });

  await Promise.allSettled([...exchangeChecks]);

  // UpDown service (in-process, no IPC needed)
  const updownStatus = updownService.getStatus();
  engines.updown = {
    status: updownStatus.running ? 'ok' : 'stopped',
    running: updownStatus.running,
    lastPrice: updownStatus.lastPrice || null,
    latestSignal: updownStatus.latestSignal?.type || null,
  };

  // Sentinel service (in-process)
  const sentinelStatus = sentinelService.getStatus();
  engines.sentinel = {
    status: sentinelStatus.running ? 'ok' : 'stopped',
    running: sentinelStatus.running,
    activeAlerts: sentinelStatus.activeAlerts || 0,
    lastPollAt: sentinelStatus.lastPollAt || null,
  };

  // If any engine is unreachable and all are down, it's critical
  const allDown = Object.values(engines).every(e => e.status === 'unreachable' || e.status === 'timeout' || e.status === 'stopped');
  if (allDown) overallStatus = 'critical';

  res.json({
    status: overallStatus,
    gateway: { uptime: process.uptime(), pid: process.pid },
    engines,
    timestamp: new Date().toISOString(),
  });
});

// ============ Static Files ============

// Catch-all for unhandled API routes — return JSON 404 instead of falling through to HTML
app.all('/api/*splat', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use(express.static(path.join(__dirname, 'admin', 'dist')));

app.get('*splat', (req, res) => {
  const indexPath = path.join(__dirname, 'admin', 'dist', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Admin UI not built. Run: cd admin && npm run build');
  }
});

// ============ PM2 Log Streaming ============

const activeLogStreams = new Map(); // socketId -> { process, processName }

const ALLOWED_LOG_PROCESSES = new Set([
  'critical-mass', 'critical-mass-coinbase', 'critical-mass-gemini',
  'critical-mass-cryptocom',
]);

// ============ WebSocket ============

const { tradeEvents } = require('./src/trade-events');

tradeEvents.on('trade', (event) => {
  io.emit('trade:event', event);
});

io.on('connection', (socket) => {
  // Validate bearer token on WebSocket connections.
  // Clients should supply the token either as:
  //   socket.io handshake auth:  { auth: { token: '<API_TOKEN>' } }
  //   or as a query param:       ?token=<API_TOKEN>
  if (!validateSocketToken(socket)) {
    log('WARN', `WebSocket rejected (invalid token): ${socket.id} from ${socket.handshake.address}`);
    socket.emit('error', { message: 'Unauthorized: invalid or missing token' });
    socket.disconnect(true);
    return;
  }

  log('INFO', `WebSocket client connected: ${socket.id}`);
  socket.on('disconnect', () => {
    const entry = activeLogStreams.get(socket.id);
    if (entry?.process) {
      entry.process.kill();
      activeLogStreams.delete(socket.id);
      log('INFO', `📋 Log stream cleaned up for ${entry.processName} → ${socket.id}`);
    }
    log('INFO', `WebSocket client disconnected: ${socket.id}`);
  });

  // Room subscriptions for exchange events (forwarded from engine via IPC)
  socket.on('coinbase:subscribe', () => socket.join('coinbase'));
  socket.on('coinbase:unsubscribe', () => socket.leave('coinbase'));
  socket.on('gemini:subscribe', () => socket.join('gemini'));
  socket.on('gemini:unsubscribe', () => socket.leave('gemini'));
  socket.on('cryptocom:subscribe', () => socket.join('cryptocom'));
  socket.on('cryptocom:unsubscribe', () => socket.leave('cryptocom'));
  socket.on('composite:subscribe', () => socket.join('composite'));
  socket.on('updown:subscribe', () => socket.join('updown'));
  socket.on('updown:unsubscribe', () => socket.leave('updown'));
  socket.on('sentinel:subscribe', () => socket.join('sentinel'));
  socket.on('sentinel:unsubscribe', () => socket.leave('sentinel'));

  // PM2 log streaming
  socket.on('logs:subscribe', ({ processName, lines }) => {
    if (!ALLOWED_LOG_PROCESSES.has(processName)) {
      socket.emit('logs:error', { error: `Invalid process: ${processName}` });
      return;
    }
    const tailLines = Math.min(Math.max(parseInt(lines) || 500, 1), 5000);

    // Kill existing stream for this socket
    const existing = activeLogStreams.get(socket.id);
    if (existing?.process) {
      existing.process.kill();
    }

    const logProcess = spawn('pm2', ['logs', processName, '--raw', '--lines', String(tailLines)], { shell: false });
    activeLogStreams.set(socket.id, { process: logProcess, processName });

    let stdoutBuf = '';
    let stderrBuf = '';

    logProcess.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop();
      for (const line of lines) {
        if (line.trim()) {
          socket.emit('logs:line', { processName, line, type: 'stdout', timestamp: Date.now() });
        }
      }
    });

    logProcess.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop();
      for (const line of lines) {
        if (line.trim()) {
          socket.emit('logs:line', { processName, line, type: 'stderr', timestamp: Date.now() });
        }
      }
    });

    logProcess.on('error', (err) => {
      log('ERROR', `📋 Log stream error for ${processName}: ${err.message}`);
      socket.emit('logs:error', { error: err.message });
    });

    logProcess.on('close', () => {
      const entry = activeLogStreams.get(socket.id);
      if (entry?.process === logProcess) {
        activeLogStreams.delete(socket.id);
      }
    });

    socket.emit('logs:subscribed', { processName });
    log('INFO', `📋 Log stream started for ${processName} (${tailLines} lines) → ${socket.id}`);
  });

  socket.on('logs:unsubscribe', () => {
    const entry = activeLogStreams.get(socket.id);
    if (entry?.process) {
      entry.process.kill();
      activeLogStreams.delete(socket.id);
      socket.emit('logs:unsubscribed');
      log('INFO', `📋 Log stream stopped for ${entry.processName} → ${socket.id}`);
    }
  });

  socket.on('logs:flush', ({ processName }) => {
    if (!ALLOWED_LOG_PROCESSES.has(processName)) {
      socket.emit('logs:error', { error: `Invalid process: ${processName}` });
      return;
    }
    const flushProc = spawn('pm2', ['flush', processName], { shell: false });
    let output = '';
    flushProc.stdout.on('data', (chunk) => { output += chunk.toString(); });
    flushProc.stderr.on('data', (chunk) => { output += chunk.toString(); });
    flushProc.on('close', (code) => {
      socket.emit('logs:flushed', { processName, success: code === 0 });
      log('INFO', `📋 Log flush ${code === 0 ? 'succeeded' : 'failed'} for ${processName}`);
    });
    flushProc.on('error', (err) => {
      socket.emit('logs:flushed', { processName, success: false });
      log('ERROR', `📋 Log flush error for ${processName}: ${err.message}`);
    });
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

server.listen(PORT, () => {
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

  // Regime engine auto-resume is handled by engine processes (e.g. cm-coinbase)
  // Market data services are handled by engine processes

  // Start notification system
  notifier.start();

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

  // Engine processes handle their own shutdown via PM2
  coinbaseIPC.disconnect();
  geminiIPC.disconnect();
  cryptocomIPC.disconnect();

  updownService.stop();
  sentinelService.stop();

  // Kill all active log streams
  for (const [socketId, entry] of activeLogStreams) {
    entry.process?.kill();
  }
  activeLogStreams.clear();

  notifier.stop();

  if (backupTimer) {
    clearInterval(backupTimer);
    backupTimer = null;
  }

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
