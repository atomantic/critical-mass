// @ts-check
// Covers issue #396: missing zip/unzip binaries must surface a real error
// (not "Unknown zip error"), and temp-dir cleanup must use fs.rmSync
// instead of shelling out to /bin/rm.
// Covers issue #404: archive creation must exclude API keys, restore must
// never clobber live key files, and deleteBackup/restoreBackup must reject
// path traversal and symlink attacks; pruneBackups must enforce retention.
const { describe, it, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

// The service's list/prune entry points use module-level paths. Bind this
// isolated test process to a temporary data root before loading the service;
// no test may enumerate, overwrite, or prune the operator's actual backups.
const pathsModule = require('../src/paths');
const originalPaths = { ...pathsModule };
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-backup-service-test-'));
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
Object.assign(pathsModule, { DATA_DIR, BACKUP_DIR });

const {
  createBackup,
  listBackups,
  deleteBackup,
  pruneBackups,
  restoreBackup,
} = require('../src/backup-service');
Object.assign(pathsModule, originalPaths);
after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

// All fixtures and archive operations stay inside the temporary data root.
const TEST_FILE = path.join(DATA_DIR, '__backup_service_test__.json');
const originalPath = process.env.PATH;

const cleanupTestFile = () => {
  if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
};

// Lists entry names inside a zip archive (via `unzip -Z1`, zipinfo short form)
// so tests can assert on exclusion without going through restoreBackup.
const listZipEntries = (zipPath) => {
  const result = spawnSync('unzip', ['-Z1', zipPath]);
  return result.stdout.toString().split('\n').filter(Boolean);
};

// Removes a set of absolute file/dir paths if they exist, ignoring missing ones.
const removeAll = (paths) => {
  for (const p of paths) {
    fs.rmSync(p, { recursive: true, force: true });
  }
};

describe('backup-service — createBackup/restoreBackup', () => {
  const createdBackups = [];

  beforeEach(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TEST_FILE, JSON.stringify({ marker: 'backup-service-test' }));
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    cleanupTestFile();
    for (const filename of createdBackups.splice(0)) {
      deleteBackup(filename);
    }
  });

  it('creates a real archive and lists it', () => {
    const result = createBackup();
    assert.equal(result.success, true);
    assert.ok(result.filename);
    assert.ok(result.sizeBytes > 0);
    createdBackups.push(result.filename);

    const listed = listBackups();
    assert.ok(listed.some(b => b.filename === result.filename));
  });

  it('returns the real spawnSync error (not "Unknown zip error") when the zip binary is missing', () => {
    process.env.PATH = '';
    const result = createBackup();
    process.env.PATH = originalPath;

    assert.equal(result.success, false);
    assert.match(result.error, /ENOENT/);
    assert.notEqual(result.error, 'Unknown zip error');
  });

  it('returns the real spawnSync error (not "Unknown unzip error") when the unzip binary is missing', () => {
    const created = createBackup();
    assert.equal(created.success, true);
    createdBackups.push(created.filename);

    process.env.PATH = '';
    const result = restoreBackup(created.filename);
    process.env.PATH = originalPath;

    assert.equal(result.success, false);
    assert.match(result.error, /ENOENT/);
    assert.notEqual(result.error, 'Unknown unzip error');
  });

  it('restores files from a real archive and cleans up the temp dir via fs.rmSync', () => {
    const created = createBackup();
    assert.equal(created.success, true);
    createdBackups.push(created.filename);

    // Remove the fixture file so we can observe it come back via restore.
    cleanupTestFile();
    assert.equal(fs.existsSync(TEST_FILE), false);

    const result = restoreBackup(created.filename);
    assert.equal(result.success, true);
    assert.ok(result.filesRestored > 0);
    assert.equal(fs.existsSync(TEST_FILE), true);

    // No leftover .restore-temp-* directories should remain in DATA_DIR.
    const leftovers = fs.readdirSync(DATA_DIR).filter(name => name.startsWith('.restore-temp-'));
    assert.deepEqual(leftovers, []);
  });
});

describe('backup-service — API key exclusion', () => {
  const topLevelKeys = path.join(DATA_DIR, '__backup_service_test_coinbase-keys.json');
  const subDir = path.join(DATA_DIR, '__backup_service_test_gemini__');
  const nestedKeys = path.join(subDir, 'gemini-keys.json');
  const nestedState = path.join(subDir, 'state.json');
  const createdBackups = [];

  beforeEach(() => {
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(TEST_FILE, JSON.stringify({ marker: 'backup-service-test' }));
    fs.writeFileSync(topLevelKeys, JSON.stringify({ apiKey: 'top-secret' }));
    fs.writeFileSync(nestedKeys, JSON.stringify({ apiKey: 'nested-secret' }));
    fs.writeFileSync(nestedState, JSON.stringify({ marker: 'nested-state' }));
  });

  afterEach(() => {
    cleanupTestFile();
    removeAll([topLevelKeys, subDir]);
    for (const filename of createdBackups.splice(0)) {
      deleteBackup(filename);
    }
  });

  it('omits top-level and nested *-keys.json files from the archive', () => {
    const result = createBackup();
    assert.equal(result.success, true);
    createdBackups.push(result.filename);

    const entries = listZipEntries(path.join(BACKUP_DIR, result.filename));
    assert.ok(!entries.some(e => e.endsWith('-keys.json')), `archive should not contain any *-keys.json entries, got: ${entries.join(', ')}`);

    // Non-key files in the same locations must still be archived.
    assert.ok(entries.includes(path.basename(TEST_FILE)));
    assert.ok(entries.some(e => e.endsWith('__backup_service_test_gemini__/state.json')));
  });

  it('omits the backups directory itself from the archive', () => {
    const result = createBackup();
    assert.equal(result.success, true);
    createdBackups.push(result.filename);

    const entries = listZipEntries(path.join(BACKUP_DIR, result.filename));
    assert.ok(!entries.some(e => e === 'backups' || e.startsWith('backups/')), `archive should not contain the backups dir, got: ${entries.join(', ')}`);
  });
});

describe('backup-service — restoreBackup preserves existing keys', () => {
  const liveKeys = path.join(DATA_DIR, '__backup_service_test_coinbase-keys.json');
  const restoreState = path.join(DATA_DIR, '__backup_service_test_restore_state.json');
  let sourceDir;
  let craftedFilename;

  beforeEach(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    // The live "existing" key on disk before restore runs.
    fs.writeFileSync(liveKeys, JSON.stringify({ apiKey: 'live-key-must-survive' }));

    // Craft an archive directly with `zip` (bypassing createBackup's own
    // excludes) so this test exercises restoreBackup's independent
    // defense-in-depth skip of *-keys.json, not createBackup's exclusion.
    sourceDir = fs.mkdtempSync(path.join(DATA_DIR, '.restore-source-'));
    fs.writeFileSync(path.join(sourceDir, '__backup_service_test_coinbase-keys.json'), JSON.stringify({ apiKey: 'archive-key-must-not-land' }));
    fs.writeFileSync(path.join(sourceDir, '__backup_service_test_restore_state.json'), JSON.stringify({ marker: 'restored-from-archive' }));

    craftedFilename = `backup-${Date.now()}-crafted.zip`;
    const zipResult = spawnSync('zip', ['-r', '-q', path.join(BACKUP_DIR, craftedFilename), '.'], { cwd: sourceDir });
    assert.equal(zipResult.status, 0, zipResult.stderr?.toString());
  });

  afterEach(() => {
    removeAll([liveKeys, restoreState, sourceDir, path.join(BACKUP_DIR, craftedFilename)]);
  });

  it('leaves the on-disk key file untouched while restoring non-key files', () => {
    // The crafted archive has no #430 configuration manifest, so it is a
    // legacy archive: accept it data-only, which is what this test is about.
    const result = restoreBackup(craftedFilename, { acceptLegacyWithoutBase: true });
    assert.equal(result.success, true);

    // Key file on disk must retain its original (live) content.
    const keysOnDisk = JSON.parse(fs.readFileSync(liveKeys, 'utf8'));
    assert.equal(keysOnDisk.apiKey, 'live-key-must-survive');

    // Non-key file from the archive must have landed.
    assert.equal(fs.existsSync(restoreState), true);
    const stateOnDisk = JSON.parse(fs.readFileSync(restoreState, 'utf8'));
    assert.equal(stateOnDisk.marker, 'restored-from-archive');
  });
});

describe('backup-service — deleteBackup guards', () => {
  const realBackups = [];

  afterEach(() => {
    for (const filePath of realBackups.splice(0)) {
      fs.rmSync(filePath, { force: true });
    }
  });

  it('rejects filenames containing ".."', () => {
    const result = deleteBackup('../backup-evil.zip');
    assert.deepEqual(result, { success: false, error: 'Invalid filename' });
  });

  it('rejects filenames containing a path separator', () => {
    const result = deleteBackup('sub/backup-evil.zip');
    assert.deepEqual(result, { success: false, error: 'Invalid filename' });
  });

  it('rejects absolute paths', () => {
    const result = deleteBackup('/etc/passwd');
    assert.deepEqual(result, { success: false, error: 'Invalid filename' });
  });

  it('rejects filenames containing a backslash', () => {
    const result = deleteBackup('backup-evil\\..\\secrets.zip');
    assert.deepEqual(result, { success: false, error: 'Invalid filename' });
  });

  it('rejects filenames that do not match the backup-*.zip format', () => {
    assert.deepEqual(deleteBackup('notabackup.zip'), { success: false, error: 'Invalid backup filename format' });
    assert.deepEqual(deleteBackup('backup-2026-01-01.tar'), { success: false, error: 'Invalid backup filename format' });
  });

  it('returns not-found for a well-formed filename that does not exist', () => {
    const result = deleteBackup('backup-does-not-exist.zip');
    assert.deepEqual(result, { success: false, error: 'Backup not found' });
  });

  it('rejects symlinks instead of deleting through them', () => {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const targetOutsideBackups = path.join(DATA_DIR, '__backup_service_test_symlink_target.json');
    fs.writeFileSync(targetOutsideBackups, JSON.stringify({ marker: 'must-not-be-deleted' }));
    const symlinkName = 'backup-symlink-test.zip';
    const symlinkPath = path.join(BACKUP_DIR, symlinkName);
    fs.symlinkSync(targetOutsideBackups, symlinkPath);
    realBackups.push(symlinkPath, targetOutsideBackups);

    const result = deleteBackup(symlinkName);
    assert.deepEqual(result, { success: false, error: 'Invalid backup file' });

    // Neither the symlink nor its target should have been removed.
    assert.equal(fs.existsSync(symlinkPath), true);
    assert.equal(fs.existsSync(targetOutsideBackups), true);
  });
});

describe('backup-service — restoreBackup guards', () => {
  it('rejects filenames containing ".."', () => {
    const result = restoreBackup('../backup-evil.zip');
    assert.deepEqual(result, { success: false, error: 'Invalid filename' });
  });

  it('rejects filenames containing a path separator', () => {
    const result = restoreBackup('sub/backup-evil.zip');
    assert.deepEqual(result, { success: false, error: 'Invalid filename' });
  });

  it('rejects filenames that do not match the backup-*.zip format', () => {
    assert.deepEqual(restoreBackup('notabackup.zip'), { success: false, error: 'Invalid backup filename format' });
  });

  it('returns not-found for a well-formed filename that does not exist', () => {
    const result = restoreBackup('backup-does-not-exist.zip');
    assert.deepEqual(result, { success: false, error: 'Backup not found' });
  });

  it('rejects symlinks instead of extracting through them', () => {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const targetOutsideBackups = path.join(DATA_DIR, '__backup_service_test_restore_symlink_target.json');
    fs.writeFileSync(targetOutsideBackups, JSON.stringify({ marker: 'irrelevant' }));
    const symlinkName = 'backup-restore-symlink-test.zip';
    const symlinkPath = path.join(BACKUP_DIR, symlinkName);
    fs.symlinkSync(targetOutsideBackups, symlinkPath);

    const result = restoreBackup(symlinkName);
    assert.deepEqual(result, { success: false, error: 'Invalid backup file' });

    fs.rmSync(symlinkPath, { force: true });
    fs.rmSync(targetOutsideBackups, { force: true });
  });
});

describe('backup-service — pruneBackups retention', () => {
  const prefix = '__backup_service_test_prune__';
  const created = [];

  const makeBackup = (name, mtimeMs) => {
    const filePath = path.join(BACKUP_DIR, name);
    fs.writeFileSync(filePath, 'placeholder');
    const mtime = new Date(mtimeMs);
    fs.utimesSync(filePath, mtime, mtime);
    created.push(filePath);
  };

  beforeEach(() => {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    // pruneBackups operates over every backup in BACKUP_DIR, so this suite
    // needs exclusive control of its contents: clear any stray archives
    // (e.g. left behind by an interrupted prior run) before seeding fixtures.
    for (const entry of fs.readdirSync(BACKUP_DIR)) {
      if (entry.startsWith('backup-') && entry.endsWith('.zip')) {
        fs.rmSync(path.join(BACKUP_DIR, entry), { force: true });
      }
    }
    const base = Date.now();
    // Five backups, oldest to newest, each a distinct mtime one hour apart.
    for (let i = 0; i < 5; i++) {
      makeBackup(`backup-${prefix}-${i}.zip`, base - (4 - i) * 3600 * 1000);
    }
  });

  afterEach(() => {
    for (const filePath of created.splice(0)) {
      fs.rmSync(filePath, { force: true });
    }
  });

  it('deletes only the oldest archives beyond maxBackups, keeping the newest', () => {
    assert.equal(listBackups().length, 5);

    const result = pruneBackups(2);
    assert.equal(result.pruned, 3);
    assert.equal(result.remaining, 2);

    const after = listBackups();
    assert.equal(after.length, 2);
    // The two survivors must be the two newest of the fixture set.
    const survivorNames = after.map(b => b.filename).sort();
    assert.deepEqual(survivorNames, [`backup-${prefix}-3.zip`, `backup-${prefix}-4.zip`].sort());
  });

  it('prunes nothing when the backup count is within the retention limit', () => {
    const totalBackups = listBackups().length;
    assert.equal(totalBackups, 5);

    const result = pruneBackups(totalBackups);
    assert.equal(result.pruned, 0);
    assert.equal(result.remaining, totalBackups);
    assert.equal(listBackups().length, 5);
  });
});
