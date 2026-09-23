// Crypto.com Engine — thin wrapper around the shared crypto engine
const { resolveIpcPort } = require('../src/ipc-port-defaults');

process.env.EXCHANGE_NAME = 'cryptocom';
// Default port comes from ecosystem.config.cjs's PORTS.CRYPTOCOM_IPC, never a
// literal (issue #690).
process.env.EXCHANGE_IPC_PORT = String(resolveIpcPort('cryptocom'));
require('./coinbase-engine');
