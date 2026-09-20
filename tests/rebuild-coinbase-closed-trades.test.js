// @ts-check
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const script = path.join(__dirname, '..', 'scripts', 'rebuild-coinbase-closed-trades.js');
const roots = [];

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
};

const fixture = (realizedPnL = 15) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-closed-trades-'));
  roots.push(root);
  const fund = path.join(root, 'coinbase', 'BTC-USDC');
  writeJson(path.join(fund, 'fill-ledger.json'), [
    { side: 'buy', orderId: 'body-buy', bodyId: 'body-1', size: 2, quoteAmount: 200, netFee: 0, timestamp: 1 },
    {
      side: 'sell', orderId: 'body-sell', bodyId: 'body-1', size: 1, quoteAmount: 210, netFee: 0,
      timestamp: 2, bodyPnl: 10, bodyCostBasis: 100, bodyAvgPrice: 100, bodyHoldbackAsset: 1,
      bodyTier: 'core', cycleId: 'cycle-1',
    },
    { side: 'buy', orderId: 'legacy-buy', sellOrderId: 'legacy-sell', size: 1, quoteAmount: 100, netFee: 0, timestamp: 3 },
    { side: 'sell', orderId: 'legacy-sell', size: 1, quoteAmount: 105, netFee: 0, timestamp: 4, cycleId: 'cycle-2' },
  ]);
  writeJson(path.join(fund, 'regime-state.json'), { position: { realizedPnL } });
  writeJson(path.join(fund, 'closed-trades.json'), [{ sellOrderId: 'stale', pnl: 999 }]);
  return { root, fund };
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('rebuild-coinbase-closed-trades', () => {
  it('uses ledger annotations, verifies cycle coverage and backs up before applying', () => {
    const { root, fund } = fixture();
    const output = execFileSync(process.execPath, [script, '--apply'], {
      env: { ...process.env, CRITICAL_MASS_DATA_DIR: root },
      encoding: 'utf8',
    });

    assert.match(output, /Verified: 2 rebuilt trades/);
    const rebuilt = JSON.parse(fs.readFileSync(path.join(fund, 'closed-trades.json'), 'utf8'));
    assert.equal(rebuilt.length, 2);
    assert.equal(rebuilt.reduce((sum, trade) => sum + trade.pnl, 0), 15);
    assert.equal(rebuilt.find(trade => trade.sellOrderId === 'body-sell').holdbackAsset, 1);
    assert.equal(fs.readdirSync(fund).filter(name => name.startsWith('closed-trades.json.backup-rebuild-')).length, 1);
  });

  it('refuses to write when the rebuilt P&L disagrees with regime state', () => {
    const { root, fund } = fixture(999);
    const result = spawnSync(process.execPath, [script, '--apply'], {
      env: { ...process.env, CRITICAL_MASS_DATA_DIR: root },
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not match regime-state P&L/);
    const unchanged = JSON.parse(fs.readFileSync(path.join(fund, 'closed-trades.json'), 'utf8'));
    assert.deepEqual(unchanged, [{ sellOrderId: 'stale', pnl: 999 }]);
    assert.equal(fs.readdirSync(fund).filter(name => name.startsWith('closed-trades.json.backup-rebuild-')).length, 0);
  });
});
