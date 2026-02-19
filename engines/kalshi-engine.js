// @ts-check
/**
 * Kalshi + Hedge Engine Process
 *
 * Standalone PM2 process that runs:
 * - Kalshi simulation/live trading engine
 * - Hedge engine (BTC spot + Kalshi insurance)
 * - Own Express server (:5572) for Kalshi & Hedge REST routes
 * - IPC WebSocket server (:5573) for Socket.IO event forwarding to gateway
 * - Own Coinbase public WebSocket for BTC price bridge (no dependency on gateway's market data)
 * - Own Kraken public WebSocket for composite price aggregation
 *
 * The gateway (server.js) reverse-proxies /api/kalshi/* and /api/hedge/* to :5572
 * and connects as an IPC client to :5573 for Socket.IO events.
 */

const express = require('express');
const http = require('http');
const { log } = require('../src/logger');
const { getKalshiConfig, getHedgeConfig } = require('../src/config-utils');
const { createIPCServer } = require('../src/ipc/ipc-server');
const { createSocketIOProxy } = require('../src/ipc/socket-io-proxy');

// ============ Configuration ============

const HTTP_PORT = parseInt(process.env.KALSHI_HTTP_PORT) || 5572;
const IPC_PORT = parseInt(process.env.KALSHI_IPC_PORT) || 5573;
const ENGINE_NAME = 'cm-kalshi';

// ============ Express Server ============

const app = express();
const server = http.createServer(app);

app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', engine: ENGINE_NAME, uptime: process.uptime() });
});

// ============ IPC Server ============

const ipcServer = createIPCServer(IPC_PORT, ENGINE_NAME);
const ioProxy = createSocketIOProxy(ipcServer);

// ============ Mount Kalshi Routes ============

// The sharedDeps object mimics what server.js passes, but with ioProxy instead of real io
const sharedDeps = { io: ioProxy };

let kalshiLifecycle = null;
const kalshiConfig = getKalshiConfig();
if (kalshiConfig.enabled) {
  kalshiLifecycle = require('../src/routes/kalshi-routes')(app, sharedDeps);
  log('INFO', `📊 Kalshi routes mounted on :${HTTP_PORT}/api/kalshi/`);
} else {
  app.all('/api/kalshi/*', (req, res) => {
    res.status(503).json({ error: 'Kalshi is not enabled in config.' });
  });
  log('INFO', `📊 Kalshi disabled`);
}

// ============ Mount Hedge Routes ============

let hedgeLifecycle = null;
const hedgeConfig = getHedgeConfig();
if (hedgeConfig.enabled) {
  hedgeLifecycle = require('../src/routes/hedge-routes')(app, sharedDeps);
  log('INFO', `🛡️ Hedge routes mounted on :${HTTP_PORT}/api/hedge/`);
} else {
  app.all('/api/hedge/*', (req, res) => {
    res.status(503).json({ error: 'Hedge engine is not enabled in config.' });
  });
  log('INFO', `🛡️ Hedge disabled`);
}

// ============ IPC Request Handlers ============

// Handle config updates from gateway
ipcServer.onRequest('config_update', async (payload) => {
  log('INFO', `🔗 Received config update`);
  // Kalshi and Hedge engines reload config from disk, so just acknowledge
  return { success: true };
});

// Handle status queries from gateway
ipcServer.onRequest('kalshi:status', async () => {
  // Return basic status for gateway health aggregation
  return {
    engine: ENGINE_NAME,
    kalshiEnabled: kalshiConfig.enabled,
    hedgeEnabled: hedgeConfig.enabled,
    uptime: process.uptime(),
  };
});

// ============ Start ============

server.listen(HTTP_PORT, async () => {
  const { version } = require('../package.json');
  log('INFO', `\n🎯 Kalshi+Hedge Engine v${version}`);
  log('INFO', `   HTTP: http://127.0.0.1:${HTTP_PORT}`);
  log('INFO', `   IPC:  ws://127.0.0.1:${IPC_PORT}`);

  // Start IPC server
  ipcServer.start();

  // Auto-start Kalshi engine if it was running before restart
  if (kalshiLifecycle) {
    kalshiLifecycle.autoStartEngine().catch((err) => {
      log('WARN', `⚠️ Kalshi auto-start failed: ${err.message}`);
    });
  }

  // Auto-start hedge engine if it was running before restart
  if (hedgeLifecycle) {
    hedgeLifecycle.autoStartEngine().catch((err) => {
      log('WARN', `⚠️ Hedge auto-start failed: ${err.message}`);
    });
  }
});

// ============ Graceful Shutdown ============

const gracefulShutdown = async (signal) => {
  log('INFO', `Received ${signal}, shutting down...`);

  if (kalshiLifecycle) {
    kalshiLifecycle.shutdown();
  }

  if (hedgeLifecycle) {
    hedgeLifecycle.shutdown();
  }

  ipcServer.stop();

  server.close(() => {
    log('INFO', `Server closed`);
    process.exit(0);
  });

  setTimeout(() => {
    log('WARN', `Forcing exit after timeout`);
    process.exit(1);
  }, 5000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
