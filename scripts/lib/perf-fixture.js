'use strict';
// Isolated synthetic gateway for the route-load audit (issue #935).
// Serves the real paged-Transactions read view (src/transactions-regime-query)
// over a generated 30,000-fill ledger and a socket.io feed, from a disposable
// temp directory. It touches no production service, port or data directory.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');
const { createTransactionsReadView } = require('../../src/transactions-regime-query');

const EXCHANGES = ['coinbase', 'gemini', 'cryptocom'];

function syntheticFills(count, startMs = Date.UTC(2025, 0, 1)) {
  const fills = [];
  for (let i = 0; i < count; i++) {
    const cycle = Math.floor(i / 10) + 1;
    const sell = i % 10 === 9;
    fills.push({
      orderId: `synthetic-${i}`,
      side: sell ? 'sell' : 'buy',
      price: 50000 + (i % 500),
      size: 0.001,
      quoteAmount: 50 + (i % 500) / 10,
      fee: 0.1,
      timestamp: new Date(startMs + i * 60000).toISOString(),
      cycleId: `cycle-${cycle}`,
    });
  }
  return fills;
}

async function startFixture({ fills = 30000, statusIntervalMs = 1000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-perf-fixture-'));
  const ledger = syntheticFills(fills);
  fs.writeFileSync(path.join(dir, 'fill-ledger.json'), JSON.stringify(ledger));
  const view = createTransactionsReadView(() => ledger, () => 'synthetic-rev-1');
  const app = express();
  app.get('/api/auth/session', (req, res) => res.json({ success: true, authenticated: true }));
  app.get('/api/:exchange/config', (req, res) => res.json({ success: true, config: { productId: 'BTC-USD' } }));
  app.get('/api/:exchange/regime/fills', (req, res) => {
    const result = view.query(req.query);
    if (result.success === false) return res.status(result.statusCode || 400).json(result);
    res.json({ success: true, exchange: req.params.exchange, ...result });
  });
  app.get('/api/:exchange/regime/status', (req, res) => res.json({ success: true, status: { regime: 'range' } }));
  app.get('/api/:exchange/regime/open-orders', (req, res) => res.json({ success: true, orders: [] }));
  const server = http.createServer(app);
  const io = new Server(server);
  const sockets = new Set();
  io.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('disconnect', () => sockets.delete(socket));
    for (const ex of EXCHANGES) {
      socket.on(`${ex}:subscribe`, () => socket.join(ex));
      socket.on(`${ex}:unsubscribe`, () => socket.leave(ex));
    }
  });
  const timer = setInterval(() => {
    for (const ex of EXCHANGES) io.to(ex).emit('regime:status', { exchange: ex, pair: 'BTC-USD', status: { regime: 'range', lastPrice: 50000 } });
  }, statusIntervalMs);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    dir,
    ledgerSize: ledger.length,
    /** Rooms joined by a connected client, by socket id. */
    roomsOf: id => [...(io.sockets.sockets.get(id)?.rooms || [])].filter(r => r !== id).sort(),
    async stop() {
      clearInterval(timer);
      io.disconnectSockets(true);
      await io.close();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { startFixture, syntheticFills, EXCHANGES };
