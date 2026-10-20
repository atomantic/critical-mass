// All files are synthetic; no engine, exchange, or live configuration is used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { reconcileBaseConfig, BASE_SNAPSHOT_FILENAME, CONFIG_LOCK_DIR, withConfigWriteLock } = require('../src/config-base-drift');
const { computeDiff, deepMerge } = require('../src/config-utils');

const fixture = (t, base = { regime: { maxDrawdownPercent: 50, maxCelestialBodies: 20 }, dryRun: true }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-base-drift-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  const baseConfigFile = path.join(root, 'base.json');
  const userFile = path.join(dataDir, 'config.json');
  const snapshotFile = path.join(dataDir, BASE_SNAPSHOT_FILENAME);
  const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
  const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
  const warnings = [];
  const options = { dataDir, baseConfigFile, logger: { warn: (...args) => warnings.push(args) } };
  write(baseConfigFile, base);
  return { ...options, root, options, userFile, snapshotFile, write, read, warnings, base };
};

test('first startup snapshots full base without creating or rewriting an override', (t) => {
  const f = fixture(t);
  reconcileBaseConfig(f.options);
  assert.deepEqual(f.read(f.snapshotFile), f.base);
  assert.equal(fs.existsSync(f.userFile), false);
  assert.equal(fs.statSync(f.snapshotFile).mode & 0o777, 0o600);
  fs.chmodSync(f.snapshotFile, 0o644);
  reconcileBaseConfig(f.options);
  assert.equal(fs.statSync(f.snapshotFile).mode & 0o777, 0o600);
  fs.writeFileSync(f.userFile, '{ "dryRun": false }\n');
  const before = fs.readFileSync(f.userFile, 'utf8');
  reconcileBaseConfig(f.options);
  assert.equal(fs.readFileSync(f.userFile, 'utf8'), before);
});

test('upgrade pins changed absent defaults and preserves explicit/unchanged keys', (t) => {
  const f = fixture(t);
  f.write(f.userFile, computeDiff(f.base, { ...f.base, regime: { ...f.base.regime, maxCelestialBodies: 7 } }));
  reconcileBaseConfig(f.options);
  const next = { regime: { maxDrawdownPercent: 20, maxCelestialBodies: 10 }, dryRun: true, added: 1 };
  f.write(f.baseConfigFile, next);
  const result = reconcileBaseConfig(f.options);
  assert.deepEqual(result.pins.map(p => p.key), ['regime.maxDrawdownPercent']);
  assert.deepEqual(f.read(f.userFile), { regime: { maxDrawdownPercent: 50, maxCelestialBodies: 7 } });
  assert.equal(deepMerge(next, f.read(f.userFile)).regime.maxDrawdownPercent, 50);
  assert.match(f.warnings[0][0], /regime.maxDrawdownPercent: 50 -> 20 default, pinned/);
  assert.deepEqual(f.read(f.snapshotFile), next);
  assert.deepEqual(reconcileBaseConfig(f.options).pins, []);
  assert.equal(f.warnings.length, 1);
});

test('array, removed, null, false and structural defaults remain effective', (t) => {
  const f = fixture(t, { array: [1, 2], gone: 4, flag: false, nil: null, tree: { a: 1, b: 2 }, masked: { n: 1 }, leaf: 5, empty: {} });
  f.write(f.userFile, { tree: { a: 9 }, masked: null });
  reconcileBaseConfig(f.options);
  const next = { array: [3], flag: true, nil: 1, tree: null, masked: { n: 2 }, leaf: { nested: 1 }, empty: 0 };
  f.write(f.baseConfigFile, next);
  reconcileBaseConfig(f.options);
  assert.deepEqual(deepMerge(next, f.read(f.userFile)), { ...f.base, tree: { a: 9, b: 2 }, masked: null });
});

test('no changed absent keys means no override rewrite, even when snapshot advances', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.userFile, '{ "regime": {"maxDrawdownPercent": 9} }\n');
  reconcileBaseConfig(f.options);
  const before = fs.readFileSync(f.userFile, 'utf8');
  f.write(f.baseConfigFile, { ...f.base, regime: { ...f.base.regime, maxDrawdownPercent: 20 } });
  reconcileBaseConfig(f.options);
  assert.equal(fs.readFileSync(f.userFile, 'utf8'), before);
});

for (const target of ['userFile', 'snapshotFile']) {
  test(`corrupt ${target} fails closed without rewriting either file`, (t) => {
    const f = fixture(t);
    f.write(f.userFile, {});
    reconcileBaseConfig(f.options);
    f.write(f.baseConfigFile, { regime: { maxDrawdownPercent: 20 } });
    fs.writeFileSync(f[target], '{"secret":"DO_NOT_LOG",');
    const before = [f.userFile, f.snapshotFile].map(file => fs.readFileSync(file, 'utf8'));
    assert.throws(() => reconcileBaseConfig(f.options), error => !error.stack.includes('DO_NOT_LOG'));
    assert.deepEqual([f.userFile, f.snapshotFile].map(file => fs.readFileSync(file, 'utf8')), before);
    assert.equal(fs.existsSync(path.join(f.dataDir, CONFIG_LOCK_DIR)), false);
  });
}

test('unreadable base skips reconciliation and can retry after repair', (t) => {
  const f = fixture(t);
  reconcileBaseConfig(f.options);
  fs.writeFileSync(f.baseConfigFile, '{');
  assert.equal(reconcileBaseConfig(f.options).skipped, true);
  assert.deepEqual(f.read(f.snapshotFile), f.base);
  assert.equal(fs.existsSync(f.userFile), false);
  f.write(f.baseConfigFile, { ...f.base, dryRun: false });
  assert.equal(reconcileBaseConfig(f.options).pins.length, 1);
});

test('invalid object shapes are refused and secret values are redacted from warnings', (t) => {
  const f = fixture(t, { global: { notifications: { botToken: 'old-secret' } } });
  reconcileBaseConfig(f.options);
  f.write(f.userFile, []);
  assert.throws(() => reconcileBaseConfig(f.options));
  f.write(f.userFile, {});
  f.write(f.baseConfigFile, { global: { notifications: { botToken: 'new-secret' } } });
  reconcileBaseConfig(f.options);
  assert.equal(JSON.stringify(f.warnings).includes('old-secret'), false);
  assert.equal(JSON.stringify(f.warnings).includes('new-secret'), false);
});

test('a live or abandoned lock is never stolen', (t) => {
  const f = fixture(t);
  const lock = path.join(f.dataDir, CONFIG_LOCK_DIR);
  fs.mkdirSync(lock);
  const old = new Date(0);
  fs.utimesSync(lock, old, old);
  assert.throws(() => withConfigWriteLock(f.dataDir, () => assert.fail('must not run'), 0), /lock busy/);
  assert.equal(fs.existsSync(lock), true);
});

test('interrupted snapshot publication replays durable override without losing pins', (t) => {
  const f = fixture(t);
  reconcileBaseConfig(f.options);
  f.write(f.baseConfigFile, { ...f.base, dryRun: false });
  const originalRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === f.snapshotFile) throw new Error('injected snapshot failure');
    return originalRename(from, to);
  });
  assert.throws(() => reconcileBaseConfig(f.options), /injected/);
  assert.deepEqual(f.read(f.userFile), { dryRun: true });
  assert.deepEqual(f.read(f.snapshotFile), f.base);
  t.mock.restoreAll();
  reconcileBaseConfig(f.options);
  assert.equal(deepMerge(f.read(f.baseConfigFile), f.read(f.userFile)).dryRun, true);
  assert.deepEqual(fs.readdirSync(f.dataDir).sort(), ['config-base.snapshot.json', 'config.json']);
});

test('concurrent processes serialize startup and settings saves', async (t) => {
  const f = fixture(t);
  reconcileBaseConfig(f.options);
  f.write(f.baseConfigFile, { ...f.base, regime: { maxDrawdownPercent: 20, maxCelestialBodies: 10 } });
  const modulePath = require.resolve('../src/config-base-drift');
  const script = `const {reconcileBaseConfig}=require(${JSON.stringify(modulePath)});
    const options=JSON.parse(process.argv[1]); options.logger={warn(){}};
    reconcileBaseConfig(options);
    const paths=require(${JSON.stringify(require.resolve('../src/paths'))}); paths.DATA_DIR=options.dataDir;
    const config=require(${JSON.stringify(require.resolve('../src/config-utils'))});
    const fs=require('fs'); const read=fs.readFileSync; const base=config.resolveBaseConfigFile();
    fs.readFileSync=(file,...args)=>read(file===base?options.baseConfigFile:file,...args);
    config.saveConfig(config.loadRawConfig());`;
  const children = Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, JSON.stringify({ dataDir: f.dataDir, baseConfigFile: f.baseConfigFile })], { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(error)));
  }));
  await Promise.all(children);
  assert.deepEqual(f.read(f.userFile), { regime: f.base.regime });
  assert.deepEqual(f.read(f.snapshotFile), f.read(f.baseConfigFile));
  assert.equal(fs.existsSync(path.join(f.dataDir, CONFIG_LOCK_DIR)), false);
});
