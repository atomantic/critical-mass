// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { acceptsBtcTick } = require('../src/btc-tick-filter');

const accepts = (exchange, pair, defaultPair) => acceptsBtcTick(exchange, pair, () => defaultPair);

describe('acceptsBtcTick', () => {
  for (const [name, exchange, pair, defaultPair, expected] of /** @type {Array<[string, string, any, any, boolean]>} */ ([
    ['rejects CRO from a CRO default', 'cryptocom', 'CRO_USD', 'CRO_USD', false],
    ['rejects a non-default BTC pair', 'cryptocom', 'BTC_USD', 'CRO_USD', false],
    ['accepts the BTC default', 'coinbase', 'BTC-USDC', 'BTC-USDC', true],
    ['accepts an unlabeled tick when the default is BTC', 'coinbase', undefined, 'BTC-USDC', true],
    ['rejects an unlabeled tick when the default is not BTC', 'cryptocom', undefined, 'CRO_USD', false],
    ['accepts Gemini BTCUSD', 'gemini', 'BTCUSD', 'BTCUSD', true],
    ['rejects Gemini ETHUSD', 'gemini', 'ETHUSD', 'ETHUSD', false],
    ['rejects wrapped BTC', 'coinbase', 'CBBTC-USD', 'CBBTC-USD', false],
    ['keeps accepting when nothing is configured or labeled', 'coinbase', undefined, null, true],
  ])) {
    it(name, () => assert.equal(accepts(exchange, pair, defaultPair), expected));
  }

  it('asks for the default pair of the tick\'s own exchange', () => {
    const asked = [];
    acceptsBtcTick('gemini', 'BTCUSD', (exchange) => { asked.push(exchange); return 'BTCUSD'; });
    assert.deepEqual(asked, ['gemini']);
  });
});

describe('gateway tick listeners', () => {
  const source = fs.readFileSync(require.resolve('../server'), 'utf8');
  /** Run one production ipcEventListeners.push(...) block with a fake gateway. */
  const listener = (marker, context) => {
    const start = source.indexOf('ipcEventListeners.push(', source.indexOf(marker));
    const block = source.slice(start, source.indexOf('\n});', start) + '\n});'.length);
    let fn;
    vm.runInContext(block, vm.createContext({
      ipcEventListeners: { push: (f) => { fn = f; } }, IPC_CHANNELS: { REGIME_STATUS: 'regime:status' },
      acceptsBtcTick, parseFloat, Number, Date, ...context,
    }));
    return fn;
  };
  const status = (pair, lastPrice) => ({ channel: 'regime:status', payload: { pair, status: { market: { lastPrice, volume24h: 1 } } } });

  it('keeps CRO prices out of the candle cache and lets BTC in', () => {
    const ticks = [];
    const defaults = { cryptocom: 'CRO_USD', coinbase: 'BTC-USDC' };
    const onStatus = listener('// Feed exchange IPC ticks into the shared candle cache', {
      getDefaultPair: (e) => defaults[e], candleCache: { processTick: (name, price) => ticks.push([name, price]) },
    });
    onStatus('cryptocom', status('CRO_USD', 0.09));
    onStatus('coinbase', status('BTC-USDC', 61000));
    assert.deepEqual(ticks, [['coinbase', 61000]]);
  });

  it('keeps a non-BTC Coinbase default out of the BTC predictor', () => {
    const run = (defaultPair) => {
      const prices = [];
      listener('// Forward coinbase BTC price data to updown service', {
        getDefaultPair: () => defaultPair, updownService: { handlePriceTick: (price) => prices.push(price) },
      })('coinbase', status(defaultPair, 3000));
      return prices;
    };
    assert.deepEqual(run('ETH-USDC'), []);
    assert.deepEqual(run('BTC-USDC'), [3000]);
  });
});
