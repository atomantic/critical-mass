// @ts-check
// Real snapshot/archive IO and cold readers, entirely in a disposable install.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const backup = require('../../src/backup-service');
const migration = require('../../src/migration');
const dryRun = require('../../src/dry-run-state');
const { createClosedTrades } = require('../../src/closed-trades');
const { createFillLedger } = require('../../src/fill-ledger');

const exerciseFundRestoreGeneration = async (t, format, explicitEmpty) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-restore-generation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const paths = { dataDir, baseConfigFile: path.join(root, 'base.json') };
  const fund = path.join(dataDir, 'coinbase', 'BTC-USDC');
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  write(paths.baseConfigFile, { exchanges: { coinbase: { pairs: { 'BTC-USDC': { productId: 'BTC-USDC', enabled: true } } } } });
  write(path.join(dataDir, 'coinbase', 'ETH-USDC', 'chart-data-buffer.json'), { cacheOnly: true });
  write(path.join(fund, 'fill-ledger.json'), []);
  write(path.join(fund, 'regime-state.json'), { position: {} });
  if (explicitEmpty) write(path.join(fund, 'closed-trades.json'), []);
  const saved = format === 'hourly' ? backup.createFundStateBackup({ paths }) : await backup.createBackup({ paths });
  assert.equal(saved.success, true, JSON.stringify(saved));

  t.mock.method(migration, 'getExchangeDataDir', (exchange) => path.join(dataDir, exchange));
  t.mock.method(require('../../src/config-utils'), 'getDefaultPair', () => 'BTC-USDC');
  const legacy = path.join(root, 'legacy-dry-run.json');
  const previousLegacy = dryRun.LEGACY_STATE_FILE;
  dryRun.LEGACY_STATE_FILE = legacy;
  t.after(() => { dryRun.LEGACY_STATE_FILE = previousLegacy; });
  write(legacy, { version: 1, exchanges: { 'coinbase::BTC-USDC': { isDryRun: true, savedAt: Date.now(), executor: {}, position: { realizedPnL: 99 } } } });
  write(path.join(fund, 'fill-ledger.json'), [{ orderId: 'later-sell' }]);
  write(path.join(fund, 'closed-trades.json'), [{ sellOrderId: 'later-sell', pnl: 25 }]);
  write(path.join(fund, 'manual-trades.json'), { trades: [{ buyOrderId: 'later-manual' }] });
  write(path.join(fund, 'pending-corrective-buys.json'), [{ buyOrderId: 'later-corrective' }]);
  write(path.join(fund, 'state.json'), { laterPosition: true });
  write(path.join(fund, 'dry-run-state.json'), { version: 1, state: { position: { realizedPnL: 25 } } });
  const protectedFiles = [
    path.join(fund, 'chart-data-buffer.json'),
    path.join(dataDir, 'coinbase', 'ETH-USDC', 'closed-trades.json'),
    path.join(dataDir, 'coinbase', 'ETH-USDC', 'dry-run-state.json'),
    path.join(dataDir, 'coinbase-keys.json'),
    path.join(dataDir, 'operator-auth.json'),
    legacy,
  ];
  for (const file of protectedFiles.filter(file => file !== legacy)) write(file, { preserve: path.basename(file) });
  const originals = protectedFiles.map(file => fs.readFileSync(file));
  const cold = () => { const reader = createClosedTrades('coinbase', 'BTC-USDC'); reader.load(); return reader; };
  assert.equal(cold().getTotalPnL(), 25, 'later sale really reaches the cold consumer');

  const restored = format === 'hourly'
    ? backup.restoreFundStateBackup(saved.snapshotId, 'coinbase', 'BTC-USDC', { paths })
    : backup.restoreBackup(saved.filename, { paths });
  assert.equal(restored.success, true, JSON.stringify(restored));
  const ledger = JSON.parse(fs.readFileSync(path.join(fund, 'fill-ledger.json'), 'utf8'));
  assert.deepEqual(ledger, []);
  const reader = cold();
  const fillLedger = createFillLedger('coinbase', 'BTC-USDC', 'BTC-USDC');
  fillLedger.load();
  reader.migrateFromFills(fillLedger);
  assert.equal(reader.getCount(), 0);
  assert.equal(reader.getTotalPnL(), 0);
  assert.equal(fs.existsSync(path.join(fund, 'closed-trades.json')), explicitEmpty);
  for (const name of ['manual-trades.json', 'pending-corrective-buys.json', 'state.json']) {
    assert.equal(fs.existsSync(path.join(fund, name)), false, `${name} must return to absence`);
  }
  assert.equal(dryRun.loadState('coinbase', 'BTC-USDC'), null, 'cold dry-run reader must not re-import legacy state');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fund, 'dry-run-state.json'), 'utf8')), { version: 1, state: null });
  protectedFiles.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), originals[i], `${file} survives`));
  // Positive control: this legacy fixture really would be imported without the tombstone.
  fs.rmSync(path.join(fund, 'dry-run-state.json'));
  assert.equal(dryRun.loadState('coinbase', 'BTC-USDC').position.realizedPnL, 99);
};

module.exports = { exerciseFundRestoreGeneration };
