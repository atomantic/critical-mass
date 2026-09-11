// @ts-check
/**
 * Issue #431 — applying a backup archive must be an all-or-nothing, restartable
 * transaction.
 *
 * Before this, `restoreBackup` copied each staged file straight over its live
 * destination. A failure part-way through left earlier files on the archive's
 * generation and later files on the current one, with no rollback copy and no
 * marker telling the next start that the data directory was a mixed generation.
 *
 * Covers:
 *  - src/restore-apply.js: whole-set validation, atomic (temp+rename) replacement,
 *    rollback on an injected mid-apply failure, incomplete-recovery status when
 *    the rollback itself fails, and restart recovery from the retained journal.
 *  - src/backup-service.js: an end-to-end create → corrupt → restore where the
 *    application fails leaves state/config/ledger coherent at their pre-restore
 *    generation.
 *
 * Everything runs inside temp directories; nothing here touches the live install.
 */
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  applyStagedFiles,
  recoverIncompleteRestore,
  guardIncompleteRestore,
  JOURNAL_FILENAME,
  STATUS,
} = require('../src/restore-apply');
const { createBackup, restoreBackup } = require('../src/backup-service');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** The real implementation, captured before any test swaps it out. */
const realRenameSync = fs.renameSync;

/** @type {Array<string>} */
const roots = [];

let root;
/** @type {string} */
let dataDir;
/** @type {string} */
let stageDir;

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

/** Relative paths of the restore's leftover bookkeeping, if any. */
const artifactNames = () => fs.readdirSync(dataDir).filter((n) => n.startsWith('.restore-'));

/**
 * Fail `fs.renameSync` for chosen destinations, counting per destination so a
 * test can let the apply through and break the ROLLBACK of the same file.
 * @param {Record<string, number[]>} failures - Absolute dest path -> 1-based call ordinals to fail
 * @returns {void}
 */
const breakRenameFor = (failures) => {
  const seen = new Map();
  mock.method(fs, 'renameSync', (from, to) => {
    const ordinals = failures[String(to)];
    if (ordinals) {
      const nth = (seen.get(String(to)) || 0) + 1;
      seen.set(String(to), nth);
      if (ordinals.includes(nth)) throw new Error(`ENOSPC: injected failure renaming to ${path.basename(String(to))}`);
    }
    return realRenameSync(from, to);
  });
};

/** A staged set of three files: two replacing live files, one brand new. */
const seedFixture = () => {
  write(path.join(dataDir, 'alpha.json'), '{"gen":"current-alpha"}');
  write(path.join(dataDir, 'beta.json'), '{"gen":"current-beta"}');
  write(path.join(stageDir, 'alpha.json'), '{"gen":"archive-alpha"}');
  write(path.join(stageDir, 'beta.json'), '{"gen":"archive-beta"}');
  write(path.join(stageDir, 'sub', 'gamma.json'), '{"gen":"archive-gamma"}');
};

const preRestoreState = () => ({
  alpha: read(path.join(dataDir, 'alpha.json')),
  beta: read(path.join(dataDir, 'beta.json')),
  gamma: read(path.join(dataDir, 'sub', 'gamma.json')),
});

describe('restore-apply — transactional application (#431)', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-restore-apply-'));
    roots.push(root);
    dataDir = path.join(root, 'data');
    stageDir = path.join(dataDir, '.restore-temp-fixture');
    fs.mkdirSync(stageDir, { recursive: true });
    seedFixture();
  });

  afterEach(() => {
    mock.restoreAll();
    for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('applies the whole set, commits once and leaves no journal or originals behind', () => {
    const result = applyStagedFiles({ dataDir, stageDir, filename: 'backup-ok.zip', logger: silentLogger });

    assert.equal(result.success, true);
    assert.equal(result.filesRestored, 3);
    assert.deepEqual(preRestoreState(), {
      alpha: '{"gen":"archive-alpha"}',
      beta: '{"gen":"archive-beta"}',
      gamma: '{"gen":"archive-gamma"}',
    });
    assert.deepEqual(artifactNames(), [], 'staging, originals and journal are all cleaned on commit');
  });

  it('never overwrites a destination in place: every replacement is a same-directory temp + rename', () => {
    const renames = [];
    mock.method(fs, 'renameSync', (from, to) => {
      renames.push({ from: String(from), to: String(to) });
      return realRenameSync(from, to);
    });

    applyStagedFiles({ dataDir, stageDir, filename: 'backup-ok.zip', logger: silentLogger });

    for (const dest of [path.join(dataDir, 'alpha.json'), path.join(dataDir, 'beta.json'), path.join(dataDir, 'sub', 'gamma.json')]) {
      const call = renames.find((r) => r.to === dest);
      assert.ok(call, `${path.basename(dest)} must be published by a rename, not written in place`);
      assert.equal(path.dirname(call.from), path.dirname(dest), 'the temp file must sit on the destination filesystem');
      assert.ok(!fs.existsSync(call.from), 'the temp file must not survive the rename');
    }
  });

  it('rolls every destination back to its pre-restore bytes when a replacement fails', () => {
    const before = preRestoreState();
    breakRenameFor({ [path.join(dataDir, 'beta.json')]: [1] });

    const result = applyStagedFiles({ dataDir, stageDir, filename: 'backup-bad.zip', logger: silentLogger });

    assert.equal(result.success, false);
    assert.equal(result.code, 'restore-apply-failed');
    assert.equal(result.rolledBack, true);
    assert.match(result.error, /rolled back/i);
    assert.deepEqual(preRestoreState(), before, 'alpha must be reverted, beta untouched, gamma never created');
    assert.equal(fs.existsSync(path.join(dataDir, 'sub', 'gamma.json')), false, 'a file created solely by the attempt is removed');
    assert.deepEqual(artifactNames(), [], 'a clean rollback cleans its own journal and originals');
  });

  it('removes the directories it created for the attempt when it rolls back', () => {
    breakRenameFor({ [path.join(dataDir, 'beta.json')]: [1] });
    applyStagedFiles({ dataDir, stageDir, filename: 'backup-bad.zip', logger: silentLogger });
    assert.equal(fs.existsSync(path.join(dataDir, 'sub')), false);
  });

  it('refuses the whole archive before any write when a staged entry is not a regular file', () => {
    const before = preRestoreState();
    fs.symlinkSync(path.join(root, 'outside.json'), path.join(stageDir, 'evil.json'));

    const result = applyStagedFiles({ dataDir, stageDir, filename: 'backup-evil.zip', logger: silentLogger });

    assert.equal(result.success, false);
    assert.equal(result.code, 'staged-set-invalid');
    assert.equal(result.rolledBack, true);
    assert.deepEqual(preRestoreState(), before, 'validation happens before the first destination write');
    assert.deepEqual(artifactNames().filter((n) => n !== '.restore-temp-fixture'), []);
  });

  it('honours the caller\'s skip rules (keys, backups dir, archive metadata)', () => {
    write(path.join(stageDir, 'coinbase-keys.json'), '{"key":"from-archive"}');
    write(path.join(dataDir, 'coinbase-keys.json'), '{"key":"live"}');
    write(path.join(stageDir, 'backups', 'backup-old.zip'), 'zip');

    const result = applyStagedFiles({
      dataDir,
      stageDir,
      logger: silentLogger,
      skip: (name) => name === 'backups' || name.endsWith('-keys.json'),
    });

    assert.equal(result.success, true);
    assert.equal(result.filesRestored, 3);
    assert.equal(read(path.join(dataDir, 'coinbase-keys.json')), '{"key":"live"}');
  });

  it('reports incomplete recovery and RETAINS the journal and originals when the rollback fails', () => {
    const alpha = path.join(dataDir, 'alpha.json');
    // Let the apply of alpha land, then break its rollback: the data directory
    // is genuinely left as a mix of archive-era and current-era files.
    breakRenameFor({ [alpha]: [2], [path.join(dataDir, 'beta.json')]: [1] });

    const result = applyStagedFiles({ dataDir, stageDir, filename: 'backup-torn.zip', logger: silentLogger });

    assert.equal(result.success, false);
    assert.equal(result.code, 'restore-incomplete-recovery');
    assert.equal(result.rolledBack, false);
    assert.ok(result.recovery?.originalsDir, 'the retry artifacts must be named in the result');
    assert.equal(read(alpha), '{"gen":"archive-alpha"}', 'mixed generation: alpha applied');
    assert.equal(read(path.join(dataDir, 'beta.json')), '{"gen":"current-beta"}', 'mixed generation: beta not applied');

    const journal = JSON.parse(read(path.join(dataDir, JOURNAL_FILENAME)));
    assert.equal(journal.status, STATUS.INCOMPLETE);
    assert.equal(fs.existsSync(path.join(dataDir, journal.originalsDir, 'alpha.json')), true, 'originals are kept for the retry');
  });

  it('finishes the rollback on the next start, so nothing loads a mixed generation', () => {
    const alpha = path.join(dataDir, 'alpha.json');
    breakRenameFor({ [alpha]: [2], [path.join(dataDir, 'beta.json')]: [1] });
    applyStagedFiles({ dataDir, stageDir, filename: 'backup-torn.zip', logger: silentLogger });
    mock.restoreAll(); // the "crash"; the next process starts with working I/O

    const recovery = recoverIncompleteRestore({ dataDir, logger: silentLogger });

    assert.deepEqual(recovery, { pending: true, recovered: true, blocked: false });
    assert.deepEqual(preRestoreState(), {
      alpha: '{"gen":"current-alpha"}',
      beta: '{"gen":"current-beta"}',
      gamma: null,
    });
    assert.deepEqual(artifactNames(), [], 'recovery cleans the journal, the originals and the staging dir');
  });

  it('is a no-op for a data directory with no journal', () => {
    assert.deepEqual(recoverIncompleteRestore({ dataDir, logger: silentLogger }), { pending: false, recovered: false, blocked: false });
    assert.deepEqual(preRestoreState().alpha, '{"gen":"current-alpha"}');
  });

  it('cleans up without rolling back when the crash happened after the commit point', () => {
    applyStagedFiles({ dataDir, stageDir, filename: 'backup-ok.zip', logger: silentLogger });
    // Re-create the artifacts a crash between "committed" and "cleaned" leaves.
    const originals = path.join(dataDir, '.restore-originals-committed');
    write(path.join(originals, 'alpha.json'), '{"gen":"current-alpha"}');
    write(path.join(dataDir, JOURNAL_FILENAME), JSON.stringify({
      journalVersion: 1,
      restoreId: 'committed',
      filename: 'backup-ok.zip',
      status: STATUS.COMMITTED,
      originalsDir: '.restore-originals-committed',
      entries: [{ dest: 'alpha.json', existed: true }],
      createdDirs: [],
    }));

    const recovery = recoverIncompleteRestore({ dataDir, logger: silentLogger });

    assert.deepEqual(recovery, { pending: true, recovered: true, blocked: false });
    assert.equal(read(path.join(dataDir, 'alpha.json')), '{"gen":"archive-alpha"}', 'a committed restore is never undone');
    assert.deepEqual(artifactNames(), []);
  });

  it('blocks startup when an interrupted restore cannot be rolled back', () => {
    write(path.join(dataDir, JOURNAL_FILENAME), JSON.stringify({
      journalVersion: 1,
      restoreId: 'torn',
      filename: 'backup-torn.zip',
      status: STATUS.APPLYING,
      originalsDir: '.restore-originals-torn',
      entries: [{ dest: 'alpha.json', existed: true }],
      createdDirs: [],
    }));

    const exits = [];
    const result = guardIncompleteRestore({ processLabel: 'gateway', logger: silentLogger, dataDir, exit: (code) => exits.push(code) });

    assert.deepEqual(exits, [1], 'the process must not go on to load persisted state');
    assert.equal(result.blocked, true);
    assert.match(result.error, /could not revert/i);
    assert.ok(fs.existsSync(path.join(dataDir, JOURNAL_FILENAME)), 'the marker survives so the next start retries');
  });

  it('blocks startup on an unreadable journal rather than guessing', () => {
    write(path.join(dataDir, JOURNAL_FILENAME), 'not json at all');
    const exits = [];
    const result = guardIncompleteRestore({ processLabel: 'coinbase engine', logger: silentLogger, dataDir, exit: (code) => exits.push(code) });
    assert.deepEqual(exits, [1]);
    assert.equal(result.blocked, true);
  });

  it('lets a clean start through untouched', () => {
    const exits = [];
    const result = guardIncompleteRestore({ processLabel: 'gateway', logger: silentLogger, dataDir, exit: (code) => exits.push(code) });
    assert.deepEqual(exits, []);
    assert.equal(result.pending, false);
  });
});

describe('backup-service — restore failure leaves the install coherent (#431)', () => {
  /** @type {{dataDir: string, baseConfigFile: string}} */
  let install;
  /** @type {string} */
  let filename;

  const stateFile = () => path.join(install.dataDir, 'coinbase', 'BTC-USDC', 'regime-state.json');
  const ledgerFile = () => path.join(install.dataDir, 'coinbase', 'BTC-USDC', 'fill-ledger.json');

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-restore-e2e-'));
    roots.push(root);
    install = { dataDir: path.join(root, 'data'), baseConfigFile: path.join(root, 'config.json') };
    fs.mkdirSync(install.dataDir, { recursive: true });
    write(install.baseConfigFile, JSON.stringify({
      exchanges: { coinbase: { pairs: { 'BTC-USDC': { productId: 'BTC-USDC', totalAllocation: 1000, enabled: true, dryRun: false } } } },
      global: { schedulerInterval: 30000 },
    }));
    write(path.join(install.dataDir, 'config.json'), '{}');
    write(stateFile(), JSON.stringify({ generation: 'archive', realizedPnL: 11 }));
    write(ledgerFile(), JSON.stringify({ generation: 'archive', fills: [1, 2] }));

    const created = createBackup({ paths: install });
    assert.equal(created.success, true, created.error);
    filename = created.filename;

    // The install moves on: both files are now a generation newer than the archive.
    write(stateFile(), JSON.stringify({ generation: 'current', realizedPnL: 42 }));
    write(ledgerFile(), JSON.stringify({ generation: 'current', fills: [1, 2, 3] }));
  });

  afterEach(() => {
    mock.restoreAll();
    for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('restores every file on the happy path', () => {
    const result = restoreBackup(filename, { paths: install });
    assert.equal(result.success, true, result.error);
    assert.equal(JSON.parse(read(stateFile())).generation, 'archive');
    assert.equal(JSON.parse(read(ledgerFile())).generation, 'archive');
    assert.deepEqual(fs.readdirSync(install.dataDir).filter((n) => n.startsWith('.restore-')), []);
  });

  it('leaves state, ledger and config on ONE generation when the application fails', () => {
    breakRenameFor({ [ledgerFile()]: [1] });

    const result = restoreBackup(filename, { paths: install });

    assert.equal(result.success, false);
    assert.equal(result.code, 'restore-apply-failed');
    assert.equal(result.rolledBack, true);
    assert.equal(JSON.parse(read(stateFile())).generation, 'current', 'state must not be left on the archive generation');
    assert.equal(JSON.parse(read(ledgerFile())).generation, 'current');
    assert.equal(JSON.parse(read(stateFile())).realizedPnL, 42);
    assert.deepEqual(fs.readdirSync(install.dataDir).filter((n) => n.startsWith('.restore-')), [], 'no artifacts leak after a clean rollback');
  });

  it('never archives its own restore bookkeeping', () => {
    write(path.join(install.dataDir, JOURNAL_FILENAME), '{"journalVersion":1,"entries":[]}');
    write(path.join(install.dataDir, '.restore-originals-stale', 'alpha.json'), '{}');
    const created = createBackup({ paths: install });
    assert.equal(created.success, true, created.error);

    const { spawnSync } = require('child_process');
    const entries = spawnSync('unzip', ['-Z1', path.join(install.dataDir, 'backups', created.filename)])
      .stdout.toString().split('\n').filter(Boolean);

    assert.equal(entries.some((e) => e.includes('.restore-')), false, `restore bookkeeping leaked into the archive: ${entries.join(', ')}`);
  });
});
