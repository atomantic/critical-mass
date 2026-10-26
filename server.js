require('./src/runtime-env').loadRuntimeEnv();

const express = require('express');
const { IPC_CHANNELS } = require('./src/ipc/ipc-protocol');
const { spawn } = require('child_process');

const path = require('path');
const fs = require('fs');
const http = require('http');
const { log, createContextLogger } = require('./src/logger');
const { guardLegacyMigration } = require('./src/migration');
const { guardIncompleteRestore } = require('./src/restore-apply');
const { asyncRoute } = require('./src/routes/route-utils');
const { errorMiddleware } = require('./src/error-middleware');
const {
  initializeConfigBase,
  getFundConfig,
  getEnabledExchanges,
  getEnabledFunds,
  getConfiguredFunds,
  getConfiguredExchanges,
  getGlobalConfig,
  getBackupConfig,
  getDefaultPair,
} = require('./src/config-utils');
const {
  normalizeConfig,
  getNextExecutionTime,
  getRunIdentifier,
  hasRunThisInterval,
  formatInterval,
  getTimeUntilNext,
  planScheduledRetry,
} = require('./src/interval-utils');
const { runIntervalCycle } = require('./src/dca-engine');
const { createNotifier } = require('./src/notifier');
const { createBackup, pruneBackups, createFundStateBackup, getNewestBackupTimeAsync, getNewestFundStateBackupTime } = require('./src/backup-service');
const { createBackupScheduler } = require('./src/backup-scheduler');
const { DATA_DIR } = require('./src/paths');
const {
  readJSON,
  writeJSON,
  parseTSV,
  calculateCostBasis,
  getNextTradeInfo,
  fundKey,
  fundLabel,
} = require('./src/shared-utils');
const { createIPCClient } = require('./src/ipc/ipc-client');
const { forwardIPCEvent } = require('./src/ipc/realtime-proxy');
const { createRealtimeBus } = require('./src/realtime-bus');
const { performBackup } = require('./src/backup-coordinator');
const { drainPendingWrites, trackPendingWrite } = require('./src/pending-writes');
const { maintenanceGuard, isMaintenanceActive } = require('./src/restore-maintenance');
const { createUpDownService } = require('./src/updown/updown-service');
const { createCandleCache } = require('./src/candle-cache');
const { createSentinelService } = require('./src/sentinel/sentinel-service');
const { getSentinelConfig, updateSentinelConfig } = require('./src/config-utils');
const { createRuntimeHealthMonitor } = require('./src/runtime-health');
const { createOperatorAuth } = require('./src/operator-auth');
const { resolveListenHosts, createCorsMiddleware, createSecurityHeadersMiddleware, bindGatewayListeners, watchTailscaleListeners } = require('./src/gateway-listen');
const { registerProcessGuards } = require('./src/process-guard');
const { resolveIpcPort } = require('./src/ipc-port-defaults');
const { PORTS } = require('./ecosystem.config.cjs');
const { createGatewayShutdown, closeGatewayListeners } = require('./src/gateway-shutdown');

// A backup restore that a crash interrupted leaves data/ as a mix of
// archive-era and current-era files. Finish its rollback BEFORE anything reads
// persisted state (migration included) — and refuse to start at all if the
// rollback cannot complete, rather than serving mismatched accounting data
// (issue #431).
guardIncompleteRestore({ processLabel: 'gateway', logger: createContextLogger({ module: 'server' }) });

initializeConfigBase();

// Finish the legacy namespace migration before anything reads persisted
// state; a conflicting or still-in-progress migration refuses to start (issue #971).
guardLegacyMigration({ processLabel: 'gateway', logger: createContextLogger({ module: 'server' }) });

// ============ Server Setup ============

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || PORTS.API;
// Loopback is not proof of a local browser: a same-host reverse proxy that adds
// no forwarding headers looks identical (#1328). By default enrollment therefore
// needs the generated data/operator-bootstrap-secret; set
// OPERATOR_TRUST_LOOPBACK_BOOTSTRAP=true only when no reverse proxy is in front.
const TRUST_LOOPBACK_BOOTSTRAP = process.env.OPERATOR_TRUST_LOOPBACK_BOOTSTRAP === 'true';
const operatorAuth = createOperatorAuth({
  authFile: path.join(DATA_DIR, 'operator-auth.json'),
  readJSON,
  writeJSON,
  bootstrapSecret: process.env.OPERATOR_BOOTSTRAP_SECRET,
  bootstrapSecretFile: process.env.OPERATOR_BOOTSTRAP_SECRET_FILE,
  ...(TRUST_LOOPBACK_BOOTSTRAP
    ? {}
    : {
      isTrustedBootstrapRequest: () => false,
      localBootstrapSecretFile: path.join(DATA_DIR, 'operator-bootstrap-secret'),
    }),
  // Every attached listener shares the bus and its disconnect cleanup.
  onPasswordChanged: () => io.disconnectSockets(),
  onSessionsRevoked: () => io.disconnectSockets(),
  onPasswordRemoved: () => {
    setTimeout(() => gracefulShutdown('operator password removal'), 100).unref();
  },
});
const ALLOW_REMOTE_LISTEN = operatorAuth.hasPassword() || operatorAuth.hasRemoteBootstrap();
const LISTEN_HOSTS = resolveListenHosts(process.env.HOST, undefined, { allowRemote: ALLOW_REMOTE_LISTEN });

// CORS allowlist -- local dev, plus Tailscale 100.x / *.ts.net (see isGatewayOrigin)
const CORS_ORIGINS = (process.env.CORS_ORIGINS || `http://localhost:${PORT},http://localhost:5571`).split(',').map(s => s.trim());

// Rooms a client may subscribe to: engine events forwarded over IPC with a
// room, and the UpDown and Sentinel feeds.
const REALTIME_ROOMS = ['coinbase', 'gemini', 'cryptocom', 'updown', 'sentinel'];

// Admin realtime bus (src/realtime-bus.js). Upgrades are refused while the
// gateway drains and need an operator session or bearer password from this
// gateway's own origin; inbound client events are dropped while stopping.
const io = createRealtimeBus({
  httpServer: server,
  authorize: operatorAuth.authorizeUpgrade,
  isStopping: () => gatewayShutdown.isStopping(),
  rooms: REALTIME_ROOMS,
  log,
});

// Notification system
const notifier = createNotifier();

// Callbacks resolve their owners only when shutdown is requested, after startup.
let schedulerTimer = null;
let tailscaleWatcher = null;
const gatewayShutdown = createGatewayShutdown({
  cancelSchedules: () => {
    for (const timer of [schedulerTimer, exchangeRefreshTimer]) clearInterval(timer);
    schedulerTimer = null;
    backupScheduler.stop();
    tailscaleWatcher?.stop();
    candleCache.stop();
  },
  // Each producer is stopped on its own, so one failing to persist its state
  // (e.g. a full disk) still lets the others persist and stop; any failure is
  // rethrown so the shutdown reports it.
  stopProducers: () => {
    // A restore owns UpDown and Sentinel from its stop through its reload, and
    // keeps them stopped after an incomplete rollback. stop() always persists,
    // so stopping them inside that window would write pre-restore memory over
    // the restored files.
    const restoreOwnsWriters = isMaintenanceActive();
    const failures = [];
    for (const [name, stop] of [
      ...(restoreOwnsWriters ? [] : [['UpDown', () => updownService.stop()], ['Sentinel', () => sentinelService.stop()]]),
      ['log streams', () => activeLogStreams.stopAll()],
    ]) {
      try {
        stop();
      } catch (err) {
        failures.push(`${name}: ${err.message}`);
      }
    }
    if (failures.length) throw new Error(failures.join('; '));
  },
  stopNotifier: () => notifier.stop(),
  disconnectIPC: () => {
    for (const ipc of Object.values(exchangeIPCMap)) ipc.disconnect();
  },
  closeListeners: () => closeGatewayListeners(io, [server, ...extraServers]),
  log,
});
const shutdownRoutes = gatewayShutdown.routes(app);
// Accepted async mutations outlive HTTP sockets; drain their handler promises.
const routes = Object.fromEntries(Object.entries(shutdownRoutes).map(([method, register]) => [method,
  (...args) => register(...args.flat(Infinity).map((arg) => typeof arg !== 'function' ? arg : (req, res, next) => {
    const result = arg(req, res, next);
    // Maintenance owners drain this set themselves. Tracking their own handler
    // would make a manual backup or restore wait for itself until timeout.
    const ownsMaintenance = req.method === 'POST' && (/^\/api\/backups\/?$/i.test(req.path) || /\/backups\/.+\/restore\/?$/.test(req.path));
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || ownsMaintenance) return result;
    return result && typeof result.then === 'function' ? trackPendingWrite(`api:${req.method}:${req.path}`, () => result) : result;
  })),
]));

// ============ Middleware ============

// Security headers go first so responses short-circuited by later middleware (e.g. shutdown 503) carry them too.
app.disable('x-powered-by');
app.use(createSecurityHeadersMiddleware());

app.use(gatewayShutdown.middleware);

app.use(createCorsMiddleware(CORS_ORIGINS));

app.use(express.json());

operatorAuth.registerSessionRoutes(routes);
app.use('/api', gatewayShutdown.handler(operatorAuth.requireAuth));
// Hold every mutating API request while a backup restore is applying files, so
// nothing can land between "writers confirmed stopped" and "archive applied"
// and silently overwrite the recovered snapshot (issue #429).
app.use('/api', maintenanceGuard);
log('INFO', operatorAuth.hasPassword()
  ? '🔐 Operator sign-in is required (password in data/operator-auth.json)'
  : operatorAuth.hasRemoteBootstrap()
    ? '🔐 Operator bootstrap mode — remote enrollment requires the configured bootstrap credential'
    : '🔐 Operator bootstrap mode — gateway is loopback-only until a password is set');

// Exchange param validation middleware
const KNOWN_EXCHANGES = new Set(getConfiguredExchanges());
let exchangeRefreshTimer = null;

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

const runBackup = (kind, create) => performBackup({
  kind, create, exchangeIPCMap,
  configuredExchanges: getConfiguredExchanges().filter((name) => exchangeIPCMap[name]),
  drainPendingWrites,
  gatewayWriters: [updownService, sentinelService].map((service, index) => {
    const wasRunning = service.getStatus().running;
    return {
      name: index === 0 ? 'UpDown' : 'Sentinel',
      stop: () => service.stop(),
      resume: () => wasRunning ? service.start() : undefined,
    };
  }),
  logger: createContextLogger({ module: 'backup-coordinator' }),
});

const backupScheduler = createBackupScheduler({
  getConfig: getBackupConfig,
  isStopping: () => gatewayShutdown.isStopping(),
  track: (promise) => gatewayShutdown.track(promise),
  log,
  alert: (message, data) => tradeEvents.error('system', message, data),
  kinds: {
    archive: {
      label: 'full archive',
      failLabel: 'Scheduled backup',
      intervalKey: 'intervalMs',
      newest: getNewestBackupTimeAsync,
      run: async (config) => {
        log('INFO', '💾 Running scheduled backup...');
        const result = await runBackup('full archive', () => createBackup({ includePriceCache: config.includePriceCache }));
        if (result.success) {
          const sizeMB = (result.sizeBytes / 1024 / 1024).toFixed(1);
          log('INFO', `💾 Scheduled backup created: ${result.filename} (${sizeMB} MB)`);
          const pruneResult = await pruneBackups(config.maxBackups);
          if (pruneResult.pruned > 0) {
            log('INFO', `💾 Pruned ${pruneResult.pruned} old backups, ${pruneResult.remaining} remaining`);
          }
        }
        return result;
      },
    },
    fundState: {
      label: 'fund state',
      failLabel: 'Fund-state snapshot',
      intervalKey: 'fundStateIntervalMs',
      // Keeps the first snapshot off the archive's instant when both are due at boot.
      startupOffsetMs: 2 * 60_000,
      newest: getNewestFundStateBackupTime,
      run: async (config) => {
        const result = await runBackup('fund state', () => createFundStateBackup({ maxBackups: config.fundStateMaxBackups }));
        if (result.success && result.snapshotId) {
          log('INFO', `💾 Fund-state snapshot created: ${result.snapshotId} (${result.files} files, ${result.funds.length} funds)`);
          if (result.pruned > 0) {
            log('INFO', `💾 Pruned ${result.pruned} old fund-state snapshots, ${result.remaining} remaining`);
          }
        }
        return result;
      },
    },
  },
});
const rescheduleBackupTimer = () => backupScheduler.reschedule();

// ============ Crypto Exchange Engine IPC ============

const COINBASE_IPC_PORT = resolveIpcPort('coinbase');
const GEMINI_IPC_PORT = resolveIpcPort('gemini');
const CRYPTOCOM_IPC_PORT = resolveIpcPort('cryptocom');

/** @type {Array<(name: string, msg: Object) => void>} */
const ipcEventListeners = [];

const createExchangeIPC = (port, name) => {
  const client = createIPCClient(`ws://127.0.0.1:${port}`, name, {
    onEvent: (msg) => {
      forwardIPCEvent(io, msg);
      // Isolate each listener so one throwing does not starve the rest; the
      // first failure is rethrown for the IPC client's rate-limited logging.
      let failure = null;
      for (const listener of ipcEventListeners) {
        try {
          listener(name, msg);
        } catch (err) {
          failure = failure || err;
        }
      }
      if (failure) throw failure;
    },
    onConnect: () => log('INFO', `🔗 Gateway connected to ${name} engine IPC`),
    onDisconnect: () => log('INFO', `🔗 Gateway disconnected from ${name} engine IPC`),
  });
  return client;
};

const coinbaseIPC = createExchangeIPC(COINBASE_IPC_PORT, 'coinbase');
const geminiIPC = createExchangeIPC(GEMINI_IPC_PORT, 'gemini');
const cryptocomIPC = createExchangeIPC(CRYPTOCOM_IPC_PORT, 'cryptocom');

const exchangeIPCMap = { coinbase: coinbaseIPC, gemini: geminiIPC, cryptocom: cryptocomIPC };

// ============ Shared Candle Cache ============

const candleCache = createCandleCache();

// Feed exchange IPC ticks into the shared candle cache. The cache is keyed by
// exchange ONLY, so when an exchange runs more than one fund (e.g. coinbase
// BTC-USDC + ETH-USDC) we must accept ticks from a single canonical pair —
// otherwise ETH and BTC ticks interleave into one OHLC series (garbage candles,
// fake volatility) and drive the BTC UpDown predictor. Use the exchange's
// default pair as that canonical series (issue #110 M3).
ipcEventListeners.push((name, msg) => {
  if (msg.channel === IPC_CHANNELS.REGIME_STATUS) {
    const pair = msg.payload?.pair;
    if (pair && pair !== getDefaultPair(name)) return;
    const market = msg.payload?.status?.market || msg.payload?.market;
    if (market?.lastPrice) {
      const price = parseFloat(market.lastPrice);
      if (!Number.isFinite(price) || price <= 0) return;
      candleCache.processTick(name, price, Date.now(), parseFloat(market.volume24h) || 0);
    }
  }
});

// ============ UpDown Service ============

const updownService = createUpDownService(io, { exchangeIPCMap, readJSON, writeJSON, DATA_DIR, candleCache });

// Forward coinbase BTC price data to updown service for realtime emission + P&L.
// Only the default (BTC) pair — a second coinbase fund must not drive the BTC
// UpDown predictor with its own asset's price (issue #110 M3).
ipcEventListeners.push((name, msg) => {
  if (name === 'coinbase' && msg.channel === IPC_CHANNELS.REGIME_STATUS) {
    const pair = msg.payload?.pair;
    if (pair && pair !== getDefaultPair('coinbase')) return;
    const market = msg.payload?.status?.market || msg.payload?.market;
    if (market?.lastPrice) {
      const price = parseFloat(market.lastPrice);
      if (!Number.isFinite(price) || price <= 0) return;
      updownService.handlePriceTick(price, Date.now());
    }
  }
});

// ============ Sentinel Service ============

const sentinelService = createSentinelService(io, { readJSON, writeJSON, DATA_DIR, getSentinelConfig });

// ============ Route Modules ============

const sharedDeps = { io, parseTSV, calculateCostBasis, getNextTradeInfo, readJSON, writeJSON, DATA_DIR, notifier, exchangeIPCMap, rescheduleBackupTimer };

require('./src/routes/sentinel-routes')(routes, { ...sharedDeps, sentinelService, getSentinelConfig, updateSentinelConfig });
require('./src/routes/ai-routes')(routes, sharedDeps);
require('./src/routes/settings-routes')(routes, { ...sharedDeps, updownService, sentinelService, candleCache, runBackup, getBackupSchedulerStatus: () => backupScheduler.getStatus() });
require('./src/routes/candle-routes')(routes, { candleCache });
require('./src/routes/updown-routes')(routes, { ...sharedDeps, updownService, candleCache });
require('./src/routes/exchange-routes')(routes, sharedDeps);
require('./src/routes/regime-routes')(routes, sharedDeps);
require('./src/routes/keys-routes')(routes, sharedDeps);
require('./src/routes/backtest-routes')(routes, sharedDeps);
require('./src/routes/legacy-routes')(routes, sharedDeps);

// ============ Health Aggregation ============

const runtimeHealthMonitor = createRuntimeHealthMonitor({
  exchangeIPCMap,
  getConfiguredFunds,
  getEnabledFunds,
  getUpDownStatus: () => updownService.getStatus(),
  getSentinelStatus: () => sentinelService.getStatus(),
});

routes.get('/api/health', asyncRoute(async (req, res) => {
  const { status, engines, funds } = await runtimeHealthMonitor.getHealth();

  res.json({
    status,
    gateway: { uptime: process.uptime(), pid: process.pid },
    engines,
    funds,
    timestamp: new Date().toISOString(),
  });
}));

// ============ Static Files ============

// Catch-all for unhandled API routes — return JSON 404 instead of falling through to HTML
app.all('/api/*splat', (req, res) => {
  res.status(404).json({ success: false, error: 'Not found' });
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

// ============ Error Handling ============

// Centralized JSON error boundary (issue #530) — see src/error-middleware.js
// for the implementation (kept in its own module so it can be unit-tested
// directly). Registered here, after every route registration, the static
// file server, and the SPA catch-all, as a 4-arity function so Express
// recognizes it as error-handling middleware and it becomes the app's
// last-resort handler for every rejection.
app.use((err, req, res, next) => errorMiddleware(err, req, res, next));

// ============ PM2 Log Streaming ============

const { createLogStreamRegistry, registerLogStreamHandlers, disconnectLogStream } = require('./src/log-stream-manager');

const activeLogStreams = createLogStreamRegistry(); // socketId -> { process, processName }

const ALLOWED_LOG_PROCESSES = new Set([
  'critical-mass', 'critical-mass-coinbase', 'critical-mass-gemini',
  'critical-mass-cryptocom',
]);

// ============ WebSocket ============

const { tradeEvents } = require('./src/trade-events');

tradeEvents.on('trade', (event) => {
  io.emit('trade:event', event);
});

// Room subscriptions (REALTIME_ROOMS) are handled by the bus itself.
io.on('connection', (socket) => {
  log('INFO', `WebSocket client connected: ${socket.id}`);
  socket.on('disconnect', () => {
    disconnectLogStream({ socket, registry: activeLogStreams, log });
    log('INFO', `WebSocket client disconnected: ${socket.id}`);
  });

  // PM2 log streaming
  registerLogStreamHandlers({
    socket,
    registry: activeLogStreams,
    spawnFn: spawn,
    log,
    allowedProcesses: ALLOWED_LOG_PROCESSES,
  });
});

// ============ Scheduler ============

const schedulerState = {};

const checkAndRunIntervalTrade = () => {
  if (gatewayShutdown.isStopping()) return;
  if (!getGlobalConfig().simpleDcaEnabled) return;
  // A scheduled DCA buy writes the same files a restore is replacing.
  if (isMaintenanceActive()) {
    log('INFO', '⏸️  Scheduled trade check skipped: gateway is in restore maintenance');
    return;
  }

  // Scheduled per FUND, not per exchange: each enabled fund has its own
  // interval config, its own state file and its own budget, so a second fund
  // on an exchange must get its own cycle instead of the default fund being
  // charged for it (#546).
  for (const { exchange, pair } of getEnabledFunds()) {
    const config = normalizeConfig(getFundConfig(exchange, pair));
    const { intervalType } = config;
    const key = fundKey(exchange, pair);
    const label = fundLabel(exchange, pair);

    if (!schedulerState[key]) {
      schedulerState[key] = { lastRunId: null, nextExecutionTime: 0 };
    }

    if (hasRunThisInterval(schedulerState[key].lastRunId, intervalType)) {
      continue;
    }

    const now = Date.now();
    const nextExec = schedulerState[key].nextExecutionTime;

    if (now >= nextExec) {
      const intervalLabel = formatInterval(intervalType);
      log('INFO', `[${label}] Scheduled ${intervalLabel} trade starting at ${new Date().toISOString()}`);
      const runId = getRunIdentifier(intervalType);
      const intervalEnd = getNextExecutionTime(intervalType);
      schedulerState[key].lastRunId = runId;
      schedulerState[key].nextExecutionTime = intervalEnd;

      gatewayShutdown.track(runIntervalCycle(exchange, pair))
        .then(result => {
          schedulerState[key].lastAlertAt = null;
          log('INFO', `[${label}] Scheduled trade complete: ${result.status}`);
        })
        .catch(err => {
          // A transient exchange error (price, balance or order-status read)
          // would otherwise skip this fund's buy for the whole interval with
          // nothing but a console line. Re-running is safe: runIntervalCycle
          // re-checks the persisted interval, pending buy and placement
          // intents — the manual trade route relies on the same guarantee.
          const entry = schedulerState[key];
          const now = Date.now();
          const { failures, retryAt, alert } = planScheduledRetry(entry, { runId, now, intervalEnd });
          entry.retryRunId = runId;
          entry.retryCount = failures;
          let next = `no further automatic retry this ${intervalLabel} interval — trigger the trade manually once the cause is fixed`;
          if (retryAt !== null && entry.lastRunId === runId) {
            entry.lastRunId = null;
            entry.nextExecutionTime = retryAt;
            next = `retrying at ${new Date(retryAt).toISOString()}`;
          }
          log('ERROR', `[${label}] Scheduled trade failed: ${err.message}; ${next}`);
          if (alert) {
            entry.lastAlertAt = now;
            tradeEvents.error(exchange, `[${label}] Scheduled ${intervalLabel} trade failed: ${err.message}; ${next}`, { pair, failures });
          }
        });
    }
  }
};

// ============ Start Server ============
//
// Own every HTTP listener BEFORE any writer, scheduler or exchange connection
// starts — the gateway-side counterpart of the engines' bind-first rule
// (#816). A second gateway on the same port (`node server.js` or `npm run dev`
// beside the PM2 process) must fail here without connecting to the engines,
// rewriting UpDown/Sentinel state, placing a scheduled DCA buy or sending
// Telegram. Routes and services are constructed above so a request admitted
// right after the bind finds them; nothing below has side effects until the
// bind resolves.

const extraServers = [];
const attachExtraServer = (s) => {
  io.attach(s);
  extraServers.push(s);
};
const detachExtraServer = (s) => {
  io.detach(s);
  const i = extraServers.indexOf(s);
  if (i !== -1) extraServers.splice(i, 1);
};

// Default (HOST unset) mode only: a Tailscale address that comes up after the
// gateway (tailscaled starts slower than PM2 after a reboot) is bound without
// a restart. Explicit HOST values and loopback-only bootstrap never gain listeners.
const watchLateTailscale = () => {
  if (process.env.HOST?.trim() || !ALLOW_REMOTE_LISTEN) return;
  tailscaleWatcher = watchTailscaleListeners({
    bound: LISTEN_HOSTS,
    port: PORT,
    createServer: () => http.createServer(app),
    onExtra: attachExtraServer,
    onExtraFailed: detachExtraServer,
    isStopping: gatewayShutdown.isStopping,
    log,
  });
};

const startGatewayServices = () => {
  if (gatewayShutdown.isStopping()) return;

  const enabledExchanges = getEnabledExchanges();

  const { version } = require('./package.json');
  log('INFO', `\n⚛  Critical Mass v${version}\n·  ·  · ◉ ·  ·  ·\nBTC Accumulation Engine\n`);
  log('INFO', `Critical Mass running on ${LISTEN_HOSTS.map((h) => `http://${h}:${PORT}`).join(' ')}`);
  watchLateTailscale();
  log('INFO', `Configured exchanges: ${getConfiguredExchanges().join(', ')}`);
  log('INFO', `Enabled exchanges: ${enabledExchanges.length > 0 ? enabledExchanges.join(', ') : 'none'}`);

  for (const { exchange, pair } of getEnabledFunds()) {
    const config = normalizeConfig(getFundConfig(exchange, pair));
    const intervalLabel = formatInterval(config.intervalType);
    const timeUntilNext = getTimeUntilNext(config.intervalType);
    log('INFO', `[${fundLabel(exchange, pair)}] Interval: ${intervalLabel}, next trade in ${timeUntilNext.formatted}`);
  }

  // Notifier first, so every event the starts below emit is delivered.
  notifier.start();

  // Regime engine auto-resume and market data services are owned by the
  // engine processes; the gateway only attaches to them.
  for (const ipc of Object.values(exchangeIPCMap)) ipc.connect();

  // Seed candle cache from public APIs (non-blocking)
  candleCache.seedAll();

  gatewayShutdown.track(updownService.start()).catch((err) => log('ERROR', `UpDown startup failed: ${err.message}`));
  sentinelService.start();

  exchangeRefreshTimer = setInterval(() => { for (const e of getConfiguredExchanges()) KNOWN_EXCHANGES.add(e); }, 60_000);

  // Start backup scheduler
  rescheduleBackupTimer();

  // Check for scheduled trades every 30 seconds
  const globalConfig = getGlobalConfig();
  schedulerTimer = setInterval(checkAndRunIntervalTrade, globalConfig.schedulerInterval || 30000);

  // Check immediately on startup
  checkAndRunIntervalTrade();
};

bindGatewayListeners({
  hosts: LISTEN_HOSTS,
  port: PORT,
  server,
  createServer: () => http.createServer(app),
  onExtra: attachExtraServer,
  log,
}).then(startGatewayServices, (err) => {
  // A shutdown that began mid-bind closes these servers itself; its own exit
  // path owns the outcome.
  if (gatewayShutdown.isStopping()) return;
  log('ERROR', `Gateway failed to bind http://${err.host}:${err.port} (${err.code || err.message}) — is another gateway running? No writer, scheduler or engine connection was started`);
  process.exit(1);
});

// ============ Graceful Shutdown ============

const gracefulShutdown = gatewayShutdown.shutdown;

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Last-resort fault reporters (issue #532): log + push a critical Telegram
// message before the process dies, so a gateway crash isn't silent. The
// notifier lives here, so its queue is flushed rather than lost on exit.
registerProcessGuards({
  logger: createContextLogger({ module: 'gateway' }),
  source: 'gateway',
  flush: () => notifier.flush(),
});
