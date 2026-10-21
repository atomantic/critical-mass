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

describe('manual-trades transient read error', () => {
  it('does not quarantine a valid file when readFileSync throws EIO', (t) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-trades-eio-'));
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
    fs.writeFileSync(file, '{"trades":[]}');

    const realRead = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', (p, ...rest) => {
      if (p === file) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return realRead(p, ...rest);
    });

    assert.throws(() => store.load(), /EIO/);
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.readdirSync(dir).some(f => f.includes('.corrupt-')), false);
  });
});

describe('manual-trades wrong top-level shape', () => {
  const setup = (t, content) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-trades-shape-'));
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
    fs.writeFileSync(file, content);
    return { store, dir, file };
  };

  it('quarantines valid JSON that is null (not an object)', (t) => {
    const { store, dir, file } = setup(t, 'null');
    store.load();
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readdirSync(dir).filter(f => f.includes('.corrupt-')).length, 1);
  });

  it('quarantines a trades entry that is not an object', (t) => {
    const { store, dir, file } = setup(t, '{"trades":[null]}');
    store.load();
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readdirSync(dir).filter(f => f.includes('.corrupt-')).length, 1);
  });
});
