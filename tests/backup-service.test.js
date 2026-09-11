// @ts-check
// Covers issue #396: missing zip/unzip binaries must surface a real error
// (not "Unknown zip error"), and temp-dir cleanup must use fs.rmSync
// instead of shelling out to /bin/rm.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  createBackup,
  listBackups,
  deleteBackup,
  restoreBackup,
} = require('../src/backup-service');
const { DATA_DIR } = require('../src/paths');

// Isolate this suite's fixture files from any real data under DATA_DIR.
const TEST_FILE = path.join(DATA_DIR, '__backup_service_test__.json');
const originalPath = process.env.PATH;

const cleanupTestFile = () => {
  if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
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
