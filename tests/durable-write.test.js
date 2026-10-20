const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { atomicWriteSync, fsyncFile } = require('../src/durable-write');

const fixture = (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'durable-write-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const unsupportedDirectorySync = (t, code) => {
  const sync = fs.fsyncSync;
  t.mock.method(fs, 'fsyncSync', (fd) => {
    if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('unsupported directory flush'), { code });
    return sync(fd);
  });
};

test('config save flushes bytes before publication and directory afterward, preserving mode', (t) => {
  const file = path.join(fixture(t), 'config.json');
  fs.writeFileSync(file, '{}', { mode: 0o640 });
  const operations = [];
  const sync = fs.fsyncSync;
  const rename = fs.renameSync;
  t.mock.method(fs, 'fsyncSync', (fd) => {
    operations.push(fs.fstatSync(fd).isDirectory() ? 'directory-fsync' : 'file-fsync');
    return sync(fd);
  });
  t.mock.method(fs, 'renameSync', (...args) => { operations.push('rename'); return rename(...args); });
  require('../src/config-utils').writeUserConfigFile({ saved: true }, file);
  assert.deepEqual(operations, ['file-fsync', 'rename', 'directory-fsync']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { saved: true });
});

test('state-tracker re-exports the leaf writer and new files default to owner-only permissions', (t) => {
  assert.equal(require('../src/state-tracker').atomicWriteSync, atomicWriteSync);
  const file = path.join(fixture(t), 'new');
  atomicWriteSync(file, Buffer.from('bytes'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fsyncFile(file);
  assert.equal(fs.readFileSync(file, 'utf8'), 'bytes');
});

test('preserveMode retains zero permissions and permissions masked by the current umask', (t) => {
  const file = path.join(fixture(t), 'restricted');
  fs.writeFileSync(file, 'old');
  const umask = process.umask(0o077);
  try { atomicWriteSync(path.join(path.dirname(file), 'new'), 'new', { preserveMode: true, mode: 0o640 }); }
  finally { process.umask(umask); }
  assert.equal(fs.statSync(path.join(path.dirname(file), 'new')).mode & 0o777, 0o640);
  for (const mode of [0, 0o640]) {
    fs.chmodSync(file, mode);
    const umask = process.umask(0o077);
    try { atomicWriteSync(file, 'new', { preserveMode: true }); }
    finally { process.umask(umask); }
    assert.equal(fs.statSync(file).mode & 0o777, mode);
  }
});

test('exclusive publication refuses an existing file and removes only its temporary inode', (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'journal');
  atomicWriteSync(file, 'first', { exclusive: true });
  assert.throws(() => atomicWriteSync(file, 'second', { exclusive: true }), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'first');
  assert.deepEqual(fs.readdirSync(dir), ['journal']);
});

for (const operation of ['writeFileSync', 'fsyncSync', 'renameSync', 'linkSync']) {
  test(`${operation} failure preserves previous bytes and removes the temporary file`, (t) => {
    const dir = fixture(t);
    const file = path.join(dir, 'target');
    fs.writeFileSync(file, 'old');
    const failure = Object.assign(new Error(`injected ${operation}`), { code: 'EIO' });
    t.mock.method(fs, operation, () => { throw failure; });
    assert.throws(() => atomicWriteSync(file, 'new', { exclusive: operation === 'linkSync' }), failure);
    assert.equal(fs.readFileSync(file, 'utf8'), 'old');
    assert.deepEqual(fs.readdirSync(dir), ['target']);
  });
}

test('real directory flush failures propagate after publication without leaking temporary files', (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'target');
  unsupportedDirectorySync(t, 'EIO');
  assert.throws(() => atomicWriteSync(file, 'published'), { code: 'EIO' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'published');
  assert.deepEqual(fs.readdirSync(dir), ['target']);
});

for (const code of ['EINVAL', 'EPERM']) {
  test(`DCA import commits its targets and removes its journal with directory fsync ${code}`, (t) => {
    const dir = fixture(t);
    const migration = require('../src/migration');
    const txn = require('../src/dca-conversion-transaction');
    unsupportedDirectorySync(t, code);
    t.mock.method(migration, 'getExchangeDataDir', () => dir);
    const fundDir = path.join(dir, 'AAA-USD');
    fs.mkdirSync(fundDir);
    {
      const result = txn.runDcaImportTransaction({
        exchange: 'synthetic', pair: 'AAA-USD', kind: 'convert', sourceOrders: [],
        stage: () => {
          const stageDir = migration.resolveFundDataDir('synthetic', 'AAA-USD');
          fs.writeFileSync(path.join(stageDir, 'fill-ledger.json'), '[]');
          fs.writeFileSync(path.join(stageDir, 'state.json'), '{"orders":[]}');
          fs.writeFileSync(path.join(stageDir, 'regime-state.json'), '{"position":{"celestialBodies":[]}}');
          return 'imported';
        },
      });
      assert.equal(result, 'imported');
    }
    assert.equal(fs.existsSync(path.join(fundDir, txn.JOURNAL_FILENAME)), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fundDir, 'state.json'))), { orders: [] });
  });

  test(`FIFO backfill retains injected writes and completes with directory fsync ${code}`, (t) => {
    const dir = fixture(t);
    const fund = path.join(dir, 'synthetic', 'AAA-USD');
    fs.mkdirSync(fund, { recursive: true });
    const file = path.join(fund, 'regime-state.json');
    const before = JSON.stringify({ position: { realizedPnL: 0, realizedAssetPnL: 0 } });
    const after = JSON.stringify({ position: { realizedPnL: 5, realizedAssetPnL: 1 } });
    fs.writeFileSync(file, before);
    const writes = [];
    unsupportedDirectorySync(t, code);
    const { runBackfill, JOURNAL_FILENAME } = require('../src/fifo-backfill-transaction');
    assert.deepEqual(runBackfill({ dataDir: dir, stage: () => [{ file, before, after }],
      write: (target, bytes) => { writes.push(target); atomicWriteSync(target, bytes); },
    }), { status: 'committed', count: 1 });
    assert.ok(writes.includes(file));
    assert.equal(fs.readFileSync(file, 'utf8'), after);
    assert.equal(fs.existsSync(path.join(dir, JOURNAL_FILENAME)), false);
  });

  test(`scorecard validates before publication and tolerates directory fsync ${code}`, (t) => {
    const dir = fixture(t);
    const file = path.join(dir, 'scorecard.jsonl');
    const { atomicPublish, validateJsonl } = require('../src/updown/scorecard-maintenance');
    fs.writeFileSync(file, 'old');
    assert.throws(() => atomicPublish(file, 'invalid', validateJsonl));
    assert.equal(fs.readFileSync(file, 'utf8'), 'old');
    unsupportedDirectorySync(t, code);
    atomicPublish(file, '{"type":"test"}\n', validateJsonl);
    assert.equal(fs.readFileSync(file, 'utf8'), '{"type":"test"}\n');
    assert.deepEqual(fs.readdirSync(dir), ['scorecard.jsonl']);
  });
}

test('restore preserves staged permissions for a new destination under a stricter umask', (t) => {
  const root = fixture(t);
  const dataDir = path.join(root, 'data');
  const stageDir = path.join(root, 'stage');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(stageDir);
  const source = path.join(stageDir, 'new.json');
  fs.writeFileSync(source, '{"restored":true}');
  fs.chmodSync(source, 0o640);
  const { applyStagedFiles } = require('../src/restore-apply');
  const mask = process.umask(0o077);
  try {
    // Characterize copyFileSync's original permission behavior independently.
    const copied = path.join(root, 'copy');
    fs.copyFileSync(source, copied);
    assert.equal(fs.statSync(copied).mode & 0o777, 0o640);
    assert.equal(applyStagedFiles({ dataDir, stageDir }).success, true);
  } finally {
    process.umask(mask);
  }
  assert.equal(fs.statSync(path.join(dataDir, 'new.json')).mode & 0o777, 0o640);
  assert.equal(fs.readFileSync(path.join(dataDir, 'new.json'), 'utf8'), '{"restored":true}');
});
