// Crypto.com Engine — thin wrapper around the shared crypto engine
process.env.EXCHANGE_NAME = 'cryptocom';
process.env.EXCHANGE_IPC_PORT = process.env.CRYPTOCOM_IPC_PORT || '5574';
require('./coinbase-engine');
