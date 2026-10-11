const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const backend = require('../src/config-utils');

// Exercise the exported pure UI helpers without loading React or mounting the app.
const source = fs.readFileSync(path.join(__dirname, '../admin/src/App.jsx'), 'utf8');
const helpers = source.match(/export function get(?:Base|Quote)Currency\(productId\) \{[\s\S]*?\n\}/g);
assert.equal(helpers?.length, 2);
const frontend = vm.runInNewContext(`${helpers.join('\n').replaceAll('export function', 'function')}; ({ getBaseCurrency, getQuoteCurrency })`);

for (const [name, parser] of [['gateway', backend], ['admin UI', frontend]]) {
  test(`${name} parses concatenated fiat and crypto quote suffixes`, () => {
    for (const [product, base, quote] of [
      ['BTCEUR', 'BTC', 'EUR'],
      ['ETHGBP', 'ETH', 'GBP'],
      ['SOLSGD', 'SOL', 'SGD'],
      ['ETHBTC', 'ETH', 'BTC'],
      ['SOLETH', 'SOL', 'ETH'],
      ['etheur', 'ETH', 'EUR'],
      ['BTCUSD', 'BTC', 'USD'],
      ['ETHUSDC', 'ETH', 'USDC'],
      ['SOLUSDT', 'SOL', 'USDT'],
      ['BTC-USDC', 'BTC', 'USDC'],
      ['CRO_USD', 'CRO', 'USD'],
    ]) {
      assert.equal(parser.getBaseCurrency(product), base, `${product} base`);
      assert.equal(parser.getQuoteCurrency(product), quote, `${product} quote`);
    }
  });

  test(`${name} retains standalone asset and missing-product defaults`, () => {
    for (const product of ['BTC', 'ETH', 'EUR', 'GBP', 'SGD', 'UNKNOWN']) {
      assert.equal(parser.getBaseCurrency(product), product);
      assert.equal(parser.getQuoteCurrency(product), 'USD');
    }
    assert.equal(parser.getBaseCurrency(undefined), 'BTC');
    assert.equal(parser.getQuoteCurrency(undefined), name === 'admin UI' ? 'USDC' : 'USD');
  });
}
