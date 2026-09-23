// Gemini Engine — thin wrapper around the shared crypto engine
const { resolveIpcPort } = require('../src/ipc-port-defaults');

process.env.EXCHANGE_NAME = 'gemini';
// Default port comes from ecosystem.config.cjs's PORTS.GEMINI_IPC, never a
// literal — a stale literal here is what let this fall back to the Vite dev
// server's port outside PM2 (issue #690).
process.env.EXCHANGE_IPC_PORT = String(resolveIpcPort('gemini'));
require('./coinbase-engine');
