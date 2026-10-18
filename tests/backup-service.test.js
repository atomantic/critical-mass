// @ts-check
// Covers issue #396: missing zip/unzip binaries must surface a real error
// (not "Unknown zip error"), and temp-dir cleanup must use fs.rmSync
// instead of shelling out to /bin/rm.
// Covers issue #404: archive creation must exclude credentials, restore must
// never clobber live credential files, and deleteBackup/restoreBackup must
// reject path traversal and symlink attacks; pruneBackups must enforce retention.
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
  inspectBackup,
} = require('../src/backup-service');
const { GLOBAL_DEFAULTS } = require('../src/config-utils');
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

describe('backup configuration JSON diagnostics', () => {
  const root = path.join(DATA_DIR, 'diagnostic-fixture');
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const corruptFile of ['base', 'user']) {
    for (const malformed of ['SECRET820', '{"token":"SECRET820","bad":SECRET820}']) {
      it(`rejects malformed ${corruptFile} config without credential excerpts (${malformed.length})`, async () => {
        const dataDir = path.join(root, 'data');
        const baseConfigFile = path.join(root, 'base.json');
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(baseConfigFile, '{}');
        const paths = { dataDir, baseConfigFile };
        const archive = await createBackup({ paths });
        assert.equal(archive.success, true);
        fs.writeFileSync(corruptFile === 'base' ? baseConfigFile : path.join(dataDir, 'config.json'), malformed);
        for (const result of [await createBackup({ paths }), inspectBackup(archive.filename, { paths })]) {
          assert.equal(result.success, false);
          assert.ok(result.error.includes('ERR_INVALID_JSON'));
          assert.ok(!JSON.stringify(result).includes('SECRET820'));
        }
      });
    }
  }
  it('distinguishes I/O errors from invalid JSON without forwarding native messages', async () => {
    fs.mkdirSync(path.join(root, 'base.json'), { recursive: true });
    const result = await createBackup({ paths: { dataDir: path.join(root, 'data'), baseConfigFile: path.join(root, 'base.json') } });
    assert.equal(result.success, false);
    assert.ok(result.error.includes('unable to read JSON'));
    assert.ok(!result.error.includes('ERR_INVALID_JSON'));
  });
});

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

  it('creates a real archive and lists it', async () => {
    const result = await createBackup();
    assert.equal(result.success, true);
    assert.ok(result.filename);
    assert.ok(result.sizeBytes > 0);
    createdBackups.push(result.filename);

    const listed = listBackups();
    assert.ok(listed.some(b => b.filename === result.filename));
  });

  const createArchiveFixture = (filename, entries) => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-backup-list-fixture-'));
    const archive = path.join(BACKUP_DIR, filename);
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    createdBackups.push(filename);
    try {
      for (const [name, contents] of Object.entries(entries)) fs.writeFileSync(path.join(source, name), contents);
      const zipped = spawnSync('zip', ['-q', archive, ...Object.keys(entries)], { cwd: source });
      assert.equal(zipped.status, 0, zipped.stderr.toString());
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
    }
    return archive;
  };

  it('lists valid pre-manifest legacy archives and restores them after explicit acknowledgement', async () => {
    const filename = 'backup-legacy-list-regression.zip';
    const archive = createArchiveFixture(filename, {
      '__backup_service_test__.json': JSON.stringify({ marker: 'legacy-recovery' }),
    });
    assert.equal(spawnSync('unzip', ['-tq', archive]).status, 0);
    assert.ok(listBackups().some(backup => backup.filename === filename));

    const inspected = inspectBackup(filename);
    assert.equal(inspected.legacy, true);
    assert.equal(inspected.code, 'legacy-archive-missing-base');
    assert.equal(restoreBackup(filename).success, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(TEST_FILE, 'utf8')), { marker: 'backup-service-test' });
    cleanupTestFile();
    const restored = restoreBackup(filename, { acceptLegacyWithoutBase: true });
    assert.equal(restored.success, true, restored.error);
    assert.deepEqual(JSON.parse(fs.readFileSync(TEST_FILE, 'utf8')), { marker: 'legacy-recovery' });
  });

  it('excludes integrity-valid archives with malformed or duplicate manifests', async () => {
    const malformed = 'backup-malformed-manifest-list.zip';
    const duplicate = 'backup-duplicate-manifest-list.zip';
    createArchiveFixture(malformed, { 'backup-manifest.json': '{not valid json' });
    const manifest = JSON.stringify({ manifestVersion: 1, createdAt: new Date().toISOString(), config: {} });
    const archive = createArchiveFixture(duplicate, {
      'backup-manifest.json': manifest,
      'backup-manifesz.json': manifest,
    });
    // ZIP filenames do not participate in the entry CRC. Rename both local and
    // central-directory copies of the second equal-length name to retain real
    // integrity-valid bytes with two entries bearing the manifest's exact name.
    const bytes = fs.readFileSync(archive);
    const from = Buffer.from('backup-manifesz.json');
    const to = Buffer.from('backup-manifest.json');
    let renamed = 0;
    for (let offset = bytes.indexOf(from); offset !== -1; offset = bytes.indexOf(from, offset + to.length)) {
      to.copy(bytes, offset);
      renamed++;
    }
    assert.equal(renamed, 2);
    fs.writeFileSync(archive, bytes);
    for (const filename of [malformed, duplicate]) {
      assert.equal(spawnSync('unzip', ['-tq', path.join(BACKUP_DIR, filename)]).status, 0);
    }
    assert.equal(listZipEntries(archive).filter(name => name === 'backup-manifest.json').length, 2);
    const listed = listBackups().map(backup => backup.filename);
    assert.ok(!listed.includes(malformed));
    assert.ok(!listed.includes(duplicate));
  });

  it('publishes same-second backups under distinct names with one valid manifest each', async () => {
    const first = await createBackup();
    const second = await createBackup();
    assert.equal(first.success, true);
    assert.equal(second.success, true);
    assert.notEqual(first.filename, second.filename);
    createdBackups.push(first.filename, second.filename);
    for (const backup of [first, second]) {
      const archive = path.join(BACKUP_DIR, backup.filename);
      assert.equal(spawnSync('unzip', ['-tq', archive]).status, 0);
      assert.equal(listZipEntries(archive).filter(entry => entry === 'backup-manifest.json').length, 1);
    }
    assert.deepEqual(fs.readdirSync(BACKUP_DIR).filter(name => name.startsWith('.backup-')), []);
  });

  it('keeps the event loop responsive while zip is running (issue #1158)', async () => {
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-fake-zip-'));
    const realZip = spawnSync('which', ['zip']).stdout.toString().trim();
    fs.writeFileSync(path.join(fakeBin, 'zip'), `#!/bin/sh\nsleep 1\nexec ${realZip} "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath}`;
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 20);
    try {
      const result = await createBackup();
      assert.equal(result.success, true, result.error);
    } finally {
      clearInterval(timer);
      process.env.PATH = originalPath;
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
    // A blocking spawnSync would starve the interval for the full second.
    assert.ok(ticks >= 10, `expected timer ticks during zip, got ${ticks}`);
  });

  it('returns the real spawnSync error (not "Unknown zip error") when the zip binary is missing', async () => {
    process.env.PATH = '';
    const result = await createBackup();
    process.env.PATH = originalPath;

    assert.equal(result.success, false);
    assert.match(result.error, /ENOENT/);
    assert.notEqual(result.error, 'Unknown zip error');
  });

  it('returns the real spawnSync error (not "Unknown unzip error") when the unzip binary is missing', async () => {
    const created = await createBackup();
    assert.equal(created.success, true);
    createdBackups.push(created.filename);

    process.env.PATH = '';
    const result = restoreBackup(created.filename);
    process.env.PATH = originalPath;

    assert.equal(result.success, false);
    assert.match(result.error, /ENOENT/);
    assert.notEqual(result.error, 'Unknown unzip error');
  });

  it('restores files from a real archive and cleans up the temp dir via fs.rmSync', async () => {
    const created = await createBackup();
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

describe('backup-service — dry-run state round-trips (#531)', () => {
  // Dry-run state used to live at <app root>/dry-run-state.json, outside the
  // data directory: never archived, never restored, and lost on every container
  // recreate. Now that it is a per-fund artifact it must survive the round trip
  // like every other one.
  const fundDir = path.join(DATA_DIR, '__backup_dryrun__', 'BTC-USD');
  const stateFile = path.join(fundDir, 'dry-run-state.json');
  const payload = { version: 1, state: { isDryRun: true, position: { totalAsset: 0.25, totalCostBasis: 12345 }, savedAt: 1 } };
  const createdBackups = [];

  beforeEach(() => {
    fs.mkdirSync(fundDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(payload));
  });

  afterEach(() => {
    removeAll([path.join(DATA_DIR, '__backup_dryrun__')]);
    for (const filename of createdBackups.splice(0)) {
      deleteBackup(filename);
    }
  });

  it('archives the per-fund state file and restores the simulated position', async () => {
    const created = await createBackup();
    assert.equal(created.success, true);
    createdBackups.push(created.filename);

    const entries = listZipEntries(path.join(BACKUP_DIR, created.filename));
    assert.ok(
      entries.includes('__backup_dryrun__/BTC-USD/dry-run-state.json'),
      `archive should contain the per-fund dry-run state, got: ${entries.join(', ')}`
    );

    // Wipe the fund the way a container recreate would, then restore.
    fs.rmSync(path.join(DATA_DIR, '__backup_dryrun__'), { recursive: true, force: true });
    assert.equal(fs.existsSync(stateFile), false);

    const restored = restoreBackup(created.filename);
    assert.equal(restored.success, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), payload);
  });
});

describe('backup-service — credential exclusion', () => {
  const topLevelKeys = path.join(DATA_DIR, '__backup_service_test_coinbase-keys.json');
  const subDir = path.join(DATA_DIR, '__backup_service_test_gemini__');
  const nestedKeys = path.join(subDir, 'gemini-keys.json');
  const nestedState = path.join(subDir, 'state.json');
  const rootCredentials = {
    operatorAuth: path.join(DATA_DIR, 'operator-auth.json'),
    providers: path.join(DATA_DIR, 'providers.json'),
    bootstrap: path.join(DATA_DIR, 'operator-bootstrap-secret'),
    config: path.join(DATA_DIR, 'config.json'),
  };
  const createdBackups = [];

  beforeEach(() => {
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(TEST_FILE, JSON.stringify({ marker: 'backup-service-test' }));
    fs.writeFileSync(topLevelKeys, JSON.stringify({ apiKey: 'top-secret' }));
    fs.writeFileSync(nestedKeys, JSON.stringify({ apiKey: 'nested-secret' }));
    fs.writeFileSync(nestedState, JSON.stringify({ marker: 'nested-state' }));
    fs.writeFileSync(rootCredentials.operatorAuth, JSON.stringify({ hash: 'operator-secret' }));
    fs.writeFileSync(rootCredentials.providers, JSON.stringify({ providers: { openai: { apiKey: 'provider-secret' } } }));
    fs.writeFileSync(rootCredentials.bootstrap, 'bootstrap-secret');
    fs.writeFileSync(rootCredentials.config, JSON.stringify({ global: { notifications: { telegram: { botToken: 'telegram-secret' } } } }));
  });

  afterEach(() => {
    cleanupTestFile();
    removeAll([topLevelKeys, subDir, ...Object.values(rootCredentials)]);
    for (const filename of createdBackups.splice(0)) {
      deleteBackup(filename);
    }
  });

  it('omits top-level and nested *-keys.json files from the archive', async () => {
    const result = await createBackup();
    assert.equal(result.success, true);
    createdBackups.push(result.filename);

    const entries = listZipEntries(path.join(BACKUP_DIR, result.filename));
    assert.ok(!entries.some(e => e.endsWith('-keys.json')), `archive should not contain any *-keys.json entries, got: ${entries.join(', ')}`);

    // Non-key files in the same locations must still be archived.
    assert.ok(entries.includes(path.basename(TEST_FILE)));
    assert.ok(entries.some(e => e.endsWith('__backup_service_test_gemini__/state.json')));
  });

  it('omits operator and provider credentials plus live config from the archive', async () => {
    const result = await createBackup();
    assert.equal(result.success, true);
    createdBackups.push(result.filename);

    const archivePath = path.join(BACKUP_DIR, result.filename);
    const entries = listZipEntries(archivePath);
    for (const entry of ['operator-auth.json', 'providers.json', 'operator-bootstrap-secret', 'config.json']) {
      assert.ok(!entries.includes(entry), `archive should not contain ${entry}, got: ${entries.join(', ')}`);
    }

    const archiveContents = spawnSync('unzip', ['-p', archivePath]).stdout.toString();
    assert.equal(archiveContents.includes('telegram-secret'), false, 'Telegram bot tokens must not enter the archive');
    assert.ok(entries.includes('backup-manifest.json'), 'archive should still carry portable manifest data');
  });

  it('omits the backups directory itself from the archive', async () => {
    const result = await createBackup();
    assert.equal(result.success, true);
    createdBackups.push(result.filename);

    const entries = listZipEntries(path.join(BACKUP_DIR, result.filename));
    assert.ok(!entries.some(e => e === 'backups' || e.startsWith('backups/')), `archive should not contain the backups dir, got: ${entries.join(', ')}`);
  });
});

describe('backup-service — restoreBackup preserves existing credentials', () => {
  const liveKeys = path.join(DATA_DIR, '__backup_service_test_coinbase-keys.json');
  const liveCredentials = {
    operatorAuth: path.join(DATA_DIR, 'operator-auth.json'),
    providers: path.join(DATA_DIR, 'providers.json'),
    bootstrap: path.join(DATA_DIR, 'operator-bootstrap-secret'),
    config: path.join(DATA_DIR, 'config.json'),
  };
  const restoreState = path.join(DATA_DIR, '__backup_service_test_restore_state.json');
  let sourceDir;
  let craftedFilename;

  beforeEach(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    // The live "existing" key on disk before restore runs.
    fs.writeFileSync(liveKeys, JSON.stringify({ apiKey: 'live-key-must-survive' }));
    fs.writeFileSync(liveCredentials.operatorAuth, '{"hash":"live-operator-auth"}');
    fs.writeFileSync(liveCredentials.providers, '{"providers":{"openai":{"apiKey":"live-provider-key"}}}');
    fs.writeFileSync(liveCredentials.bootstrap, 'live-bootstrap-secret');
    fs.writeFileSync(liveCredentials.config, '{"global":{"notifications":{"telegram":{"botToken":"live-telegram-token"}}}}');

    // Craft an archive directly with `zip` (bypassing createBackup's own
    // excludes) so this test exercises restoreBackup's independent
    // defense-in-depth skip of credential files, not createBackup's exclusion.
    sourceDir = fs.mkdtempSync(path.join(DATA_DIR, '.restore-source-'));
    fs.writeFileSync(path.join(sourceDir, '__backup_service_test_coinbase-keys.json'), JSON.stringify({ apiKey: 'archive-key-must-not-land' }));
    fs.writeFileSync(path.join(sourceDir, 'operator-auth.json'), '{"hash":"archive-operator-auth-must-not-land"}');
    fs.writeFileSync(path.join(sourceDir, 'providers.json'), '{"providers":{"openai":{"apiKey":"archive-provider-key-must-not-land"}}}');
    fs.writeFileSync(path.join(sourceDir, 'operator-bootstrap-secret'), 'archive-bootstrap-must-not-land');
    fs.writeFileSync(path.join(sourceDir, 'config.json'), '{"global":{"notifications":{"telegram":{"botToken":"archive-telegram-must-not-land"}}}}');
    fs.writeFileSync(path.join(sourceDir, '__backup_service_test_restore_state.json'), JSON.stringify({ marker: 'restored-from-archive' }));

    craftedFilename = `backup-${Date.now()}-crafted.zip`;
    const zipResult = spawnSync('zip', ['-r', '-q', path.join(BACKUP_DIR, craftedFilename), '.'], { cwd: sourceDir });
    assert.equal(zipResult.status, 0, zipResult.stderr?.toString());
  });

  afterEach(() => {
    removeAll([liveKeys, restoreState, sourceDir, path.join(BACKUP_DIR, craftedFilename), ...Object.values(liveCredentials)]);
  });

  it('leaves on-disk credential files untouched while restoring non-credential files', async () => {
    // The crafted archive has no #430 configuration manifest, so it is a
    // legacy archive: accept it data-only, which is what this test is about.
    const result = restoreBackup(craftedFilename, { acceptLegacyWithoutBase: true });
    assert.equal(result.success, true);

    // Key file on disk must retain its original (live) content.
    const keysOnDisk = JSON.parse(fs.readFileSync(liveKeys, 'utf8'));
    assert.equal(keysOnDisk.apiKey, 'live-key-must-survive');
    assert.equal(fs.readFileSync(liveCredentials.operatorAuth, 'utf8'), '{"hash":"live-operator-auth"}');
    assert.equal(fs.readFileSync(liveCredentials.providers, 'utf8'), '{"providers":{"openai":{"apiKey":"live-provider-key"}}}');
    assert.equal(fs.readFileSync(liveCredentials.bootstrap, 'utf8'), 'live-bootstrap-secret');
    assert.equal(fs.readFileSync(liveCredentials.config, 'utf8'), '{"global":{"notifications":{"telegram":{"botToken":"live-telegram-token"}}}}');

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

  it('rejects filenames containing ".."', async () => {
    const result = deleteBackup('../backup-evil.zip');
    assert.deepEqual(result, { success: false, error: 'Invalid filename' });
  });

  it('rejects filenames containing a path separator', async () => {
    const result = deleteBackup('sub/backup-evil.zip');
    assert.deepEqual(result, { success: false, error: 'Invalid filename' });
  });

  it('rejects absolute paths', async () => {
    const result = deleteBackup('/etc/passwd');
    assert.deepEqual(result, { success: false, error: 'Invalid filename' });
  });

  it('rejects filenames containing a backslash', async () => {
    const result = deleteBackup('backup-evil\\..\\secrets.zip');
    assert.deepEqual(result, { success: false, error: 'Invalid filename' });
  });

  it('rejects filenames that do not match the backup-*.zip format', async () => {
    assert.deepEqual(deleteBackup('notabackup.zip'), { success: false, error: 'Invalid backup filename format' });
    assert.deepEqual(deleteBackup('backup-2026-01-01.tar'), { success: false, error: 'Invalid backup filename format' });
  });

  it('returns not-found for a well-formed filename that does not exist', async () => {
    const result = deleteBackup('backup-does-not-exist.zip');
    assert.deepEqual(result, { success: false, error: 'Backup not found' });
  });

  it('rejects symlinks instead of deleting through them', async () => {
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
  it('rejects filenames containing ".."', async () => {
    const result = restoreBackup('../backup-evil.zip');
    assert.deepEqual(result, { success: false, error: 'Invalid filename' });
  });

  it('rejects filenames containing a path separator', async () => {
    const result = restoreBackup('sub/backup-evil.zip');
    assert.deepEqual(result, { success: false, error: 'Invalid filename' });
  });

  it('rejects filenames that do not match the backup-*.zip format', async () => {
    assert.deepEqual(restoreBackup('notabackup.zip'), { success: false, error: 'Invalid backup filename format' });
  });

  it('returns not-found for a well-formed filename that does not exist', async () => {
    const result = restoreBackup('backup-does-not-exist.zip');
    assert.deepEqual(result, { success: false, error: 'Backup not found' });
  });

  it('rejects symlinks instead of extracting through them', async () => {
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
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-backup-retention-'));
    const manifest = path.join(sourceDir, 'backup-manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({ manifestVersion: 1, createdAt: new Date(mtimeMs).toISOString(), config: {} }));
    const result = spawnSync('zip', ['-q', filePath, 'backup-manifest.json'], { cwd: sourceDir });
    fs.rmSync(sourceDir, { recursive: true, force: true });
    assert.equal(result.status, 0);
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

  it('deletes only the oldest archives beyond maxBackups, keeping the newest', async () => {
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

  it('prunes nothing when the backup count is within the retention limit', async () => {
    const totalBackups = listBackups().length;
    assert.equal(totalBackups, 5);

    const result = pruneBackups(totalBackups);
    assert.equal(result.pruned, 0);
    assert.equal(result.remaining, totalBackups);
    assert.equal(listBackups().length, 5);
  });

  it('ignores corrupt matching archives when listing and pruning', async () => {
    const corrupt = path.join(BACKUP_DIR, `backup-${prefix}-corrupt.zip`);
    fs.writeFileSync(corrupt, 'partial archive');
    created.push(corrupt);
    assert.equal(listBackups().some(backup => backup.filename.endsWith('-corrupt.zip')), false);
    const result = pruneBackups(5);
    assert.equal(result.pruned, 0);
    assert.equal(fs.existsSync(corrupt), true);
  });

  // #547: a route bug or hand-edited config.json can persist an invalid
  // maxBackups. pruneBackups must fall back to the default retain count
  // rather than deleting every archive on `slice(0)`/`slice(null)`-style bugs.
  const invalidMaxBackupsCases = [
    { label: '0', value: 0 },
    { label: 'null', value: null },
    { label: '-1', value: -1 },
    { label: 'a non-number ("5")', value: '5' },
    { label: 'NaN', value: NaN },
    { label: 'a non-integer (2.5)', value: 2.5 },
  ];

  for (const { label, value } of invalidMaxBackupsCases) {
    it(`falls back to the default retain count instead of deleting everything when maxBackups is ${label}`, async () => {
      assert.equal(listBackups().length, 5);

      // Fixture has 5 backups, well under the default retain count (7), so a
      // correct fallback deletes NOTHING here — a raw `slice(0)`/`slice(null)`
      // bug would instead have wiped out all 5.
      assert.ok(GLOBAL_DEFAULTS.backup.maxBackups > 5, 'fixture assumes the default retain count exceeds the 5 seeded backups');

      const result = pruneBackups(value);
      assert.equal(result.pruned, 0);
      assert.equal(result.remaining, 5);
      assert.equal(listBackups().length, 5);
    });
  }
});
