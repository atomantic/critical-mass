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
  pruneFundStateBackups,
  checkFundStateRestorePreconditions,
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

  it('restores the recovery-buy records engine startup uses to spare open buys', () => {
    // Without these files, startup classifies a manual or corrective recovery
    // buy still open on the exchange as an orphan and cancels it.
    const manualTrades = { trades: [{ id: 'mt-1', buyOrderId: 'buy-manual', status: 'buy_pending' }] };
    const correctiveBuys = [{ buyOrderId: 'buy-corrective', filled: false, cancelled: false }];
    writeJson(path.join(fundDir, 'manual-trades.json'), manualTrades);
    writeJson(path.join(fundDir, 'pending-corrective-buys.json'), correctiveBuys);

    const backup = createFundStateBackup({ paths, now: new Date('2026-09-20T04:00:00.000Z') });
    assert.equal(backup.success, true, JSON.stringify(backup));

    fs.rmSync(fundDir, { recursive: true, force: true });
    const restored = restoreFundStateBackup(backup.snapshotId, 'coinbase', 'BTC-USDC', { paths });

    assert.equal(restored.success, true, JSON.stringify(restored));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fundDir, 'manual-trades.json'), 'utf8')), manualTrades);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fundDir, 'pending-corrective-buys.json'), 'utf8')), correctiveBuys);
  });

  it('rejects path traversal before touching the data directory', () => {
    const result = restoreFundStateBackup('../outside', 'coinbase', 'BTC-USDC', { paths });
    assert.equal(result.success, false);
    assert.match(result.error, /Invalid fund-state/);
  });
});

// An absent sidecar and an explicit empty one describe the same generation.
const { exerciseFundRestoreGeneration } = require('./helpers/fund-restore-generation');
for (const explicitEmpty of [false, true]) {
  it(`hourly restore resets newer accounting (${explicitEmpty ? 'empty' : 'absent'} closed trades, #1702)`, async (t) => {
    await exerciseFundRestoreGeneration(t, 'hourly', explicitEmpty);
  });
}

// Each damaged recovery point has an older, complete sibling. Invalid entries
// must remain available for diagnosis without spending the retention budget.
const makeRecoveryFixture = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-snapshot-validation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = { dataDir: path.join(root, 'data'), baseConfigFile: path.join(root, 'config.json') };
  writeJson(paths.baseConfigFile, { exchanges: { coinbase: { pairs: { 'BTC-USDC': {} } } } });
  const liveDir = path.join(paths.dataDir, 'coinbase', 'BTC-USDC');
  writeJson(path.join(liveDir, 'fill-ledger.json'), { fills: ['saved'] });
  writeJson(path.join(liveDir, 'regime-state.json'), { generation: 'saved' });
  const older = createFundStateBackup({ paths, now: new Date('2026-10-01'), maxBackups: 10 });
  const newer = createFundStateBackup({ paths, now: new Date('2026-10-02'), maxBackups: 10 });
  assert.equal(older.success, true, older.error);
  assert.equal(newer.success, true, newer.error);
  const snapshotDir = path.join(paths.dataDir, 'backups', 'fund-state', newer.snapshotId);
  const manifestFile = path.join(snapshotDir, 'fund-state-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  return { root, paths, older, newer, liveDir, snapshotDir, manifestFile, manifest,
    ledger: path.join(snapshotDir, 'coinbase', 'BTC-USDC', 'fill-ledger.json') };
};

const damagedSnapshots = {
  'missing child': ({ ledger }) => fs.unlinkSync(ledger),
  'unreadable child': ({ ledger }) => fs.chmodSync(ledger, 0),
  'nonregular child': ({ ledger }) => { fs.unlinkSync(ledger); fs.mkdirSync(ledger); },
  'symlinked child': ({ ledger, root }) => {
    const outside = path.join(root, 'outside.json');
    writeJson(outside, { outside: true });
    fs.unlinkSync(ledger);
    fs.symlinkSync(outside, ledger);
  },
  'symlinked exchange': ({ snapshotDir, root }) => {
    const source = path.join(snapshotDir, 'coinbase');
    const outside = path.join(root, 'outside-exchange');
    fs.renameSync(source, outside);
    fs.symlinkSync(outside, source, 'dir');
  },
  'symlinked pair': ({ snapshotDir, root }) => {
    const source = path.join(snapshotDir, 'coinbase', 'BTC-USDC');
    const outside = path.join(root, 'outside-pair');
    fs.renameSync(source, outside);
    fs.symlinkSync(outside, source, 'dir');
  },
  'symlinked manifest': ({ manifestFile, root }) => {
    const outside = path.join(root, 'outside-manifest.json');
    fs.renameSync(manifestFile, outside);
    fs.symlinkSync(outside, manifestFile);
  },
  'invalid creation time': ({ manifest }) => { manifest.createdAt = 'not-a-time'; },
  'missing creation time': ({ manifest }) => { delete manifest.createdAt; },
  'snapshot identity mismatch': ({ manifest }) => { manifest.snapshotId = 'another-snapshot'; },
  'empty funds': ({ manifest }) => { manifest.funds = []; },
  'null fund': ({ manifest }) => { manifest.funds.push(null); },
  'duplicate fund': ({ manifest }) => { manifest.funds.push({ ...manifest.funds[0] }); },
  'missing fund identity': ({ manifest }) => { delete manifest.funds[0].exchange; },
  'escaping fund identity': ({ manifest }) => { manifest.funds[0].exchange = '..'; },
  'dot fund identity': ({ manifest }) => { manifest.funds[0].pair = '.'; },
  'empty file list': ({ manifest }) => { manifest.funds[0].files = []; },
  'duplicate file': ({ manifest }) => { manifest.funds[0].files.push(manifest.funds[0].files[0]); },
  'escaping file': ({ manifest }) => { manifest.funds[0].files.push('../../outside.json'); },
  'unsupported file': ({ manifest }) => { manifest.funds[0].files.push('chart-data-buffer.json'); },
  'incomplete second fund': ({ manifest }) => { manifest.funds.push({ exchange: 'coinbase', pair: 'ETH-USDC', files: ['fill-ledger.json'] }); },
};

describe('complete snapshot validation (#1703)', () => {
  for (const [name, damage] of Object.entries(damagedSnapshots)) {
    it(`excludes ${name} from listing, preflight and retention without deleting it`, (t) => {
      const fixture = makeRecoveryFixture(t);
      damage(fixture);
      // A symlinked manifest must stay untouched, rather than being rewritten.
      if (name !== 'symlinked manifest') writeJson(fixture.manifestFile, fixture.manifest);
      const before = fs.readdirSync(fixture.paths.dataDir).sort();
      assert.deepEqual(listFundStateBackups({ paths: fixture.paths }).map((entry) => entry.snapshotId), [fixture.older.snapshotId]);
      const preflight = checkFundStateRestorePreconditions(fixture.newer.snapshotId, 'coinbase', 'BTC-USDC', { paths: fixture.paths });
      assert.equal(preflight.ok, false);
      assert.match(preflight.error, /snapshot|manifest/i);
      assert.deepEqual(fs.readdirSync(fixture.paths.dataDir).sort(), before, 'validation is read-only');
      assert.deepEqual(pruneFundStateBackups(1, { paths: fixture.paths }), { pruned: 0, remaining: 1 });
      assert.ok(fs.existsSync(fixture.snapshotDir), 'invalid recovery directory is preserved');
      assert.ok(fs.existsSync(path.join(path.dirname(fixture.snapshotDir), fixture.older.snapshotId)), 'healthy older recovery point survives');
    });
  }

  it('rechecks a source lost after preflight and preserves every live destination', (t) => {
    const fixture = makeRecoveryFixture(t);
    writeJson(path.join(fixture.liveDir, 'fill-ledger.json'), { fills: ['live'] });
    writeJson(path.join(fixture.liveDir, 'closed-trades.json'), ['live-sidecar']);
    const before = fs.readdirSync(fixture.liveDir).map((name) => [name, fs.readFileSync(path.join(fixture.liveDir, name))]);
    assert.deepEqual(checkFundStateRestorePreconditions(fixture.newer.snapshotId, 'coinbase', 'BTC-USDC', { paths: fixture.paths }), { ok: true });
    fs.unlinkSync(fixture.ledger);
    const result = restoreFundStateBackup(fixture.newer.snapshotId, 'coinbase', 'BTC-USDC', { paths: fixture.paths });
    assert.equal(result.success, false);
    assert.match(result.error, /incomplete.*fill-ledger.json/);
    assert.deepEqual(fs.readdirSync(fixture.liveDir).map((name) => [name, fs.readFileSync(path.join(fixture.liveDir, name))]), before);
    assert.equal(fs.readdirSync(fixture.paths.dataDir).some((name) => name.startsWith('.restore-')), false);
  });

  it('refuses a file lost during staging before any live replacement or removal', (t) => {
    const fixture = makeRecoveryFixture(t);
    writeJson(path.join(fixture.liveDir, 'closed-trades.json'), ['live-sidecar']);
    const before = fs.readdirSync(fixture.liveDir).map((name) => [name, fs.readFileSync(path.join(fixture.liveDir, name))]);
    const copy = fs.copyFileSync;
    let copied = 0;
    t.mock.method(fs, 'copyFileSync', (source, target) => {
      if (++copied === 2) fs.unlinkSync(source);
      return copy(source, target);
    });
    const result = restoreFundStateBackup(fixture.newer.snapshotId, 'coinbase', 'BTC-USDC', { paths: fixture.paths });
    assert.equal(result.success, false);
    assert.match(result.error, /staging failed/);
    assert.equal(copied, 2, 'failure happens after a state file was staged');
    assert.deepEqual(fs.readdirSync(fixture.liveDir).map((name) => [name, fs.readFileSync(path.join(fixture.liveDir, name))]), before);
    assert.equal(fs.readdirSync(fixture.paths.dataDir).some((name) => name.startsWith('.restore-')), false);
  });

  it('validates the staged restore before planning absent-sidecar changes', (t) => {
    const fixture = makeRecoveryFixture(t);
    writeJson(path.join(fixture.liveDir, 'closed-trades.json'), ['live-sidecar']);
    const before = fs.readdirSync(fixture.liveDir).map((name) => [name, fs.readFileSync(path.join(fixture.liveDir, name))]);
    const copy = fs.copyFileSync;
    t.mock.method(fs, 'copyFileSync', (source, target) => {
      if (path.basename(source) !== 'fill-ledger.json') copy(source, target);
    });
    const result = restoreFundStateBackup(fixture.newer.snapshotId, 'coinbase', 'BTC-USDC', { paths: fixture.paths });
    assert.equal(result.success, false);
    assert.match(result.error, /staging failed.*incomplete/);
    assert.deepEqual(fs.readdirSync(fixture.liveDir).map((name) => [name, fs.readFileSync(path.join(fixture.liveDir, name))]), before);
  });
});

// #1809 — a pending DCA import journal makes a fund's accounting a possibly
// mixed generation, and its recovery pass would roll the import forward over a
// restored one. Snapshots and restores of that fund refuse, leaving every byte.
describe('pending DCA imports block fund-state snapshots and restores (#1809)', () => {
  const { JOURNAL_FILENAME } = require('../src/dca-conversion-transaction');

  const makeFixture = (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-dca-pending-snapshot-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const paths = { dataDir: path.join(root, 'data'), baseConfigFile: path.join(root, 'config.json') };
    writeJson(paths.baseConfigFile, { exchanges: { coinbase: { pairs: { 'BTC-USDC': {}, 'ETH-USDC': {} } } } });
    const live = (pair) => path.join(paths.dataDir, 'coinbase', pair);
    for (const pair of ['BTC-USDC', 'ETH-USDC']) {
      writeJson(path.join(live(pair), 'fill-ledger.json'), [{ id: `${pair}-saved` }]);
      writeJson(path.join(live(pair), 'regime-state.json'), { position: { totalAsset: 0 } });
      writeJson(path.join(live(pair), 'state.json'), { orders: [{ status: 'pending' }] });
    }
    const older = createFundStateBackup({ paths, now: new Date('2026-10-01'), maxBackups: 1 });
    assert.equal(older.success, true, older.error);
    /** Every file under the data directory, by relative path. */
    const tree = () => {
      const out = {};
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else out[path.relative(paths.dataDir, full)] = fs.readFileSync(full, 'utf8');
        }
      };
      walk(paths.dataDir);
      return out;
    };
    const pendImport = (pair) => {
      // A publishing journal over a regime position that already moved.
      writeJson(path.join(live(pair), 'regime-state.json'), { position: { totalAsset: 1 } });
      writeJson(path.join(live(pair), JOURNAL_FILENAME), { version: 1, status: 'publishing', entries: [] });
    };
    return { paths, live, older, tree, pendImport };
  };

  it('refuses a snapshot without publishing or pruning a recovery point', (t) => {
    const { paths, older, tree, pendImport } = makeFixture(t);
    pendImport('ETH-USDC');
    const before = tree();
    const result = createFundStateBackup({ paths, now: new Date('2026-10-02'), maxBackups: 1 });
    assert.equal(result.success, false);
    assert.equal(result.code, 'dca-import-pending');
    assert.match(result.error, /coinbase\/ETH-USDC has an interrupted DCA import/);
    assert.match(result.error, /No fund-state snapshot was published or pruned/);
    assert.deepEqual(tree(), before, 'no snapshot, stage directory or pruning');
    assert.deepEqual(listFundStateBackups({ paths }).map((s) => s.snapshotId), [older.snapshotId]);
  });

  it('refuses an import that starts while files are being copied', (t) => {
    const { paths, older, live } = makeFixture(t);
    const copy = fs.copyFileSync;
    t.mock.method(fs, 'copyFileSync', (source, target) => {
      copy(source, target);
      if (source === path.join(live('BTC-USDC'), 'fill-ledger.json')) {
        writeJson(path.join(live('BTC-USDC'), JOURNAL_FILENAME), { version: 1, status: 'staging', entries: [] });
      }
    });
    const result = createFundStateBackup({ paths, now: new Date('2026-10-02'), maxBackups: 1 });
    assert.equal(result.code, 'dca-import-pending');
    assert.deepEqual(listFundStateBackups({ paths }).map((s) => s.snapshotId), [older.snapshotId]);
    assert.equal(fs.readdirSync(path.join(paths.dataDir, 'backups')).some((n) => n.startsWith('.fund-state-stage-')), false);
  });

  it('refuses the affected fund\'s restore in preflight and apply, byte-identically', (t) => {
    const { paths, older, tree, pendImport } = makeFixture(t);
    pendImport('BTC-USDC');
    const before = tree();
    const preflight = checkFundStateRestorePreconditions(older.snapshotId, 'coinbase', 'BTC-USDC', { paths });
    assert.equal(preflight.ok, false);
    assert.equal(preflight.code, 'dca-import-pending');
    const restored = restoreFundStateBackup(older.snapshotId, 'coinbase', 'BTC-USDC', { paths });
    assert.equal(restored.success, false);
    assert.equal(restored.code, 'dca-import-pending');
    assert.equal(restored.error, preflight.error, 'same refusal as the preflight');
    assert.deepEqual(tree(), before, 'journal, ledger, regime and DCA state untouched');
  });

  it('does not let an unrelated fund\'s pending import block a restore elsewhere', (t) => {
    const { paths, older, live, pendImport } = makeFixture(t);
    pendImport('ETH-USDC');
    const journal = fs.readFileSync(path.join(live('ETH-USDC'), JOURNAL_FILENAME), 'utf8');
    writeJson(path.join(live('BTC-USDC'), 'fill-ledger.json'), [{ id: 'newer' }]);
    assert.deepEqual(checkFundStateRestorePreconditions(older.snapshotId, 'coinbase', 'BTC-USDC', { paths }), { ok: true });
    const restored = restoreFundStateBackup(older.snapshotId, 'coinbase', 'BTC-USDC', { paths });
    assert.equal(restored.success, true, JSON.stringify(restored));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(live('BTC-USDC'), 'fill-ledger.json'), 'utf8')), [{ id: 'BTC-USDC-saved' }]);
    assert.equal(fs.readFileSync(path.join(live('ETH-USDC'), JOURNAL_FILENAME), 'utf8'), journal);
  });
});
