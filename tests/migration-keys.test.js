// @ts-check
const { describe, it, beforeEach, afterEach } = require('node:test');
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
