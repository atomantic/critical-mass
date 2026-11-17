const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Every scripts/*.js guarded by `require.main === module` must load without
// throwing (catches stale imports of removed exports). Loading happens in a
// child process so any import-time side effect cannot touch this process.
// Scripts that run on import (no guard) are listed here with the reason.
const EXECUTES_ON_IMPORT = {};

const scriptsDir = path.join(__dirname, '..', 'scripts');
const guarded = fs.readdirSync(scriptsDir)
  .filter((name) => name.endsWith('.js'))
  .filter((name) => /require\.main\s*===\s*module/.test(fs.readFileSync(path.join(scriptsDir, name), 'utf8')))
  .filter((name) => !(name in EXECUTES_ON_IMPORT))
  .sort();

describe('scripts load', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scripts-load-'));
  after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it('finds guarded scripts to check', () => {
    assert.ok(guarded.length > 0);
  });

  for (const name of guarded) {
    it(`${name} loads without throwing`, () => {
      const file = path.join(scriptsDir, name);
      const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(file)})`], {
        encoding: 'utf8',
        timeout: 30000,
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, CRITICAL_MASS_DATA_DIR: dataDir },
      });
      assert.equal(result.status, 0, `${name} failed to load:\n${result.stderr}`);
    });
  }
});
