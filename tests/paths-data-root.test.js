// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { resolveDataDir, APP_ROOT, DATA_DIR } = require('../src/paths');

describe('paths.resolveDataDir', () => {
  it('defaults to <repo>/data outside a test context', () => {
    assert.equal(resolveDataDir({}), path.join(APP_ROOT, 'data'));
  });

  it('honours CRITICAL_MASS_DATA_DIR', () => {
    const dir = path.join(os.tmpdir(), 'cm-x', 'data');
    assert.equal(resolveDataDir({ CRITICAL_MASS_DATA_DIR: dir }), dir);
    assert.equal(resolveDataDir({ CRITICAL_MASS_DATA_DIR: dir, NODE_TEST_CONTEXT: 'child-v8' }), dir);
  });

  it('refuses the repo data dir under node --test, naming the redirect', () => {
    assert.throws(() => resolveDataDir({ NODE_TEST_CONTEXT: 'child-v8' }), /createIsolatedDataDir/);
    assert.throws(
      () => resolveDataDir({ NODE_TEST_CONTEXT: '1', CRITICAL_MASS_DATA_DIR: path.join(APP_ROOT, 'data', 'x') }),
      /Refusing to resolve DATA_DIR/,
    );
  });

  it('the suite itself runs against a data root outside the checkout', () => {
    const rel = path.relative(APP_ROOT, DATA_DIR);
    assert.ok(rel.startsWith('..') || path.isAbsolute(rel), `DATA_DIR ${DATA_DIR} is inside the checkout`);
  });

  it('production-style startup (no test context) resolves <repo>/data', () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.CRITICAL_MASS_DATA_DIR;
    const r = spawnSync(process.execPath, ['-e', "process.stdout.write(require('./src/paths').DATA_DIR)"], { cwd: APP_ROOT, env, encoding: 'utf8' });
    assert.equal(r.stdout, path.join(APP_ROOT, 'data'));
  });
});
