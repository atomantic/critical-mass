// @ts-check
// Hourly fund-state recovery points must survive deletion of a fund directory,
// retain only the accounting files that cannot be reconstructed, and restore
// through the same transactional applier used by full archives.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createFundStateBackup,
  listFundStateBackups,
  restoreFundStateBackup,
} = require('../src/backup-service');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-fund-state-backup-test-'));
const dataDir = path.join(root, 'data');
const baseConfigFile = path.join(root, 'config.json');
const paths = { dataDir, baseConfigFile };
const fundDir = path.join(dataDir, 'coinbase', 'BTC-USDC');

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
};

writeJson(baseConfigFile, {
  exchanges: {
    coinbase: {
      pairs: { 'BTC-USDC': { productId: 'BTC-USDC', enabled: true } },
    },
  },
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

describe('hourly fund-state snapshots', () => {
  it('copies non-reconstructable fund state and prunes rolling snapshots', () => {
    writeJson(path.join(fundDir, 'fill-ledger.json'), { fills: [{ id: 'fill-1' }] });
    writeJson(path.join(fundDir, 'regime-state.json'), { position: { totalAsset: 0.5 } });
    writeJson(path.join(fundDir, 'closed-trades.json'), [{ id: 'trade-1' }]);
    writeJson(path.join(fundDir, 'chart-data-buffer.json'), { candles: ['rebuildable'] });

    const first = createFundStateBackup({ paths, now: new Date('2026-09-20T00:00:00.000Z'), maxBackups: 2 });
    const second = createFundStateBackup({ paths, now: new Date('2026-09-20T01:00:00.000Z'), maxBackups: 2 });
    const third = createFundStateBackup({ paths, now: new Date('2026-09-20T02:00:00.000Z'), maxBackups: 2 });

    assert.equal(first.success, true);
    assert.equal(second.success, true);
    assert.equal(third.success, true);
    assert.equal(third.files, 3);
    assert.equal(third.funds[0].files.includes('chart-data-buffer.json'), false);

    const snapshots = listFundStateBackups({ paths });
    assert.deepEqual(snapshots.map(({ snapshotId }) => snapshotId), [third.snapshotId, second.snapshotId]);
    assert.equal(fs.existsSync(path.join(dataDir, 'backups', 'fund-state', first.snapshotId)), false);
  });

  it('restores a fund after its live directory is destroyed', () => {
    const snapshots = listFundStateBackups({ paths });
    const snapshot = snapshots[0];
    assert.ok(snapshot);

    fs.rmSync(fundDir, { recursive: true, force: true });
    const restored = restoreFundStateBackup(snapshot.snapshotId, 'coinbase', 'BTC-USDC', { paths });

    assert.equal(restored.success, true, JSON.stringify(restored));
    assert.equal(restored.filesRestored, 3);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fundDir, 'fill-ledger.json'), 'utf8')), { fills: [{ id: 'fill-1' }] });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fundDir, 'regime-state.json'), 'utf8')), { position: { totalAsset: 0.5 } });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fundDir, 'closed-trades.json'), 'utf8')), [{ id: 'trade-1' }]);
    assert.equal(fs.existsSync(path.join(fundDir, 'chart-data-buffer.json')), false);
  });

  it('includes dry-run-state.json in snapshots (regression test for #702)', () => {
    // Seed a fund with dry-run-state.json
    const dryRunState = {
      lastUpdated: '2026-09-22T12:00:00.000Z',
      byExchange: {
        coinbase: {
          'BTC-USDC': {
            executorState: {
              pendingOrders: [{ id: 'order-1' }],
              filledOrders: [],
              activeTpOrderId: null,
              simulatedRealizedPnL: 100.5,
            },
          },
        },
      },
    };
    writeJson(path.join(fundDir, 'dry-run-state.json'), dryRunState);

    // Create snapshot
    const backup = createFundStateBackup({ paths, now: new Date('2026-09-20T03:00:00.000Z') });
    assert.equal(backup.success, true, JSON.stringify(backup));
    assert.ok(backup.funds[0].files.includes('dry-run-state.json'), 'Snapshot should include dry-run-state.json');

    // Delete fund directory
    fs.rmSync(fundDir, { recursive: true, force: true });
    assert.equal(fs.existsSync(fundDir), false);

    // Restore snapshot
    const restored = restoreFundStateBackup(backup.snapshotId, 'coinbase', 'BTC-USDC', { paths });
    assert.equal(restored.success, true, JSON.stringify(restored));

    // Verify dry-run-state.json was restored byte-identical
    assert.equal(fs.existsSync(path.join(fundDir, 'dry-run-state.json')), true);
    const restoredDryRunState = JSON.parse(fs.readFileSync(path.join(fundDir, 'dry-run-state.json'), 'utf8'));
    assert.deepEqual(restoredDryRunState, dryRunState);
  });

  it('rejects path traversal before touching the data directory', () => {
    const result = restoreFundStateBackup('../outside', 'coinbase', 'BTC-USDC', { paths });
    assert.equal(result.success, false);
    assert.match(result.error, /Invalid fund-state/);
  });
});
