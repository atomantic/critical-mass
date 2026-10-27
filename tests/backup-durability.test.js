// @ts-check
// A backup may authorize deletion of older recovery points only after its bytes
// and directory entries are durable. Faults at either side of rename must fail
// closed, preserve prior backups, and hide the failed replacement from listing.
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBackup, createFundStateBackup, listFundStateBackups, restoreBackup } = require('../src/backup-service');
const { ledgerOf, fixturePayload } = require('./helpers/ledger-fixture');

let root, paths, backupsDir, fundBackupsDir;
const stateFiles = ['fill-ledger.json', 'regime-state.json', 'closed-trades.json', 'state.json', 'dry-run-state.json'];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-backup-durability-'));
  paths = { dataDir: path.join(root, 'data'), baseConfigFile: path.join(root, 'config.json') };
  backupsDir = path.join(paths.dataDir, 'backups');
  fundBackupsDir = path.join(backupsDir, 'fund-state');
  fs.writeFileSync(paths.baseConfigFile, JSON.stringify({ exchanges: { coinbase: { pairs: { 'BTC-USDC': { productId: 'BTC-USDC' } } } } }));
  const fundDir = path.join(paths.dataDir, 'coinbase', 'BTC-USDC');
  fs.mkdirSync(fundDir, { recursive: true });
  for (const file of stateFiles) fs.writeFileSync(path.join(fundDir, file), JSON.stringify(fixturePayload(file, { marker: file })));
});

afterEach(() => {
  mock.restoreAll();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Observe actual fsync/rename calls while still performing the real I/O. */
const observePublication = (fail = () => false) => {
  const descriptors = new Map();
  const events = [];
  const open = fs.openSync, close = fs.closeSync, sync = fs.fsyncSync, rename = fs.renameSync;
  mock.method(fs, 'openSync', function (file, ...args) {
    const fd = open.call(fs, file, ...args);
    descriptors.set(fd, String(file));
    return fd;
  });
  mock.method(fs, 'closeSync', (fd) => { descriptors.delete(fd); return close(fd); });
  mock.method(fs, 'fsyncSync', (fd) => {
    const file = descriptors.get(fd);
    events.push({ kind: 'sync', file });
    if (fail(file)) throw Object.assign(new Error('Synthetic backup flush failure'), { code: 'EIO' });
    return sync(fd);
  });
  mock.method(fs, 'renameSync', (from, to) => {
    events.push({ kind: 'rename', file: String(from), to: String(to) });
    return rename(from, to);
  });
  return events;
};

describe('durable full archive publication', () => {
  for (const point of ['archive bytes', 'backups directory', 'data directory']) {
    it(`does not publish success when flushing ${point} fails`, async () => {
      const previous = await createBackup({ paths });
      assert.equal(previous.success, true, previous.error);
      const original = fs.readFileSync(path.join(backupsDir, previous.filename));
      const matches = (file) => point === 'archive bytes' ? file.endsWith('.tmp.zip')
        : file === (point === 'backups directory' ? backupsDir : paths.dataDir);
      const events = observePublication(matches);
      const result = await createBackup({ paths });
      assert.equal(result.success, false, 'failure must prevent callers from pruning prior backups');
      assert.match(result.error, /Synthetic backup flush failure/);
      assert.ok(events.some(({ kind, file }) => kind === 'sync' && matches(file)));
      assert.deepEqual(fs.readdirSync(backupsDir), [previous.filename]);
      assert.deepEqual(fs.readFileSync(path.join(backupsDir, previous.filename)), original);
    });
  }

  it('flushes the validated archive before rename and its ancestors before returning success', async () => {
    const events = observePublication();
    const result = await createBackup({ paths });
    assert.equal(result.success, true, result.error);
    const publication = events.findIndex(({ kind, to }) => kind === 'rename' && to === path.join(backupsDir, result.filename));
    assert.ok(publication > 0);
    assert.ok(events.slice(0, publication).some(({ kind, file }) => kind === 'sync' && file.endsWith('.tmp.zip')));
    assert.deepEqual(events.slice(publication + 1), [
      { kind: 'sync', file: backupsDir }, { kind: 'sync', file: paths.dataDir },
    ]);
    mock.restoreAll();
    const restored = restoreBackup(result.filename, { paths });
    assert.equal(restored.success, true, restored.error);
  });
});

describe('durable fund-state snapshot publication before retention', () => {
  it('refuses an incomplete staged snapshot before publication or pruning (#1703)', () => {
    const previous = createFundStateBackup({ paths, now: new Date('2026-10-01'), maxBackups: 1 });
    assert.equal(previous.success, true, previous.error);
    const events = observePublication((file) => {
      if (path.basename(file) === 'fund-state-manifest.json') {
        fs.unlinkSync(path.join(path.dirname(file), 'coinbase', 'BTC-USDC', 'fill-ledger.json'));
      }
      return false;
    });
    const result = createFundStateBackup({ paths, now: new Date('2026-10-02'), maxBackups: 1 });
    assert.equal(result.success, false);
    assert.match(result.error, /incomplete.*fill-ledger.json/);
    assert.equal(events.some(({ kind }) => kind === 'rename'), false);
    assert.deepEqual(listFundStateBackups({ paths }).map(({ snapshotId }) => snapshotId), [previous.snapshotId]);
    assert.deepEqual(fs.readdirSync(backupsDir), ['fund-state']);
  });

  const points = [...stateFiles, 'fund-state-manifest.json', 'fund directory', 'exchange directory', 'staging directory', 'snapshot parent', 'backups directory', 'data directory'];
  for (const point of points) {
    it(`preserves the last recovery point when flushing ${point} fails`, async () => {
      const previous = createFundStateBackup({ paths, now: new Date('2026-10-01'), maxBackups: 1 });
      assert.equal(previous.success, true, previous.error);
      const matches = (file) => {
        if (point === 'snapshot parent') return file === fundBackupsDir;
        if (point === 'backups directory') return file === backupsDir;
        if (point === 'data directory') return file === paths.dataDir;
        if (!file.includes('.fund-state-stage-')) return false;
        if (point === 'fund directory') return file.endsWith(path.join('coinbase', 'BTC-USDC'));
        if (point === 'exchange directory') return path.basename(file) === 'coinbase';
        if (point === 'staging directory') return path.dirname(file) === backupsDir;
        return path.basename(file) === point;
      };
      const events = observePublication(matches);
      const result = createFundStateBackup({ paths, now: new Date('2026-10-02'), maxBackups: 1 });
      assert.equal(result.success, false, 'a failed replacement must not prune the prior snapshot');
      assert.match(result.error, /Synthetic backup flush failure/);
      assert.ok(events.some(({ kind, file }) => kind === 'sync' && matches(file)));
      assert.deepEqual(listFundStateBackups({ paths }).map((backup) => backup.snapshotId), [previous.snapshotId]);
      assert.deepEqual(fs.readdirSync(backupsDir), ['fund-state']);
      for (const file of stateFiles) {
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fundBackupsDir, previous.snapshotId, 'coinbase', 'BTC-USDC', file), 'utf8')), fixturePayload(file, { marker: file }));
      }
    });
  }

  it('flushes every copied file, manifest and nested directory before exposing the snapshot', async () => {
    const events = observePublication();
    const result = createFundStateBackup({ paths });
    assert.equal(result.success, true, result.error);
    const publication = events.findIndex(({ kind }) => kind === 'rename');
    assert.ok(publication > 0);
    const synced = events.slice(0, publication).filter(({ kind }) => kind === 'sync').map(({ file }) => file);
    assert.deepEqual(synced.slice(0, 6).map((file) => path.basename(file)), [...stateFiles, 'fund-state-manifest.json']);
    const stageDir = events[publication].file;
    assert.deepEqual(synced.slice(6), [path.join(stageDir, 'coinbase', 'BTC-USDC'), path.join(stageDir, 'coinbase'), stageDir]);
    assert.deepEqual(events.slice(publication + 1), [
      { kind: 'sync', file: fundBackupsDir }, { kind: 'sync', file: backupsDir }, { kind: 'sync', file: paths.dataDir },
    ]);
  });
});
