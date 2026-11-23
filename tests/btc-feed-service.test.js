// @ts-check
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { FakeWebSocket, installFakeWebSocket } = require('./helpers/fake-websocket');

const restoreWebSocket = installFakeWebSocket();
after(restoreWebSocket);

const { createBtcFeedService } = require('../src/btc-feed/btc-feed-service');

const T0 = 1_800_000_000_000;

const setup = (t, over = {}) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: T0 });
  const trades = [];
  const indexes = [];
  const factory = (list) => (...args) => {
    const callbacks = args[args.length - 1];
    const instance = { args, callbacks, connects: 0, disconnects: 0, connect: () => { instance.connects++; }, disconnect: () => { instance.disconnects++; } };
    list.push(instance);
    return instance;
  };
  const emitted = [];
  const logs = { warn: [], error: [] };
  const historySamples = [];
  const historyDirs = [];
  const historyCalls = [];
  const io = { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) };
  const service = createBtcFeedService(over.io || io, {
    DATA_DIR: '/data-root',
    createTradeFeed: factory(trades),
    createIndexClient: factory(indexes),
    createIndexHistory: ({ dir }) => {
      historyDirs.push(dir);
      return { add: (s) => historySamples.push(s), pause: async () => { historyCalls.push('pause'); }, resume: () => { historyCalls.push('resume'); } };
    },
    logger: { info: () => {}, warn: (m) => logs.warn.push(m), error: (m) => logs.error.push(m) },
    ...over.deps,
  });
  t.after(() => service.stop());
  let id = 1;
  const trade = (feed, { side = 'buy', price = 100, size = 1, timestamp = Date.now(), tradeId = String(id++) } = {}) =>
    feed.callbacks.onTrade({ tradeId, price, size, side, timestamp });
  const index = (client, value = 100, timestamp = Date.now()) => client.callbacks.onValue({ value, timestamp });
  /** Start, connect both sources and move to the first accepted second. */
  const live = () => {
    service.start();
    trades[0].callbacks.onConnect();
    indexes[0].callbacks.onConnect();
    t.mock.timers.tick(1000);
    emitted.length = 0;
  };
  const tick = (ms) => t.mock.timers.tick(ms);
  return { service, trades, indexes, emitted, logs, historySamples, historyDirs, historyCalls, trade, index, live, tick };
};

describe('BTC feed sources', () => {
  it('opens Coinbase BTC-USD public-only with no credentials', (t) => {
    const { service, trades } = setup(t);
    service.start();
    const [exchange, config] = trades[0].args;
    assert.equal(exchange, 'coinbase');
    assert.equal(config.productId, 'BTC-USD');
    assert.equal(config.publicOnly, true);
    assert.equal('apiKey' in config || 'apiSecret' in config, false);
    assert.equal(trades[0].connects, 1);
  });

  it('counts volume by the taker side the feed reports', (t) => {
    const { service, trades, trade, live } = setup(t);
    live();
    trade(trades[0], { side: 'buy', size: 2 });
    trade(trades[0], { side: 'sell', size: 5 });
    const [bar] = service.getWindow(60).bars;
    assert.equal(bar.buyVolume, 2);
    assert.equal(bar.sellVolume, 5);
  });

  it('rejects a trade whose side is neither buy nor sell', (t) => {
    const { service, trades, trade, live } = setup(t);
    live();
    trade(trades[0], { side: 'unknown' });
    assert.deepEqual(service.getWindow(60).bars, []);
  });

  it('turns a raw Coinbase maker BUY frame into sell volume end to end', (t) => {
    FakeWebSocket.reset();
    const { service } = setup(t, { deps: { createTradeFeed: undefined } });
    service.start();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    t.mock.timers.tick(1000);
    socket.receive(JSON.stringify({
      channel: 'market_trades',
      events: [{ type: 'update', trades: [{ trade_id: '1', product_id: 'BTC-USD', price: '100', size: '3', side: 'BUY', time: new Date().toISOString() }] }],
    }));
    const [bar] = service.getWindow(60).bars;
    assert.equal(bar.sellVolume, 3, 'Coinbase sends the maker side: exactly one layer (websocket-feed) must invert it');
    assert.equal(bar.buyVolume, 0);
  });

  it('records index values in the window and in history under DATA_DIR/btc-feed', (t) => {
    const { service, indexes, index, live, historySamples, historyDirs } = setup(t);
    live();
    index(indexes[0], 61234.5);
    assert.deepEqual(service.getWindow(60).index, [{ t: T0 + 1000, value: 61234.5 }]);
    assert.deepEqual(historySamples, [{ value: 61234.5, timestamp: T0 + 1000 }]);
    assert.deepEqual(historyDirs, [path.join('/data-root', 'btc-feed')]);
  });

  it('does not record a rejected index value', (t) => {
    const { indexes, index, live, historySamples } = setup(t);
    live();
    index(indexes[0], 100, Date.now() - 60_000);
    assert.deepEqual(historySamples, []);
  });

  it('limits the window to the requested seconds', (t) => {
    const { service, trades, trade, live, tick } = setup(t);
    live();
    for (let i = 0; i < 4; i++) { trade(trades[0]); tick(1000); }
    trade(trades[0]);
    assert.deepEqual(service.getWindow(2).bars.map(b => (b.t - T0) / 1000), [4, 5]);
  });
});

describe('BTC feed emission', () => {
  it('batches changes into one update per 250ms', (t) => {
    const { trades, trade, live, tick, emitted } = setup(t);
    live();
    for (let i = 0; i < 3; i++) trade(trades[0], { price: 100 + i });
    tick(250);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].room, 'btc-feed');
    assert.equal(emitted[0].event, 'btc-feed:update');
    assert.equal(emitted[0].payload.bars[0].trades, 3);
    assert.equal(emitted[0].payload.status.coinbase.lastEventAt, T0 + 1000);
    assert.equal(emitted[0].payload.status.now, T0 + 1250);
  });

  it('stays quiet when nothing changed and reports a disconnect once', (t) => {
    const { trades, trade, live, tick, emitted } = setup(t);
    live();
    trade(trades[0]);
    tick(250);
    emitted.length = 0;
    tick(5000);
    assert.equal(emitted.length, 0);
    trades[0].callbacks.onDisconnect();
    tick(1000);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].payload.status.coinbase.connected, false);
  });

  it('survives a realtime bus that throws', (t) => {
    const { service, trades, trade, live, tick } = setup(t, { io: { to: () => ({ emit: () => { throw new Error('bus down'); } }) } });
    live();
    trade(trades[0]);
    tick(250);
    tick(250);
    assert.equal(service.getStatus().running, true);
  });

  it('survives a history that throws', (t) => {
    const { service, indexes, index, live } = setup(t, {
      deps: { createIndexHistory: () => ({ add: () => { throw new Error('boom'); }, pause: async () => {}, resume: () => {} }) },
    });
    live();
    index(indexes[0], 5);
    assert.equal(service.getWindow(60).index.length, 1);
  });
});

describe('BTC feed stall recovery', () => {
  it('replaces a connected but silent Coinbase feed after 30s, then at most once per minute', (t) => {
    const { trades, live, tick } = setup(t);
    live(); // 1s in
    tick(28_000);
    assert.equal(trades.length, 1);
    tick(2_000);
    assert.equal(trades.length, 2);
    assert.equal(trades[0].disconnects, 1);
    assert.equal(trades[1].connects, 1);
    tick(58_000);
    assert.equal(trades.length, 2);
    tick(3_000);
    assert.equal(trades.length, 3);
  });

  it('leaves a source alone while it is delivering', (t) => {
    const { trades, indexes, trade, index, live, tick } = setup(t);
    live();
    for (let i = 0; i < 12; i++) { trade(trades[0]); index(indexes[0]); tick(10_000); }
    assert.equal(trades.length, 1);
    assert.equal(indexes.length, 1);
  });

  it('replaces only the index client when only the index stalls', (t) => {
    const { trades, indexes, trade, live, tick } = setup(t);
    live();
    for (let i = 0; i < 7; i++) { trade(trades[0]); tick(5_000); }
    assert.equal(trades.length, 1);
    assert.equal(indexes.length, 2);
    assert.equal(indexes[0].disconnects, 1);
  });

  it('is not postponed by duplicate or late trades', (t) => {
    const { service, trades, trade, live, tick } = setup(t);
    live();
    trade(trades[0], { tradeId: 'same' });
    const acceptedAt = Date.now();
    for (let i = 0; i < 4; i++) {
      tick(8_000);
      if (trades.length > 1) break;
      trade(trades[0], { tradeId: 'same', timestamp: acceptedAt });
      trade(trades[0], { timestamp: Date.now() - 11_000 });
    }
    assert.equal(service.getStatus().coinbase.lastEventAt, acceptedAt);
    assert.equal(trades.length, 2);
  });

  it('ignores every callback from a replaced feed', (t) => {
    const { service, trades, trade, live, tick } = setup(t);
    live();
    tick(30_000);
    assert.equal(trades.length, 2);
    trades[1].callbacks.onConnect();
    tick(1000);
    trade(trades[0], { price: 999 });
    trades[0].callbacks.onDisconnect();
    assert.deepEqual(service.getWindow(60).bars, []);
    assert.equal(service.getStatus().coinbase.connected, true);
    trade(trades[1], { price: 100 });
    trades[0].callbacks.onConnect();
    trade(trades[1], { price: 101 });
    assert.equal(service.getWindow(60).bars[0].trades, 2, 'a stale onConnect must not restart the accept window');
  });

  it('warns once per connection when every trade is being dropped', (t) => {
    const { trades, trade, live, tick, logs } = setup(t);
    live();
    tick(5_000);
    for (let i = 0; i < 120; i++) trade(trades[0], { timestamp: Date.now() - 20_000 });
    assert.equal(logs.warn.length, 1);
    assert.match(logs.warn[0], /clock/i);
    trades[0].callbacks.onDisconnect();
    trades[0].callbacks.onConnect();
    tick(6_000);
    for (let i = 0; i < 60; i++) trade(trades[0], { timestamp: Date.now() - 20_000 });
    assert.equal(logs.warn.length, 2);
  });

  it('does not warn about the snapshot replayed on connect', (t) => {
    const { service, trades, trade, logs } = setup(t);
    service.start();
    trades[0].callbacks.onConnect();
    for (let i = 0; i < 200; i++) trade(trades[0], { timestamp: Date.now() - 3_000 });
    assert.deepEqual(logs.warn, []);
  });

  it('does not warn about dropped trades once one has been accepted', (t) => {
    const { trades, trade, live, tick, logs } = setup(t);
    live();
    trade(trades[0]);
    tick(6_000);
    for (let i = 0; i < 120; i++) trade(trades[0], { timestamp: Date.now() - 20_000 });
    assert.deepEqual(logs.warn, []);
  });

  it('starts the index and retries later when the Coinbase feed cannot be created', (t) => {
    let calls = 0;
    const made = [];
    const { service, indexes, logs, tick } = setup(t, {
      deps: {
        createTradeFeed: () => {
          if (++calls === 1) throw new Error('no socket');
          const feed = { connect: () => made.push('connect'), disconnect: () => {} };
          return feed;
        },
      },
    });
    service.start();
    assert.equal(indexes[0].connects, 1);
    assert.equal(logs.error.length, 1);
    assert.match(logs.error[0], /no socket/);
    tick(31_000);
    assert.deepEqual(made, ['connect']);
  });
});

describe('BTC feed lifecycle', () => {
  it('start is idempotent', (t) => {
    const { service, trades } = setup(t);
    service.start();
    service.start();
    assert.equal(trades.length, 1);
  });

  it('stop disconnects both sources, silences timers and ignores late callbacks', (t) => {
    const { service, trades, indexes, trade, live, tick, emitted } = setup(t);
    live();
    trade(trades[0]);
    service.stop();
    assert.equal(trades[0].disconnects, 1);
    assert.equal(indexes[0].disconnects, 1);
    trades[0].callbacks.onConnect();
    trade(trades[0], { price: 500 });
    tick(120_000);
    assert.equal(emitted.length, 0);
    assert.equal(trades.length, 1);
    const status = service.getStatus();
    assert.equal(status.running, false);
    assert.equal(status.coinbase.connected, false);
  });

  it('can start again after a stop', (t) => {
    const { service, trades, trade, live, tick } = setup(t);
    live();
    service.stop();
    service.start();
    assert.equal(trades.length, 2);
    trades[1].callbacks.onConnect();
    tick(1000);
    trade(trades[1], { price: 7 });
    assert.equal(service.getWindow(60).bars[0].close, 7);
  });

  it('passes history pause and resume through', async (t) => {
    const { service, historyCalls } = setup(t);
    await service.pauseHistory();
    service.resumeHistory();
    assert.deepEqual(historyCalls, ['pause', 'resume']);
  });

  it('opens nothing before start', (t) => {
    const { trades, indexes } = setup(t, { deps: { DATA_DIR: os.tmpdir() } });
    assert.equal(trades.length + indexes.length, 0);
  });
});
