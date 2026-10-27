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
const { spawn } = require('child_process');

const {
  applyStagedFiles,
  recoverIncompleteRestore,
  guardIncompleteRestore,
  JOURNAL_FILENAME,
  JOURNAL_VERSION,
  OWNER_PREFIX,
  OWNER_DIR,
  STATUS,
} = require('../src/restore-apply');
const { createBackup, restoreBackup } = require('../src/backup-service');
const { ledgerOf } = require('./helpers/ledger-fixture');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** The real implementation, captured before any test swaps it out. */
const realRenameSync = fs.renameSync;

/** Trace durable storage boundaries while still performing real filesystem IO. */
const traceStorage = () => {
  const events = [];
  const descriptors = new Map();
  const open = fs.openSync;
  const close = fs.closeSync;
  const sync = fs.fsyncSync;
  const remove = fs.rmSync;
  mock.method(fs, 'openSync', (file, ...args) => {
    const fd = open(file, ...args);
    descriptors.set(fd, String(file));
    return fd;
  });
  mock.method(fs, 'closeSync', (fd) => {
    descriptors.delete(fd);
    return close(fd);
  });
  mock.method(fs, 'fsyncSync', (fd) => {
    events.push({ type: 'sync', file: descriptors.get(fd) });
    return sync(fd);
  });
  mock.method(fs, 'renameSync', (from, to) => {
    events.push({ type: 'rename', file: String(to), status: String(to).endsWith(JOURNAL_FILENAME) ? JSON.parse(read(from)).status : null });
    return realRenameSync(from, to);
  });
  mock.method(fs, 'rmSync', (file, ...args) => {
    events.push({ type: 'remove', file: String(file) });
    return remove(file, ...args);
  });
  return { events, descriptors };
};

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

/** Every path under a directory, so a leaked temp file anywhere is visible. */
const walkAll = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
  e.isDirectory() ? walkAll(path.join(dir, e.name)) : [path.join(dir, e.name)]
));

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

/** A real independent starter; file barriers work while its synchronous API waits. */
const startRestoreProcess = (t, options) => {
  const script = `
    const fs = require('fs');
    const path = require('path');
    const opts = JSON.parse(process.argv[1]);
    const send = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
    const sleep = new Int32Array(new SharedArrayBuffer(4));
    const pause = (name) => {
      fs.writeFileSync(path.join(opts.root, name + '.ready'), '');
      while (!fs.existsSync(path.join(opts.root, name + '.go'))) Atomics.wait(sleep, 0, 0, 10);
    };
    if (opts.pauseContender) {
      const readdir = fs.readdirSync;
      let paused = false;
      fs.readdirSync = (...args) => {
        const entries = readdir(...args);
        if (!paused && String(args[0]) === path.join(opts.dataDir, opts.ownerDir) && entries.length > 0) {
          paused = true;
          pause('contender');
        }
        return entries;
      };
    }
    const { applyStagedFiles, recoverIncompleteRestore } = require(opts.modulePath);
    const logger = {
      warn: () => { if (opts.pauseRecovery) pause('recovery'); },
      error: () => {},
      info: (message) => {
        if (opts.pauseApply && message.includes('Restore applying')) pause('apply');
        if (opts.runtimeWrite && message.includes('Incomplete restore rolled back')) {
          fs.writeFileSync(path.join(opts.dataDir, 'created.json'), 'new runtime generation');
        }
      },
    };
    const result = opts.apply
      ? applyStagedFiles({ dataDir: opts.dataDir, stageDir: opts.stageDir, logger, ownershipWaitMs: opts.waitMs })
      : recoverIncompleteRestore({ dataDir: opts.dataDir, logger, ownershipWaitMs: opts.waitMs });
    send(result);
  `;
  const child = spawn(process.execPath, ['-e', script, JSON.stringify({
    root, dataDir, stageDir, ownerDir: OWNER_DIR, modulePath: require.resolve('../src/restore-apply'), ...options,
  })], { env: { ...process.env, CRITICAL_MASS_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, out, err }));
  });
  t.after(async () => { if (child.exitCode === null) child.kill('SIGKILL'); await done; });
  return { child, done, result: async () => {
    const ended = await done;
    assert.equal(ended.code, 0, ended.err);
    return JSON.parse(ended.out);
  } };
};

const waitForBarrier = async (name) => {
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(path.join(root, `${name}.ready`))) {
    assert.ok(Date.now() < deadline, `child did not reach ${name} barrier`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const releaseBarrier = (name) => write(path.join(root, `${name}.go`), '');

const seedInterruptedJournal = () => {
  write(path.join(dataDir, '.restore-originals-crashed', 'alpha.json'), 'original generation');
  write(path.join(dataDir, 'alpha.json'), 'interrupted generation');
  write(path.join(dataDir, 'created.json'), 'interrupted creation');
  write(path.join(dataDir, JOURNAL_FILENAME), JSON.stringify({
    journalVersion: JOURNAL_VERSION, restoreId: 'crashed', status: STATUS.APPLYING,
    filename: 'crashed.zip', originalsDir: '.restore-originals-crashed',
    entries: [{ dest: 'alpha.json', existed: true }, { dest: 'created.json', existed: false }],
  }));
};

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

  it('journals removals and resets with replacements, rolling bytes and modes back after a removal (#1702)', () => {
    const removed = path.join(dataDir, 'later.json');
    const reset = path.join(dataDir, 'dry-run-state.json');
    write(removed, 'later trade');
    write(reset, 'later simulation');
    fs.chmodSync(removed, 0o640);
    fs.chmodSync(reset, 0o604);
    const before = preRestoreState();
    const remove = fs.rmSync;
    let sawRemoval = false;
    mock.method(fs, 'rmSync', (file, ...args) => {
      const result = remove(file, ...args);
      if (String(file) === removed) sawRemoval = true;
      return result;
    });
    const rename = fs.renameSync;
    mock.method(fs, 'renameSync', (from, to) => {
      if (String(to) === reset && sawRemoval) {
        sawRemoval = false; // rollback must be able to write this destination
        assert.equal(fs.existsSync(removed), false, 'failure is after the real removal');
        const journal = JSON.parse(read(path.join(dataDir, JOURNAL_FILENAME)));
        assert.equal(journal.journalVersion, 2);
        assert.deepEqual(journal.entries.slice(-2).map(e => e.operation), ['remove', 'reset']);
        throw new Error('Injected failure after removal');
      }
      return rename(from, to);
    });
    const previousUmask = process.umask(0o077);
    let result;
    try {
      result = applyStagedFiles({ dataDir, stageDir, absent: [
        { dest: 'later.json', operation: 'remove' },
        { dest: 'dry-run-state.json', operation: 'reset', contents: '{"version":1,"state":null}' },
      ] });
    } finally { process.umask(previousUmask); }
    assert.equal(result.success, false);
    assert.equal(result.rolledBack, true);
    assert.deepEqual(preRestoreState(), before);
    assert.equal(read(removed), 'later trade');
    assert.equal(read(reset), 'later simulation');
    assert.equal(fs.statSync(removed).mode & 0o777, 0o640);
    assert.equal(fs.statSync(reset).mode & 0o777, 0o604);
    assert.deepEqual(artifactNames(), []);
  });

  it('commits removal and dry-run reset durably, including a previously absent reset (#1702)', () => {
    write(path.join(dataDir, 'later.json'), 'later');
    const { events } = traceStorage();
    const result = applyStagedFiles({ dataDir, stageDir, absent: [
      { dest: 'later.json', operation: 'remove' },
      { dest: 'new-fund/dry-run-state.json', operation: 'reset', contents: '{"version":1,"state":null}' },
      { dest: 'missing/closed-trades.json', operation: 'remove' },
    ] });
    assert.equal(result.success, true);
    assert.equal(read(path.join(dataDir, 'later.json')), null);
    assert.equal(read(path.join(dataDir, 'new-fund/dry-run-state.json')), '{"version":1,"state":null}');
    assert.equal(fs.existsSync(path.join(dataDir, 'missing')), false);
    const removedAt = events.findIndex(e => e.type === 'remove' && e.file === path.join(dataDir, 'later.json'));
    const commitAt = events.findIndex(e => e.status === STATUS.COMMITTED);
    assert.ok(events.slice(removedAt + 1, commitAt).some(e => e.type === 'sync' && e.file === dataDir));
  });

  it('recovers removed/reset originals and removes a newly-created tombstone after a real process death (#1702)', async (t) => {
    write(path.join(dataDir, 'later.json'), 'later trade');
    write(path.join(dataDir, 'dry-run-state.json'), 'later simulation');
    fs.chmodSync(path.join(dataDir, 'later.json'), 0o640);
    fs.chmodSync(path.join(dataDir, 'dry-run-state.json'), 0o604);
    const before = preRestoreState();
    const script = `
      const fs = require('fs');
      const path = require('path');
      const { applyStagedFiles } = require(${JSON.stringify(require.resolve('../src/restore-apply'))});
      const [dataDir, stageDir] = process.argv.slice(1);
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        const result = rename(from, to);
        if (String(to) === path.join(dataDir, 'created/dry-run-state.json')) process.kill(process.pid, 'SIGKILL');
        return result;
      };
      applyStagedFiles({ dataDir, stageDir, absent: [
        { dest: 'later.json', operation: 'remove' },
        { dest: 'dry-run-state.json', operation: 'reset', contents: '{"version":1,"state":null}' },
        { dest: 'created/dry-run-state.json', operation: 'reset', contents: '{"version":1,"state":null}' }
      ] });
    `;
    const child = spawn(process.execPath, ['-e', script, dataDir, stageDir], { stdio: 'pipe' });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal })); });
    assert.equal(exit.signal, 'SIGKILL');
    assert.equal(read(path.join(dataDir, 'later.json')), null);
    assert.equal(read(path.join(dataDir, 'dry-run-state.json')), '{"version":1,"state":null}');
    assert.deepEqual(recoverIncompleteRestore({ dataDir }), { pending: true, recovered: true, blocked: false });
    assert.deepEqual(preRestoreState(), before);
    assert.equal(read(path.join(dataDir, 'later.json')), 'later trade');
    assert.equal(read(path.join(dataDir, 'dry-run-state.json')), 'later simulation');
    assert.equal(fs.statSync(path.join(dataDir, 'later.json')).mode & 0o777, 0o640);
    assert.equal(fs.statSync(path.join(dataDir, 'dry-run-state.json')).mode & 0o777, 0o604);
    assert.equal(fs.existsSync(path.join(dataDir, 'created')), false);
    assert.deepEqual(artifactNames(), []);
  });

  it('still recovers v1 journals without operation fields (#1702)', () => {
    seedInterruptedJournal();
    const journalPath = path.join(dataDir, JOURNAL_FILENAME);
    const journal = JSON.parse(read(journalPath));
    journal.journalVersion = 1;
    for (const entry of journal.entries) delete entry.operation;
    write(journalPath, JSON.stringify(journal));
    assert.deepEqual(recoverIncompleteRestore({ dataDir }), { pending: true, recovered: true, blocked: false });
    assert.equal(read(path.join(dataDir, 'alpha.json')), 'original generation');
  });

  it('rejects conflicting or escaping absence operations before changing destinations (#1702)', () => {
    const before = preRestoreState();
    for (const absent of [
      [{ dest: '../outside.json', operation: 'remove' }],
      [{ dest: 'alpha.json', operation: 'remove' }],
      [{ dest: 'absent.json', operation: 'reset' }],
      [{ dest: 'absent.json', operation: 'remove' }, { dest: 'absent.json', operation: 'remove' }],
    ]) {
      const result = applyStagedFiles({ dataDir, stageDir, absent });
      assert.equal(result.success, false);
      assert.equal(result.rolledBack, true);
      assert.deepEqual(preRestoreState(), before);
    }
  });

  it('refuses absence operations through destination symlinks (#1702)', () => {
    const outside = path.join(root, 'unrelated');
    fs.mkdirSync(outside);
    write(path.join(outside, 'closed-trades.json'), 'preserved');
    fs.symlinkSync(outside, path.join(dataDir, 'linked'));
    const result = applyStagedFiles({ dataDir, stageDir, absent: [
      { dest: 'linked/closed-trades.json', operation: 'remove' },
    ] });
    assert.equal(result.success, false);
    assert.equal(result.rolledBack, true);
    assert.equal(read(path.join(outside, 'closed-trades.json')), 'preserved');
    assert.equal(preRestoreState().alpha, '{"gen":"current-alpha"}');
  });

  it('serializes two real starters and re-reads after ownership transfer (#1693)', async (t) => {
    seedInterruptedJournal();
    const first = startRestoreProcess(t, { pauseRecovery: true, runtimeWrite: true });
    await waitForBarrier('recovery');
    const second = startRestoreProcess(t, { pauseContender: true });
    await waitForBarrier('contender');
    releaseBarrier('recovery');
    assert.deepEqual(await first.result(), { pending: true, recovered: true, blocked: false });
    assert.equal(read(path.join(dataDir, 'created.json')), 'new runtime generation');
    assert.equal(fs.existsSync(path.join(dataDir, JOURNAL_FILENAME)), false);
    releaseBarrier('contender');
    assert.deepEqual(await second.result(), { pending: false, recovered: false, blocked: false });
    assert.equal(read(path.join(dataDir, 'created.json')), 'new runtime generation');
    assert.equal(read(path.join(dataDir, 'alpha.json')), 'original generation');
    assert.equal(fs.existsSync(path.join(dataDir, JOURNAL_FILENAME)), false, 'a stale starter cannot recreate the retired journal');
    assert.equal(artifactNames().some((name) => name.startsWith(OWNER_PREFIX)), false);
  });

  it('never displaces a live apply owner on timeout and recovers after it is killed (#1693)', async (t) => {
    const owner = startRestoreProcess(t, { apply: true, pauseApply: true });
    await waitForBarrier('apply');
    const journalBefore = read(path.join(dataDir, JOURNAL_FILENAME));
    const markersBefore = artifactNames().filter((name) => name.startsWith(OWNER_PREFIX));
    const tmp = path.join(dataDir, '.alpha.json.restore-tmp');
    write(tmp, 'owned temporary replacement');
    const contender = startRestoreProcess(t, { waitMs: 50 });
    const refused = await contender.result();
    assert.equal(refused.blocked, true);
    assert.equal(refused.code, 'restore-ownership-unavailable');
    assert.equal(read(tmp), 'owned temporary replacement', 'a starter cannot clear the active owner temp file');
    assert.equal(read(path.join(dataDir, JOURNAL_FILENAME)), journalBefore);
    assert.deepEqual(artifactNames().filter((name) => name.startsWith(OWNER_PREFIX)), markersBefore);
    owner.child.kill('SIGKILL');
    await owner.done;
    // Two reclaimers observe the dead owner. Pause one with that stale identity,
    // then let the other publish a new ownership directory before it continues.
    const staleReclaimer = startRestoreProcess(t, { pauseContender: true, waitMs: 200 });
    await waitForBarrier('contender');
    const recovery = startRestoreProcess(t, { pauseRecovery: true });
    await waitForBarrier('recovery');
    const successorIdentity = fs.readdirSync(path.join(dataDir, OWNER_DIR));
    write(tmp, 'successor temporary replacement');
    releaseBarrier('contender');
    assert.equal((await staleReclaimer.result()).blocked, true);
    assert.deepEqual(fs.readdirSync(path.join(dataDir, OWNER_DIR)), successorIdentity,
      'a stale reclaimer cannot retire the new owner identity');
    assert.equal(read(tmp), 'successor temporary replacement');
    releaseBarrier('recovery');
    assert.deepEqual(await recovery.result(), { pending: true, recovered: true, blocked: false });
    assert.equal(read(tmp), null);
    assert.equal(read(path.join(dataDir, 'alpha.json')), '{"gen":"current-alpha"}');
    assert.equal(artifactNames().some((name) => name.startsWith(OWNER_PREFIX)), false, 'only the dead identity is reclaimed');
  });

  it('keeps an old marker for a live or reused PID and blocks without touching artifacts (#1693)', () => {
    seedInterruptedJournal();
    const marker = path.join(dataDir, OWNER_DIR, `${process.pid}-00000000-0000-0000-0000-000000000000`);
    write(marker, '');
    fs.utimesSync(marker, new Date(0), new Date(0));
    const before = read(path.join(dataDir, JOURNAL_FILENAME));
    const result = recoverIncompleteRestore({ dataDir, ownershipWaitMs: 0 });
    assert.equal(result.code, 'restore-ownership-unavailable');
    assert.equal(result.blocked, true);
    assert.equal(fs.existsSync(marker), true, 'age is never permission to evict a live PID');
    assert.equal(read(path.join(dataDir, JOURNAL_FILENAME)), before);
  });

  it('blocks on corrupt ownership metadata and unsupported journals (#1693)', () => {
    const corrupt = path.join(dataDir, OWNER_DIR, 'unrecognized');
    write(corrupt, '');
    assert.equal(recoverIncompleteRestore({ dataDir }).blocked, true);
    assert.equal(fs.existsSync(corrupt), true);
    fs.rmSync(path.join(dataDir, OWNER_DIR), { recursive: true });
    seedInterruptedJournal();
    const journal = JSON.parse(read(path.join(dataDir, JOURNAL_FILENAME)));
    write(path.join(dataDir, JOURNAL_FILENAME), JSON.stringify({ ...journal, journalVersion: JOURNAL_VERSION + 1 }));
    const result = recoverIncompleteRestore({ dataDir });
    assert.equal(result.blocked, true);
    assert.match(result.error, /not supported/);
    assert.equal(read(path.join(dataDir, 'alpha.json')), 'interrupted generation');
  });

  for (const operation of ['apply', 'recover']) {
    it(`fails closed if ${operation} cannot release its ownership identity (#1693)`, () => {
      const remove = fs.rmSync;
      mock.method(fs, 'rmSync', (target, ...args) => {
        if (path.dirname(String(target)) === path.join(dataDir, OWNER_DIR)) throw new Error('EACCES: ownership retirement refused');
        return remove(target, ...args);
      });
      const result = operation === 'apply'
        ? applyStagedFiles({ dataDir, stageDir })
        : recoverIncompleteRestore({ dataDir });
      assert.equal(result.code, 'restore-ownership-unavailable');
      assert.match(result.error, /Could not release restore ownership/);
      if (operation === 'apply') assert.equal(result.rolledBack, false, 'the coordinator must keep writers stopped');
      else assert.equal(result.blocked, true, 'startup cannot load state after failed ownership retirement');
      assert.equal(fs.readdirSync(path.join(dataDir, OWNER_DIR)).length, 1, 'the exact ownership identity survives the IO error');
    });
  }

  it('does not overwrite an earlier recovery plan when another archive is applied (#1693)', () => {
    seedInterruptedJournal();
    const before = read(path.join(dataDir, JOURNAL_FILENAME));
    const refused = applyStagedFiles({ dataDir, stageDir });
    assert.equal(refused.code, 'restore-recovery-pending');
    assert.equal(refused.rolledBack, false);
    assert.equal(read(path.join(dataDir, JOURNAL_FILENAME)), before);
    assert.equal(read(path.join(dataDir, 'alpha.json')), 'interrupted generation');
  });

  it('does not restore coordination identities from staged payloads (#1693)', () => {
    const name = `${OWNER_PREFIX}123-00000000-0000-0000-0000-000000000000-1`;
    write(path.join(stageDir, name), 'archive ownership');
    assert.equal(applyStagedFiles({ dataDir, stageDir }).success, true);
    assert.equal(read(path.join(dataDir, name)), null);
  });

  it('applies the whole set, commits once and leaves no journal or originals behind', async () => {
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

  it('never overwrites a destination in place: every replacement is a same-directory temp + rename', async () => {
    const renames = [];
    mock.method(fs, 'renameSync', (from, to) => {
      renames.push({ from: String(from), to: String(to) });
      return realRenameSync(from, to);
    });

    applyStagedFiles({ dataDir, stageDir, filename: 'backup-ok.zip', logger: silentLogger });

    for (const dest of [path.join(dataDir, 'alpha.json'), path.join(dataDir, 'beta.json'), path.join(dataDir, 'sub', 'gamma.json')]) {
      const call = renames.find((r) => r.to === dest);
      assert.ok(call, `${path.basename(dest)} must be published by a rename, not written in place`);
      assert.equal(call.from, path.join(path.dirname(dest), `.${path.basename(dest)}.restore-tmp`),
        'restart recovery and backup exclusions must recognize the publisher temp path');
      assert.ok(!fs.existsSync(call.from), 'the temp file must not survive the rename');
    }
  });

  it('rolls every destination back to its pre-restore bytes when a replacement fails', async () => {
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
    assert.deepEqual(walkAll(dataDir).filter((f) => f.endsWith('.tmp')), [], 'a failed replacement leaves no temp file for the next backup to archive');
  });

  it('removes the directories it created for the attempt when it rolls back', async () => {
    breakRenameFor({ [path.join(dataDir, 'beta.json')]: [1] });
    applyStagedFiles({ dataDir, stageDir, filename: 'backup-bad.zip', logger: silentLogger });
    assert.equal(fs.existsSync(path.join(dataDir, 'sub')), false);
  });

  it('rolls back instead of reporting success when the commit marker cannot be published', async () => {
    const before = preRestoreState();
    mock.method(fs, 'renameSync', (from, to) => {
      if (to === path.join(dataDir, JOURNAL_FILENAME)
        && JSON.parse(read(from)).status === STATUS.COMMITTED) {
        throw new Error('EIO: cannot publish commit marker');
      }
      return realRenameSync(from, to);
    });

    const result = applyStagedFiles({ dataDir, stageDir, logger: silentLogger });

    assert.equal(result.success, false);
    assert.equal(result.rolledBack, true);
    assert.deepEqual(preRestoreState(), before);
    assert.deepEqual(artifactNames(), []);
  });

  it('flushes rollback copies before publication, destinations before commit, and journal retirement before cleanup', async () => {
    const nested = path.join('existing', 'nested', 'state.json');
    write(path.join(dataDir, nested), 'current');
    write(path.join(stageDir, nested), 'archive');
    const { events } = traceStorage();

    assert.equal(applyStagedFiles({ dataDir, stageDir }).success, true);

    const journal = path.join(dataDir, JOURNAL_FILENAME);
    const prepared = events.findIndex((e) => e.type === 'rename' && e.file === journal && e.status === STATUS.APPLYING);
    const commit = events.findIndex((e) => e.type === 'rename' && e.file === journal && e.status === STATUS.COMMITTED);
    const originals = events.filter((e) => e.type === 'sync' && e.file.includes('.restore-originals-'));
    assert.equal(originals.filter((e) => e.file.endsWith('.json')).length, 3, 'every replaced original must be flushed');
    assert.ok(originals.some((e) => e.file.endsWith(path.join('existing', 'nested'))), 'nested rollback directory entries must be flushed');
    assert.ok(originals.every((e) => events.indexOf(e) < prepared), 'rollback bytes and directory entries precede the applying journal');
    for (const rel of ['alpha.json', 'beta.json', path.join('sub', 'gamma.json'), nested]) {
      const published = events.findIndex((e) => e.type === 'rename' && e.file === path.join(dataDir, rel));
      assert.ok(prepared < published && published < commit);
      assert.ok(events.slice(published + 1, commit).some((e) => e.type === 'sync' && e.file === path.dirname(path.join(dataDir, rel))), 'each destination rename must be flushed before commit');
    }
    const retired = events.findIndex((e) => e.type === 'remove' && e.file === journal);
    const discarded = events.findIndex((e) => e.type === 'remove' && e.file.includes('.restore-originals-'));
    assert.ok(retired < discarded && events.slice(retired + 1, discarded).some((e) => e.type === 'sync' && e.file === dataDir), 'journal removal must be durable before discarding rollback files');
  });

  it('leaves all destinations unchanged when a rollback-copy flush fails', async () => {
    const before = preRestoreState();
    const { descriptors } = traceStorage();
    const sync = fs.fsyncSync;
    mock.method(fs, 'fsyncSync', (fd) => {
      if (descriptors.get(fd)?.includes('.restore-originals-')) throw new Error('EIO: original flush failed');
      return sync(fd);
    });

    const result = applyStagedFiles({ dataDir, stageDir });

    assert.equal(result.success, false);
    assert.equal(result.code, 'rollback-snapshot-failed');
    assert.equal(result.rolledBack, true);
    assert.deepEqual(preRestoreState(), before);
    assert.equal(fs.existsSync(path.join(dataDir, JOURNAL_FILENAME)), false);
  });

  it('rolls back a replacement whose directory flush fails instead of committing it', async () => {
    const before = preRestoreState();
    const { descriptors } = traceStorage();
    const sync = fs.fsyncSync;
    let failed = false;
    mock.method(fs, 'fsyncSync', (fd) => {
      if (!failed && descriptors.get(fd) === path.join(dataDir, 'sub')) {
        failed = true;
        throw new Error('EIO: destination directory flush failed');
      }
      return sync(fd);
    });

    const result = applyStagedFiles({ dataDir, stageDir });

    assert.equal(failed, true, 'the new file directory must be flushed');
    assert.equal(result.success, false);
    assert.equal(result.rolledBack, true);
    assert.deepEqual(preRestoreState(), before);
    assert.deepEqual(artifactNames(), []);
  });

  it('retains originals and blocks resumption if the rollback journal cannot be retired', async () => {
    const before = preRestoreState();
    breakRenameFor({ [path.join(dataDir, 'beta.json')]: [1] });
    const remove = fs.rmSync;
    mock.method(fs, 'rmSync', (file, ...args) => {
      if (file === path.join(dataDir, JOURNAL_FILENAME)) throw new Error('EIO: journal removal failed');
      return remove(file, ...args);
    });

    const result = applyStagedFiles({ dataDir, stageDir });

    assert.equal(result.success, false);
    assert.equal(result.rolledBack, false, 'writers must stay stopped while a rollback marker can replay');
    assert.equal(read(path.join(dataDir, result.recovery.originalsDir, 'alpha.json')), before.alpha);
    mock.restoreAll();
    assert.equal(recoverIncompleteRestore({ dataDir }).blocked, false);
    assert.deepEqual(preRestoreState(), before);
    assert.deepEqual(artifactNames(), []);
  });

  it('does not start rollback until its marker is durable after a failed commit', async () => {
    const before = preRestoreState();
    mock.method(fs, 'renameSync', (from, to) => {
      if (to === path.join(dataDir, JOURNAL_FILENAME)
        && [STATUS.COMMITTED, STATUS.ROLLING_BACK].includes(JSON.parse(read(from)).status)) {
        throw new Error('EIO: journal publication failed');
      }
      return realRenameSync(from, to);
    });

    const result = applyStagedFiles({ dataDir, stageDir });

    assert.equal(result.success, false);
    assert.equal(result.rolledBack, false);
    assert.equal(preRestoreState().alpha, '{"gen":"archive-alpha"}', 'no rollback under an uncertain journal');
    assert.equal(read(path.join(dataDir, result.recovery.originalsDir, 'alpha.json')), before.alpha);
    mock.restoreAll();
    assert.equal(recoverIncompleteRestore({ dataDir }).blocked, false);
    assert.deepEqual(preRestoreState(), before);
  });

  it('reverts a commit whose rename landed but whose journal directory flush failed', async () => {
    const before = preRestoreState();
    const { descriptors } = traceStorage();
    const sync = fs.fsyncSync;
    let failed = false;
    mock.method(fs, 'fsyncSync', (fd) => {
      const journal = read(path.join(dataDir, JOURNAL_FILENAME));
      if (!failed && descriptors.get(fd) === dataDir && journal
        && JSON.parse(journal).status === STATUS.COMMITTED) {
        failed = true;
        throw new Error('EIO: commit directory flush failed');
      }
      return sync(fd);
    });

    const result = applyStagedFiles({ dataDir, stageDir });

    assert.equal(failed, true);
    assert.equal(result.success, false);
    assert.equal(result.rolledBack, true);
    assert.deepEqual(preRestoreState(), before);
    assert.deepEqual(artifactNames(), []);
  });

  it('refuses the whole archive before any write when a staged entry is not a regular file', async () => {
    const before = preRestoreState();
    fs.symlinkSync(path.join(root, 'outside.json'), path.join(stageDir, 'evil.json'));

    const result = applyStagedFiles({ dataDir, stageDir, filename: 'backup-evil.zip', logger: silentLogger });

    assert.equal(result.success, false);
    assert.equal(result.code, 'staged-set-invalid');
    assert.equal(result.rolledBack, true);
    assert.deepEqual(preRestoreState(), before, 'validation happens before the first destination write');
    assert.deepEqual(artifactNames().filter((n) => n !== '.restore-temp-fixture'), []);
  });

  it('honours the caller\'s skip rules (keys, backups dir, archive metadata)', async () => {
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

  it('reports incomplete recovery and RETAINS the journal and originals when the rollback fails', async () => {
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

  it('finishes the rollback on the next start, so nothing loads a mixed generation', async () => {
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

  it('removes orphaned restore temp copies left by a crash between copy and rename', async () => {
    const alpha = path.join(dataDir, 'alpha.json');
    const gamma = path.join(dataDir, 'sub', 'gamma.json');
    breakRenameFor({ [alpha]: [2], [path.join(dataDir, 'beta.json')]: [1] });
    applyStagedFiles({ dataDir, stageDir, filename: 'backup-torn.zip', logger: silentLogger });
    mock.restoreAll();
    // Process death after the temp copy was written, before its rename.
    write(path.join(dataDir, '.beta.json.restore-tmp'), '{"gen":"archive-beta"}');
    write(path.join(dataDir, 'sub', '.gamma.json.restore-tmp'), '{"gen":"archive-gamma"}');

    recoverIncompleteRestore({ dataDir, logger: silentLogger });

    assert.equal(fs.existsSync(path.join(dataDir, '.beta.json.restore-tmp')), false);
    assert.equal(fs.existsSync(path.join(dataDir, 'sub', '.gamma.json.restore-tmp')), false);
    assert.deepEqual(preRestoreState(), { alpha: '{"gen":"current-alpha"}', beta: '{"gen":"current-beta"}', gamma: null });
    assert.equal(fs.existsSync(gamma), false);
  });

  it('reports incomplete rollback instead of throwing when a temp copy cannot be deleted', async () => {
    breakRenameFor({ [path.join(dataDir, 'alpha.json')]: [2], [path.join(dataDir, 'beta.json')]: [1] });
    applyStagedFiles({ dataDir, stageDir, filename: 'backup-torn.zip', logger: silentLogger });
    mock.restoreAll();
    const tmp = path.join(dataDir, '.beta.json.restore-tmp');
    const realRm = fs.rmSync;
    mock.method(fs, 'rmSync', (target, ...rest) => {
      if (target === tmp) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return realRm(target, ...rest);
    });

    const result = recoverIncompleteRestore({ dataDir, logger: silentLogger });
    mock.restoreAll();

    assert.equal(result.recovered, false);
    assert.equal(result.blocked, true);
  });

  it('is a no-op for a data directory with no journal', async () => {
    assert.deepEqual(recoverIncompleteRestore({ dataDir, logger: silentLogger }), { pending: false, recovered: false, blocked: false });
    assert.deepEqual(preRestoreState().alpha, '{"gen":"current-alpha"}');
  });

  it('cleans up without rolling back when the crash happened after the commit point', async () => {
    applyStagedFiles({ dataDir, stageDir, filename: 'backup-ok.zip', logger: silentLogger });
    // Re-create the artifacts a crash between "committed" and "cleaned" leaves.
    const originals = path.join(dataDir, '.restore-originals-committed');
    write(path.join(originals, 'alpha.json'), '{"gen":"current-alpha"}');
    write(path.join(dataDir, JOURNAL_FILENAME), JSON.stringify({
      journalVersion: JOURNAL_VERSION,
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

  it('blocks startup when an interrupted restore cannot be rolled back', async () => {
    write(path.join(dataDir, JOURNAL_FILENAME), JSON.stringify({
      journalVersion: JOURNAL_VERSION,
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

  it('blocks startup on an unreadable journal rather than guessing', async () => {
    write(path.join(dataDir, JOURNAL_FILENAME), 'not json at all');
    const exits = [];
    const result = guardIncompleteRestore({ processLabel: 'coinbase engine', logger: silentLogger, dataDir, exit: (code) => exits.push(code) });
    assert.deepEqual(exits, [1]);
    assert.equal(result.blocked, true);
  });

  it('lets a clean start through untouched', async () => {
    const exits = [];
    const result = guardIncompleteRestore({ processLabel: 'gateway', logger: silentLogger, dataDir, exit: (code) => exits.push(code) });
    assert.deepEqual(exits, []);
    assert.equal(result.pending, false);
  });

  it('refuses before any write, and reports it as rolled back, when the staged tree cannot be walked', async () => {
    const realReaddirSync = fs.readdirSync;
    mock.method(fs, 'readdirSync', (target, ...rest) => {
      if (String(target) === path.join(stageDir, 'sub')) throw new Error('EIO: injected walk failure');
      return realReaddirSync(target, ...rest);
    });

    const result = applyStagedFiles({ dataDir, stageDir, filename: 'backup-walk.zip', logger: silentLogger });

    assert.equal(result.success, false);
    assert.equal(result.code, 'staged-set-unreadable');
    assert.equal(result.rolledBack, true);
    assert.deepEqual(preRestoreState(), { alpha: '{"gen":"current-alpha"}', beta: '{"gen":"current-beta"}', gamma: null });
    assert.deepEqual(artifactNames().filter((n) => n !== '.restore-temp-fixture'), [], 'no journal or originals are created before the walk succeeds');
  });

  it('sweeps old orphaned staging directories at startup but keeps fresh ones and journal-owned ones', async () => {
    const orphan = path.join(dataDir, '.restore-temp-orphan');
    const fresh = path.join(dataDir, '.restore-temp-fresh');
    const owned = path.join(dataDir, '.restore-temp-owned');
    for (const dir of [orphan, fresh, owned]) write(path.join(dir, 'x.json'), '{}');
    const anHourAgo = new Date(Date.now() - 60 * 60_000);
    for (const dir of [orphan, owned]) {
      fs.utimesSync(path.join(dir, 'x.json'), anHourAgo, anHourAgo);
      fs.utimesSync(dir, anHourAgo, anHourAgo);
    }
    // An old directory whose child is still being written belongs to a live restore.
    const active = path.join(dataDir, '.restore-temp-active');
    write(path.join(active, 'nested', 'x.json'), '{}');
    for (const p of [path.join(active, 'nested'), active]) fs.utimesSync(p, anHourAgo, anHourAgo);
    // A journal that cannot be rolled back: its staging directory must survive for recovery.
    write(path.join(dataDir, JOURNAL_FILENAME), JSON.stringify({
      journalVersion: JOURNAL_VERSION,
      restoreId: 'owned',
      filename: 'backup-owned.zip',
      status: STATUS.APPLYING,
      originalsDir: '.restore-originals-missing',
      stageDir: '.restore-temp-owned',
      entries: [{ dest: 'alpha.json', existed: true }],
      createdDirs: [],
    }));

    const result = recoverIncompleteRestore({ dataDir, logger: silentLogger });

    assert.equal(result.blocked, true);
    assert.equal(fs.existsSync(orphan), false, 'an old unreferenced staging directory is removed');
    assert.equal(fs.existsSync(fresh), true, 'a fresh staging directory may belong to a live restore and is kept');
    assert.equal(fs.existsSync(owned), true, 'a journal-owned staging directory is kept for recovery');
    assert.equal(fs.existsSync(active), true, 'a directory with a recently written nested file is kept');
  });
});

describe('backup-service — restore failure leaves the install coherent (#431)', () => {
  /** @type {{dataDir: string, baseConfigFile: string}} */
  let install;
  /** @type {string} */
  let filename;

  const stateFile = () => path.join(install.dataDir, 'coinbase', 'BTC-USDC', 'regime-state.json');
  const ledgerFile = () => path.join(install.dataDir, 'coinbase', 'BTC-USDC', 'fill-ledger.json');

  beforeEach(async () => {
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
    write(ledgerFile(), JSON.stringify(ledgerOf('archive-1', 'archive-2')));

    const created = await createBackup({ paths: install });
    assert.equal(created.success, true, created.error);
    filename = created.filename;

    // The install moves on: both files are now a generation newer than the archive.
    write(stateFile(), JSON.stringify({ generation: 'current', realizedPnL: 42 }));
    write(ledgerFile(), JSON.stringify(ledgerOf('current-1', 'current-2', 'current-3')));
  });

  afterEach(() => {
    mock.restoreAll();
    for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('restores every file on the happy path', async () => {
    const result = restoreBackup(filename, { paths: install });
    assert.equal(result.success, true, result.error);
    assert.equal(JSON.parse(read(stateFile())).generation, 'archive');
    assert.equal(JSON.parse(read(ledgerFile()))[0].tradeId, 'archive-1');
    assert.deepEqual(fs.readdirSync(install.dataDir).filter((n) => n.startsWith('.restore-')), []);
  });

  it('leaves state, ledger and config on ONE generation when the application fails', async () => {
    breakRenameFor({ [ledgerFile()]: [1] });

    const result = restoreBackup(filename, { paths: install });

    assert.equal(result.success, false);
    assert.equal(result.code, 'restore-apply-failed');
    assert.equal(result.rolledBack, true);
    assert.equal(JSON.parse(read(stateFile())).generation, 'current', 'state must not be left on the archive generation');
    assert.equal(JSON.parse(read(ledgerFile()))[0].tradeId, 'current-1');
    assert.equal(JSON.parse(read(stateFile())).realizedPnL, 42);
    assert.deepEqual(fs.readdirSync(install.dataDir).filter((n) => n.startsWith('.restore-')), [], 'no artifacts leak after a clean rollback');
  });

  it('removes the staging directory when a step after extraction throws', async () => {
    const realWriteFileSync = fs.writeFileSync;
    mock.method(fs, 'writeFileSync', (target, ...rest) => {
      if (String(target).includes(`${path.sep}.restore-temp-`)) throw new Error('ENOSPC: injected staging write failure');
      return realWriteFileSync(target, ...rest);
    });

    const result = restoreBackup(filename, { paths: install });

    assert.equal(result.success, false);
    assert.equal(result.code, 'staging-failed');
    assert.match(result.error, /ENOSPC/);
    assert.equal(JSON.parse(read(stateFile())).generation, 'current', 'the destination is untouched');
    assert.deepEqual(fs.readdirSync(install.dataDir).filter((n) => n.startsWith('.restore-')), [], 'no staging directory leaks');
  });

  it('never archives its own restore bookkeeping', async () => {
    write(path.join(install.dataDir, JOURNAL_FILENAME), '{"journalVersion":1,"entries":[]}');
    write(path.join(install.dataDir, '.restore-originals-stale', 'alpha.json'), '{}');
    write(path.join(install.dataDir, OWNER_DIR, '123-00000000-0000-0000-0000-000000000000'), '');
    write(path.join(install.dataDir, `${OWNER_PREFIX}456-orphan-candidate`, '456-identity'), '');
    write(path.join(install.dataDir, '.alpha.json.restore-tmp'), '{}');
    write(path.join(install.dataDir, 'fund', '.state.json.restore-tmp'), '{}');
    const created = await createBackup({ paths: install });
    assert.equal(created.success, true, created.error);

    const { spawnSync } = require('child_process');
    const entries = spawnSync('unzip', ['-Z1', path.join(install.dataDir, 'backups', created.filename)])
      .stdout.toString().split('\n').filter(Boolean);

    assert.equal(entries.some((e) => e.includes('.restore-')), false, `restore bookkeeping leaked into the archive: ${entries.join(', ')}`);
  });
});
