// @ts-check
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { FakeWebSocket, installFakeWebSocket } = require('./helpers/fake-websocket');

const restoreWebSocket = installFakeWebSocket();
after(restoreWebSocket);
const { createCryptocomWebSocketFeed } = require('../src/adapters/cryptocom/websocket');

const tickerMessage = (tick) => JSON.stringify({
  result: { channel: 'ticker.BTC_USD', data: [tick] },
});

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
    socket.open();
    socket.receive(tickerMessage({ a: '100', b: '99', k: '101', v: '10', t: 123 }));

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
    socket.open();

    for (const tick of [
      { a: '100', b: '99' },
      { a: 'not-a-price', b: '99', k: '101' },
      { a: '100', b: '0', k: '101' },
      { a: '100', b: '102', k: '101' },
    ]) {
      socket.receive(tickerMessage(tick));
    }

    assert.deepEqual(tickers, []);
    feed.disconnect();
  });
});
