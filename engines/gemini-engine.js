// Gemini Engine — thin wrapper around the shared crypto engine
process.env.EXCHANGE_NAME = 'gemini';
process.env.EXCHANGE_IPC_PORT = process.env.GEMINI_IPC_PORT || '5571';
require('./coinbase-engine');
