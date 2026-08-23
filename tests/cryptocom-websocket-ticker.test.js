// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

class FakeWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor() {
    super();
    this.readyState = FakeWebSocket.OPEN;
    FakeWebSocket.instances.push(this);
  }

  send() {}
  ping() {}
  close() { this.readyState = FakeWebSocket.CLOSED; }
}

const wsPath = require.resolve('ws');
require.cache[wsPath] = /** @type {any} */ ({
  id: wsPath,
  filename: wsPath,
  loaded: true,
  exports: FakeWebSocket,
  children: [],
});
delete require.cache[require.resolve('../src/adapters/cryptocom/websocket')];
const { createCryptocomWebSocketFeed } = require('../src/adapters/cryptocom/websocket');

const tickerMessage = (tick) => Buffer.from(JSON.stringify({
  result: { channel: 'ticker.BTC_USD', data: [tick] },
}));

describe('Crypto.com websocket ticker validation', () => {
  it('forwards a complete, finite, uncrossed ticker', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    FakeWebSocket.instances = [];
    const tickers = [];
    const feed = createCryptocomWebSocketFeed('cryptocom', {
      productId: 'BTC-USD',
      onTicker: (ticker) => tickers.push(ticker),
    });
    feed.connect();
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');
    socket.emit('message', tickerMessage({ a: '100', b: '99', k: '101', v: '10', t: 123 }));

    assert.deepEqual(tickers, [{ price: 100, bid: 99, ask: 101, volume24h: 10, timestamp: 123 }]);
    feed.disconnect();
  });

  it('withholds missing, non-finite, non-positive, and crossed ticker data', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    FakeWebSocket.instances = [];
    const tickers = [];
    const feed = createCryptocomWebSocketFeed('cryptocom', {
      productId: 'BTC-USD',
      onTicker: (ticker) => tickers.push(ticker),
    });
    feed.connect();
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');

    for (const tick of [
      { a: '100', b: '99' },
      { a: 'not-a-price', b: '99', k: '101' },
      { a: '100', b: '0', k: '101' },
      { a: '100', b: '102', k: '101' },
    ]) {
      socket.emit('message', tickerMessage(tick));
    }

    assert.deepEqual(tickers, []);
    feed.disconnect();
  });
});
