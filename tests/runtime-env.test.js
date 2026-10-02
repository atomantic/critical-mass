const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const fixtureSecret = 'fixture-only-bootstrap-secret-1234567890';
const fixtureEnv = [
  'OPERATOR_BOOTSTRAP_SECRET=' + fixtureSecret,
  'AI_ALLOWED_ENDPOINTS=https://fixture.invalid',
  'HOST=127.0.0.1',
  'CORS_ORIGINS=https://fixture.invalid',
  'PORT=5580',
].join('\n');

function fixture(t, contents = fixtureEnv) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-env-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of ['src/runtime-env.js', 'ecosystem.config.cjs', 'server.js', 'index.js', 'scripts/dev.js']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(repo, file), path.join(root, file));
  }
  if (contents !== null) fs.writeFileSync(path.join(root, '.env'), contents);
  return root;
}

// Scrub inherited settings and run outside the repository; never import live app state.
function run(root, code, env = {}) {
  return spawnSync(process.execPath, ['-e', code], {
    cwd: os.tmpdir(),
    env: { ...env, FIXTURE_ROOT: root },
    encoding: 'utf8',
    timeout: 10000,
  });
}

const load = "require(process.env.FIXTURE_ROOT + '/src/runtime-env').loadRuntimeEnv()";

test('loads root .env from another cwd and preserves inherited values, including empty strings', t => {
  const root = fixture(t);
  const result = run(root, `
    const assert = require('node:assert/strict');
    assert.equal(${load}, true);
    assert.equal(process.env.OPERATOR_BOOTSTRAP_SECRET, ${JSON.stringify(fixtureSecret)});
    assert.equal(process.env.AI_ALLOWED_ENDPOINTS, 'https://inherited.invalid');
    assert.equal(process.env.HOST, '');
    assert.equal(process.env.PORT, '5580');
  `, { AI_ALLOWED_ENDPOINTS: 'https://inherited.invalid', HOST: '' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('missing .env preserves externally injected container settings', t => {
  const root = fixture(t, null);
  const result = run(root, `
    const assert = require('node:assert/strict');
    assert.equal(${load}, false);
    const config = require(process.env.FIXTURE_ROOT + '/ecosystem.config.cjs');
    assert.equal(config.apps[0].env.OPERATOR_BOOTSTRAP_SECRET, 'injected');
    assert.equal(process.env.AI_ALLOWED_ENDPOINTS, 'https://injected.invalid');
    assert.equal(process.env.HOST, undefined);
  `, { OPERATOR_BOOTSTRAP_SECRET: 'injected', AI_ALLOWED_ENDPOINTS: 'https://injected.invalid' });
  assert.equal(result.status, 0, result.stderr);
});

test('PM2 captures bootstrap settings after loading .env and retains service ports', t => {
  const root = fixture(t);
  const result = run(root, `
    const assert = require('node:assert/strict');
    const config = require(process.env.FIXTURE_ROOT + '/ecosystem.config.cjs');
    for (const env of [config.apps[0].env, config.apps[0].env_production]) {
      assert.equal(env.OPERATOR_BOOTSTRAP_SECRET, ${JSON.stringify(fixtureSecret)});
      assert.equal(env.PORT, 5570);
    }
    assert.equal(process.env.AI_ALLOWED_ENDPOINTS, 'https://fixture.invalid');
  `);
  assert.equal(result.status, 0, result.stderr);
});

test('development children inherit root settings before their environments are built', t => {
  const root = fixture(t);
  const vite = path.join(root, 'admin/node_modules/vite');
  fs.mkdirSync(vite, { recursive: true });
  fs.writeFileSync(path.join(vite, 'package.json'), '{"name":"vite"}');
  const result = run(root, `
    const assert = require('node:assert/strict');
    const { developmentChildren } = require(process.env.FIXTURE_ROOT + '/scripts/dev');
    for (const child of developmentChildren()) {
      assert.equal(child.env.OPERATOR_BOOTSTRAP_SECRET, ${JSON.stringify(fixtureSecret)});
      assert.equal(child.env.AI_ALLOWED_ENDPOINTS, 'https://fixture.invalid');
      assert.equal(child.env.VITE_API_PORT, '5570');
    }
  `);
  assert.equal(result.status, 0, result.stderr);
});

for (const entry of ['server.js', 'index.js']) {
  test(entry + ' loads settings before any application dependency executes', t => {
    const root = fixture(t);
    const result = run(root, `
      const assert = require('node:assert/strict');
      const Module = require('node:module');
      const original = Module._load;
      const entry = process.env.FIXTURE_ROOT + '/${entry}';
      const stopped = new Error('fixture stop');
      let checked = false;
      Module._load = function(request, parent, ...args) {
        if (parent?.filename === entry && request !== './src/runtime-env') {
          assert.equal(process.env.OPERATOR_BOOTSTRAP_SECRET, ${JSON.stringify(fixtureSecret)});
          assert.equal(process.env.AI_ALLOWED_ENDPOINTS, 'https://fixture.invalid');
          assert.equal(process.env.CORS_ORIGINS, 'https://fixture.invalid');
          assert.equal(process.env.HOST, '127.0.0.1');
          checked = true;
          throw stopped; // No application dependencies, migrations, listeners or trading.
        }
        return original.call(this, request, parent, ...args);
      };
      assert.throws(() => require(entry), error => error === stopped);
      assert.equal(checked, true);
    `);
    assert.equal(result.status, 0, result.stderr);
  });
}

test('unreadable file errors are actionable and never include original error values', t => {
  const root = fixture(t);
  const result = run(root, `
    const assert = require('node:assert/strict');
    process.loadEnvFile = () => {
      const error = new Error(${JSON.stringify(fixtureSecret)});
      error.code = 'EACCES';
      throw error;
    };
    try { ${load}; process.exit(2); }
    catch (error) {
      assert.equal(error.cause, undefined);
      console.error(error.message);
    }
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /repository-root \.env.*readable file/);
  assert.equal(result.stderr.includes(fixtureSecret), false);
  assert.equal(result.stdout, '');
});

test('non-file .env fails startup instead of silently using defaults', t => {
  const root = fixture(t, null);
  fs.mkdirSync(path.join(root, '.env'));
  const result = run(root, load);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unable to load the repository-root \.env/);
  assert.equal(result.stderr.includes(fixtureSecret), false);
});
