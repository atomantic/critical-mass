// @ts-check
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// issue #688 — deleting a Coinbase API key was silently undone:
//  - needsKeysMigration() checked for a file (`coinbase.json`) that
//    migrateKeys() never wrote (it writes `coinbase-keys.json`), so it
//    returned `true` forever and every startup re-copied the root
//    `keys.json` back into `data/coinbase-keys.json`, even after an
//    operator deleted it via the API.
//  - migrateKeys() also left the copy at the source file's mode (0644),
//    unlike the 0600 `writeJSON` normally uses for secrets.
//
// All fixtures live under fs.mkdtempSync — nothing here ever touches the
// repository's real `keys.json` or `data/*-keys.json`, in this worktree or
// any other. `pathsModule.APP_ROOT` / `pathsModule.DATA_DIR` are mutated to
// point into the temp directory (mirroring the pattern in
// tests/migration-pair-layout.test.js) and `src/migration.js` is re-required
// fresh so its module-level path constants pick up the mutated values.

const migrationPath = require.resolve('../src/migration');
const pathsModule = require('../src/paths');

const originalAppRoot = pathsModule.APP_ROOT;
const originalDataDir = pathsModule.DATA_DIR;

/** @type {string|null} */
let tmpDir = null;
/** @type {any} */
let migration = null;

const freshMigration = (appRoot) => {
  pathsModule.APP_ROOT = appRoot;
  pathsModule.DATA_DIR = path.join(appRoot, 'data');
  delete require.cache[migrationPath];
  return require('../src/migration');
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-keys-test-'));
  migration = freshMigration(tmpDir);
});

afterEach(() => {
  mock.restoreAll();
  pathsModule.APP_ROOT = originalAppRoot;
  pathsModule.DATA_DIR = originalDataDir;
  delete require.cache[migrationPath];
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
  migration = null;
});

const rootKeysFile = () => path.join(tmpDir, 'keys.json');
const migratedKeysFile = () => `${rootKeysFile()}.migrated`;
const newKeysFile = () => path.join(tmpDir, 'data', 'coinbase-keys.json');

const FAKE_KEYS = JSON.stringify({ name: 'fake-key-name', privateKey: 'fake-private-key-not-real' });

describe('needsKeysMigration (issue #688)', () => {
  it('is false when data/coinbase-keys.json already exists alongside a root keys.json', () => {
    fs.writeFileSync(rootKeysFile(), FAKE_KEYS);
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    fs.writeFileSync(newKeysFile(), FAKE_KEYS);

    // Before the fix this checked for `data/coinbase.json` (a file
    // migrateKeys never writes), so it returned true regardless of whether
    // data/coinbase-keys.json existed.
    assert.equal(migration.needsKeysMigration(), false);
  });

  it('is true when only a root keys.json exists', () => {
    fs.writeFileSync(rootKeysFile(), FAKE_KEYS);
    assert.equal(migration.needsKeysMigration(), true);
  });

  it('is false when no root keys.json exists', () => {
    assert.equal(migration.needsKeysMigration(), false);
  });
});

describe('migrateKeys (issue #688)', () => {
  it('copies the root key to data/coinbase-keys.json with mode 0600, regardless of the source mode', () => {
    fs.writeFileSync(rootKeysFile(), FAKE_KEYS);
    fs.chmodSync(rootKeysFile(), 0o644);

    const migrated = migration.migrateKeys();

    assert.equal(migrated, true);
    assert.ok(fs.existsSync(newKeysFile()), 'data/coinbase-keys.json must be created');
    assert.equal(fs.readFileSync(newKeysFile(), 'utf8'), FAKE_KEYS);
    const mode = fs.statSync(newKeysFile()).mode & 0o777;
    assert.equal(mode, 0o600, `expected mode 0600, got ${mode.toString(8)}`);
  });

  it('renames the root keys.json to keys.json.migrated so the migration cannot run twice', () => {
    fs.writeFileSync(rootKeysFile(), FAKE_KEYS);

    migration.migrateKeys();

    assert.ok(!fs.existsSync(rootKeysFile()), 'root keys.json must be renamed away');
    assert.ok(fs.existsSync(migratedKeysFile()), 'keys.json.migrated must exist');
    assert.equal(fs.readFileSync(migratedKeysFile(), 'utf8'), FAKE_KEYS);
  });
});

describe('runMigrationIfNeeded — deleting a migrated key must not resurrect it (issue #688)', () => {
  it('does not recreate data/coinbase-keys.json after it is deleted and the engine restarts', () => {
    fs.writeFileSync(rootKeysFile(), FAKE_KEYS);

    // First "startup": migrates the legacy key.
    const first = migration.runMigrationIfNeeded();
    assert.equal(first.keysMigrated, true);
    assert.ok(fs.existsSync(newKeysFile()));
    assert.ok(!fs.existsSync(rootKeysFile()), 'root keys.json must be gone after migration');

    // Operator deletes the key via the API (DELETE /api/coinbase/keys).
    fs.rmSync(newKeysFile());
    assert.ok(!fs.existsSync(newKeysFile()));

    // Second "startup": must NOT resurrect the deleted key.
    const second = migration.runMigrationIfNeeded();
    assert.equal(second.keysMigrated, false, 'a second run must not re-migrate');
    assert.ok(!fs.existsSync(newKeysFile()), 'data/coinbase-keys.json must stay deleted');
  });
});

describe('migrateKeys — degrades gracefully on a mid-sequence filesystem failure (issue #688)', () => {
  it('returns false and does not throw when the rename step fails, leaving the root file in place for a retry', () => {
    fs.writeFileSync(rootKeysFile(), FAKE_KEYS);

    mock.method(fs, 'renameSync', () => {
      throw new Error('EPERM: simulated rename failure');
    });

    assert.doesNotThrow(() => {
      const migrated = migration.migrateKeys();
      assert.equal(migrated, false);
    });

    // The copy already landed before the simulated failure — that's fine,
    // the root file staying in place is what makes the next call retry.
    assert.ok(fs.existsSync(newKeysFile()), 'the copy should have completed before the rename failed');
    assert.ok(fs.existsSync(rootKeysFile()), 'root keys.json must stay in place after a failed rename, for the next retry');
    assert.ok(!fs.existsSync(migratedKeysFile()), 'keys.json.migrated must not exist when the rename failed');
  });

  it('runMigrationIfNeeded reports keysMigrated: false when the copy itself fails (codex review finding)', () => {
    fs.writeFileSync(rootKeysFile(), FAKE_KEYS);

    mock.method(fs, 'copyFileSync', () => {
      throw new Error('ENOSPC: simulated copy failure');
    });

    const result = migration.runMigrationIfNeeded();

    // Before this fix, runMigrationIfNeeded() set keysMigrated: true
    // unconditionally whenever needsKeysMigration() was true, regardless of
    // whether migrateKeys() actually succeeded — so a caller would believe
    // the credential was migrated when nothing was copied at all.
    assert.equal(result.keysMigrated, false, 'must reflect that no key was actually copied');
    assert.ok(!fs.existsSync(newKeysFile()), 'no key file should exist after a failed copy');
  });
});

describe('backfillKeysFilePermissions (issue #688)', () => {
  it('chmods an already-migrated data/coinbase-keys.json to 0600, even from a pre-#688 install', () => {
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    fs.writeFileSync(newKeysFile(), FAKE_KEYS);
    fs.chmodSync(newKeysFile(), 0o644); // simulates the old copyFileSync-with-no-chmod behavior

    migration.backfillKeysFilePermissions();

    const mode = fs.statSync(newKeysFile()).mode & 0o777;
    assert.equal(mode, 0o600, `expected mode 0600, got ${mode.toString(8)}`);
  });

  it('is a no-op when data/coinbase-keys.json does not exist', () => {
    assert.doesNotThrow(() => migration.backfillKeysFilePermissions());
    assert.ok(!fs.existsSync(newKeysFile()));
  });

  it('runMigrationIfNeeded backfills permissions on an already-migrated install without re-migrating', () => {
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    fs.writeFileSync(newKeysFile(), FAKE_KEYS);
    fs.chmodSync(newKeysFile(), 0o644);
    // No root keys.json — this install was already migrated.

    const result = migration.runMigrationIfNeeded();

    assert.equal(result.keysMigrated, false, 'must not report a re-migration');
    const mode = fs.statSync(newKeysFile()).mode & 0o777;
    assert.equal(mode, 0o600, 'existing key file must be backfilled to 0600');
  });
});

describe('retireLegacyKeysFileIfAlreadyMigrated — codex review finding (issue #688)', () => {
  // A pre-#688 build copied keys.json -> data/coinbase-keys.json but never
  // renamed the root file away ("don't delete original for safety"), so an
  // install migrated by that code has BOTH files present. Without this
  // reconciliation step, deleting data/coinbase-keys.json on such an
  // install would make needsKeysMigration() true again (the still-present
  // root file looks like a pending migration) and resurrect the deleted
  // key on the next startup — the exact bug this issue fixes, from a
  // different starting state.

  it('renames the root keys.json away the moment both files are found to coexist', () => {
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    fs.writeFileSync(rootKeysFile(), FAKE_KEYS);   // pre-#688 install: never renamed
    fs.writeFileSync(newKeysFile(), FAKE_KEYS);    // ...but already copied

    migration.retireLegacyKeysFileIfAlreadyMigrated();

    assert.ok(!fs.existsSync(rootKeysFile()), 'root keys.json must be retired once the copy is confirmed to exist');
    assert.ok(fs.existsSync(migratedKeysFile()), 'keys.json.migrated must exist');
  });

  it('is a no-op when only the root file exists (a real migration is still pending)', () => {
    fs.writeFileSync(rootKeysFile(), FAKE_KEYS);
    // data/coinbase-keys.json deliberately absent.

    migration.retireLegacyKeysFileIfAlreadyMigrated();

    assert.ok(fs.existsSync(rootKeysFile()), 'must not touch the root file while migration is still pending');
  });

  it('is a no-op when neither file exists', () => {
    assert.doesNotThrow(() => migration.retireLegacyKeysFileIfAlreadyMigrated());
  });

  it('end-to-end: a pre-#688 install survives an operator deleting the key, across a simulated restart', () => {
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    fs.writeFileSync(rootKeysFile(), FAKE_KEYS);   // simulates a pre-#688 install's leftover root file
    fs.writeFileSync(newKeysFile(), FAKE_KEYS);

    // "Startup" on the new build — this is the fix: it must retire the
    // root file even though no fresh migration ran (newKeysFile already
    // existed, so needsKeysMigration() is false and migrateKeys() never fires).
    const first = migration.runMigrationIfNeeded();
    assert.equal(first.keysMigrated, false);
    assert.ok(!fs.existsSync(rootKeysFile()), 'the leftover root file must be retired on first contact with the new build');

    // Operator deletes the key via the API.
    fs.rmSync(newKeysFile());

    // "Restart" — must NOT resurrect the deleted key, because the root
    // file is already gone.
    const second = migration.runMigrationIfNeeded();
    assert.equal(second.keysMigrated, false, 'a second run must not re-migrate');
    assert.ok(!fs.existsSync(newKeysFile()), 'data/coinbase-keys.json must stay deleted');
  });
});
