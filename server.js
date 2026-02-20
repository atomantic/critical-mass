const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');

const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const { log } = require('./src/logger');
const { runMigrationIfNeeded } = require('./src/migration');
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
const {
  DATA_DIR,
  readJSON,
  writeJSON,
  parseTSV,
  calculateCostBasis,
  getNextTradeInfo,
} = require('./src/shared-utils');
const { createIPCClient } = require('./src/ipc/ipc-client');
const { createProxy } = require('./src/ipc/http-proxy');

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

// ============ Kalshi+Hedge IPC + HTTP Proxy ============

const KALSHI_HTTP_PORT = parseInt(process.env.KALSHI_HTTP_PORT) || 5572;
const KALSHI_IPC_PORT = parseInt(process.env.KALSHI_IPC_PORT) || 5573;

// IPC client: receives Socket.IO events from the Kalshi engine process
const kalshiIPC = createIPCClient(`ws://127.0.0.1:${KALSHI_IPC_PORT}`, 'kalshi', {
  onEvent: (msg) => {
    // Forward IPC events to Socket.IO clients
    if (msg.room) {
      io.to(msg.room).emit(msg.channel, msg.payload);
    } else {
      io.emit(msg.channel, msg.payload);
    }
  },
  onConnect: () => log('INFO', '🔗 Gateway connected to Kalshi engine IPC'),
  onDisconnect: () => log('INFO', '🔗 Gateway disconnected from Kalshi engine IPC'),
});
kalshiIPC.connect();

// HTTP reverse proxy: forwards /api/kalshi/* and /api/hedge/* to the Kalshi engine's Express server
const kalshiProxy = createProxy('127.0.0.1', KALSHI_HTTP_PORT, 'Kalshi');
app.use('/api/kalshi', kalshiProxy);
app.use('/api/hedge', kalshiProxy);
log('INFO', `📊 Kalshi+Hedge routes proxied to :${KALSHI_HTTP_PORT}`);

// ============ Crypto Exchange Engine IPC ============

const COINBASE_IPC_PORT = parseInt(process.env.COINBASE_IPC_PORT) || 5570;
const GEMINI_IPC_PORT = parseInt(process.env.GEMINI_IPC_PORT) || 5571;
const CRYPTOCOM_IPC_PORT = parseInt(process.env.CRYPTOCOM_IPC_PORT) || 5574;

const createExchangeIPC = (port, name) => {
  const client = createIPCClient(`ws://127.0.0.1:${port}`, name, {
    onEvent: (msg) => {
      if (msg.room) {
        io.to(msg.room).emit(msg.channel, msg.payload);
      } else {
        io.emit(msg.channel, msg.payload);
      }
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

// ============ Route Modules ============

const sharedDeps = { io, parseTSV, calculateCostBasis, getNextTradeInfo, readJSON, writeJSON, DATA_DIR, notifier, exchangeIPCMap, rescheduleBackupTimer };

require('./src/routes/ai-routes')(app, sharedDeps);
require('./src/routes/settings-routes')(app, sharedDeps);
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
    const status = await ipc.request('regime:status', {}, timeout).catch(() => null);
    engines[name] = {
      status: status?.health?.mode?.toLowerCase() || (status ? 'ok' : 'timeout'),
      connected: true,
      isRunning: status?.isRunning ?? false,
      mode: status?.health?.mode ?? null,
      uptime: status?.uptime ?? null,
    };
    if (engines[name].status === 'timeout') overallStatus = 'degraded';
  });

  // Kalshi engine via IPC
  const kalshiCheck = (async () => {
    if (!kalshiIPC.isConnected()) {
      engines.kalshi = { status: 'unreachable', connected: false };
      overallStatus = 'degraded';
      return;
    }
    const status = await kalshiIPC.request('kalshi:status', {}, timeout).catch(() => null);
    engines.kalshi = {
      status: status ? 'ok' : 'timeout',
      connected: true,
      kalshiEnabled: status?.kalshiEnabled ?? false,
      hedgeEnabled: status?.hedgeEnabled ?? false,
      engineRunning: status?.engineRunning ?? null,
      uptime: status?.uptime ?? null,
    };
    if (!status) overallStatus = 'degraded';
  })();

  await Promise.all([...exchangeChecks, kalshiCheck]);

  // If any engine is unreachable and all are down, it's critical
  const allDown = Object.values(engines).every(e => e.status === 'unreachable' || e.status === 'timeout');
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

// ============ PM2 Log Streaming ============

const activeLogStreams = new Map(); // socketId -> { process, processName }

const ALLOWED_LOG_PROCESSES = new Set([
  'critical-mass', 'critical-mass-coinbase', 'critical-mass-gemini',
  'critical-mass-cryptocom', 'critical-mass-kalshi',
]);

// ============ WebSocket ============

const { tradeEvents } = require('./src/trade-events');

tradeEvents.on('trade', (event) => {
  io.emit('trade:event', event);
});

io.on('connection', (socket) => {
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

  // Room subscriptions for Kalshi/Hedge events (forwarded from engine via IPC)
  socket.on('kalshi:join', () => { socket.join('kalshi'); socket.join('kalshi:coinbase'); });
  socket.on('kalshi:leave', () => { socket.leave('kalshi'); socket.leave('kalshi:coinbase'); });
  socket.on('coinbase:subscribe', () => socket.join('coinbase'));
  socket.on('coinbase:unsubscribe', () => socket.leave('coinbase'));
  socket.on('gemini:subscribe', () => socket.join('gemini'));
  socket.on('gemini:unsubscribe', () => socket.leave('gemini'));
  socket.on('cryptocom:subscribe', () => socket.join('cryptocom'));
  socket.on('cryptocom:unsubscribe', () => socket.leave('cryptocom'));
  socket.on('composite:subscribe', () => socket.join('composite'));
  socket.on('kraken:subscribe', () => socket.join('kraken'));
  socket.on('kraken:unsubscribe', () => socket.leave('kraken'));

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

  // Regime engine auto-resume is handled by engine processes (cm-coinbase, cm-kalshi)
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
  kalshiIPC.disconnect();
  coinbaseIPC.disconnect();
  geminiIPC.disconnect();
  cryptocomIPC.disconnect();

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
