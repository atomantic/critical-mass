// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const migration = require('../src/migration');

describe('manual-trades unreadable file', () => {
  it('preserves a truncated manual-trades.json as .corrupt-* before any persist', (t) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-trades-corrupt-'));
    const original = migration.getExchangeDataDir;
    migration.getExchangeDataDir = (exchange) => {
      const d = path.join(tmpRoot, exchange);
      fs.mkdirSync(d, { recursive: true });
      return d;
    };
    t.after(() => {
      migration.getExchangeDataDir = original;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    const { createManualTradeStore } = require('../src/manual-trades');
    const store = createManualTradeStore('coinbase', 'BTC-USDC');
    const dir = path.join(tmpRoot, 'coinbase', 'BTC-USDC');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'manual-trades.json');
    fs.writeFileSync(file, '{"trades":[{"id":"x"');

    store.load();

    assert.equal(fs.existsSync(file), false);
    const q = fs.readdirSync(dir).filter(f => f.startsWith('manual-trades.json.corrupt-'));
    assert.equal(q.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, q[0]), 'utf8'), '{"trades":[{"id":"x"');
  });
});
