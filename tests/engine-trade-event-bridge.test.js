const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const configUtils = require('../src/config-utils');
const { TradeEventEmitter, tradeEvents } = require('../src/trade-events');
const { createFaultReporter } = require('../src/process-guard');
const { createIPCServer } = require('../src/ipc/ipc-server');
const { createIPCClient } = require('../src/ipc/ipc-client');
const { forwardTradeEvents, forwardIPCEvent } = require('../src/ipc/socket-io-proxy');
const { createNotifier } = require('../src/notifier');

it('delivers engine faults over IPC to Telegram and Socket.IO exactly once', { timeout: 5000 }, async (t) => {
  const configFile = path.join(__dirname, '..', 'config.json');
  const userConfigFile = path.join(__dirname, '..', 'data', 'config.json');
  const originalRead = fs.readFileSync;
  const originalExists = fs.existsSync;
  const originalStat = fs.statSync;
  const config = { exchanges: {}, global: { notifications: {
    enabled: true,
    telegram: { botToken: 'FAKE:TEST-TOKEN', chatId: 'test-chat' },
    events: {},
    rateLimitMs: 60000,
    dailySummaryHour: 20,
    quietHours: { enabled: false, start: 23, end: 7 },
  } } };
  t.mock.method(fs, 'readFileSync', (file, ...args) => file === configFile
    ? JSON.stringify(config) : originalRead(file, ...args));
  t.mock.method(fs, 'existsSync', (file) => file === configFile
    ? true : file === userConfigFile ? false : originalExists(file));
  t.mock.method(fs, 'statSync', (file, ...args) => {
    if (file === configFile) return { mtimeMs: 1 };
    if (file === userConfigFile) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return originalStat(file, ...args);
  });
  configUtils._resetConfigCacheForTests();
  t.after(() => configUtils._resetConfigCacheForTests());

  const telegram = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    telegram.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ ok: true }) };
  });
  const notifier = createNotifier();
  notifier.start();
  t.after(() => notifier.stop());

  // Ask the OS for a test-only port; no configured engine port is contacted.
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const server = createIPCServer(port, 'test-engine');
  server.start();
  t.after(() => server.stop());

  const engineEvents = new TradeEventEmitter();
  t.after(forwardTradeEvents(server, engineEvents));
  const socketEvents = [];
  const io = {
    emit: (channel, payload) => socketEvents.push({ channel, payload }),
    to: () => { throw new Error('Trade events must use the gateway trade bus'); },
  };
  let delivered;
  const delivery = new Promise((resolve) => { delivered = resolve; });
  const onTrade = (event) => { io.emit('trade:event', event); delivered(event); };
  tradeEvents.on('trade', onTrade);
  t.after(() => tradeEvents.removeListener('trade', onTrade));

  let connected;
  const connection = new Promise((resolve) => { connected = resolve; });
  const client = createIPCClient(`ws://127.0.0.1:${port}`, 'test-gateway', {
    onConnect: () => connected(),
    onEvent: (msg) => forwardIPCEvent(io, msg),
  });
  t.after(() => client.disconnect());
  client.connect();
  await connection;

  const exits = [];
  const reporter = createFaultReporter({
    logger: { error: () => {} },
    source: 'coinbase-engine',
    emitter: engineEvents,
    flush: () => server.flush(),
    exit: (code) => exits.push(code),
  });
  reporter.onUncaughtException(new Error('ENOSPC: engine state cannot be saved'));
  const event = await delivery;
  await notifier.flush();

  assert.equal(event.type, 'sentinel_critical');
  assert.equal(event.exchange, 'coinbase-engine');
  assert.deepEqual(exits, [1], 'the engine still exits after its IPC frame drains');
  assert.equal(socketEvents.length, 1, 'the IPC path must not emit a second UI copy');
  assert.equal(telegram.length, 1, 'the gateway notifier must receive the engine event');
  assert.match(telegram[0].body.text, /ENOSPC: engine state cannot be saved/);
  assert.equal(telegram[0].body.chat_id, 'test-chat');
});

it('keeps non-trade IPC events on their existing global or room destinations', () => {
  const seen = [];
  const io = {
    emit: (channel, payload) => seen.push({ room: null, channel, payload }),
    to: (room) => ({ emit: (channel, payload) => seen.push({ room, channel, payload }) }),
  };
  const emitter = { emit: () => assert.fail('non-trade event reached the trade bus') };
  forwardIPCEvent(io, { channel: 'regime:status', payload: { pair: 'ETH-USDC' } }, emitter);
  forwardIPCEvent(io, { channel: 'coinbase:book', room: 'coinbase', payload: { bids: [] } }, emitter);
  assert.deepEqual(seen, [
    { room: null, channel: 'regime:status', payload: { pair: 'ETH-USDC' } },
    { room: 'coinbase', channel: 'coinbase:book', payload: { bids: [] } },
  ]);
});
