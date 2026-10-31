// @ts-check
/**
 * Lifecycle tests for scripts/test.js (the `npm test` runner). Each case runs
 * the runner against a fixture child inside a private TMPDIR parent so nothing
 * touches the real system temp directory.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { defaultChildArgs, ROOT_PREFIX } = require('../scripts/test');

const REPO_ROOT = path.join(__dirname, '..');

// Fixture child. Modes (argv[2]):
//   leak     - create a file and a directory in TMPDIR, never clean them, exit 0
//   fail     - same, then exit 3
//   hold     - announce READY, wait for the control file `release`, then exit 0
//   graceful - announce READY; on SIGINT/SIGTERM wait 400ms (still running),
//              record whether TMPDIR still exists, then exit 0
//   stubborn - announce READY and ignore SIGINT/SIGTERM
//   descendant[-fail] - exit with an unref'ed listener still in the owned group
const FIXTURE = `
const fs = require('fs');
const path = require('path');
const mode = process.argv[2];
const control = process.argv[3];
const tmp = process.env.TMPDIR;
const ready = () => console.log('READY ' + tmp);
if (mode === 'leak' || mode === 'fail') {
  fs.writeFileSync(path.join(tmp, 'forgotten.txt'), 'x');
  fs.mkdirSync(path.join(tmp, 'forgotten-dir'));
  process.exit(mode === 'fail' ? 3 : 0);
} else if (mode === 'hold') {
  fs.writeFileSync(path.join(tmp, 'fixture.txt'), 'x');
  ready();
  const timer = setInterval(() => {
    if (fs.existsSync(path.join(control, 'release'))) { clearInterval(timer); process.exit(0); }
  }, 20);
} else if (mode === 'graceful') {
  fs.writeFileSync(path.join(tmp, 'fixture.txt'), 'x');
  const stop = () => setTimeout(() => {
    fs.writeFileSync(path.join(control, 'witness'), fs.existsSync(tmp) ? 'root-present' : 'root-gone');
    process.exit(0);
  }, 400);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  setInterval(() => {}, 1000);
  ready();
} else if (mode === 'stubborn') {
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
  ready();
} else if (mode === 'descendant' || mode === 'descendant-fail') {
  const child = require('child_process').spawn(process.execPath, [__filename, 'listener', control], { stdio: 'ignore' });
  child.unref();
  setInterval(() => {
    if (fs.existsSync(path.join(control, 'descendant.json'))) process.exit(mode === 'descendant-fail' ? 3 : 0);
  }, 10);
} else if (mode === 'listener') {
  const server = require('net').createServer();
  server.listen(0, '127.0.0.1', () => {
    // File existence is the parent's readiness signal: publish complete JSON
    // atomically so runner shutdown cannot interrupt the witness write.
    const witness = path.join(control, 'descendant.json');
    fs.writeFileSync(witness + '.tmp', JSON.stringify({ pid: process.pid, port: server.address().port, root: tmp }));
    fs.renameSync(witness + '.tmp', witness);
  });
  setInterval(() => {
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'still-writing'), 'x');
  }, 10);
}
`;

describe('scripts/test.js runner lifecycle', () => {
  /** @type {string} */ let parent;      // private TMPDIR parent for the runners
  /** @type {string} */ let control;     // fixture <-> test control files (outside runner roots)
  /** @type {string} */ let launcher;
  /** @type {Set<import('child_process').ChildProcess>} */ const spawned = new Set();

  beforeEach(() => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-parent-'));
    control = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-control-'));
    fs.writeFileSync(path.join(control, 'fixture.js'), FIXTURE);
    launcher = path.join(control, 'launch.js');
    fs.writeFileSync(launcher, `
      const { runOwned } = require(${JSON.stringify(path.join(REPO_ROOT, 'scripts', 'test.js'))});
      runOwned({
        childArgs: [${JSON.stringify(path.join(control, 'fixture.js'))}, process.argv[2], ${JSON.stringify(control)}],
        killGraceMs: Number(process.env.KILL_GRACE_MS) || 10000,
      }).then((code) => process.exit(code));
    `);
  });

  afterEach(() => {
    for (const proc of spawned) {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* gone */ }
      try { proc.kill('SIGKILL'); } catch { /* gone */ }
    }
    spawned.clear();
    const descendant = path.join(control, 'descendant.json');
    if (fs.existsSync(descendant)) {
      try { process.kill(JSON.parse(fs.readFileSync(descendant, 'utf8')).pid, 'SIGKILL'); } catch { /* gone */ }
    }
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(control, { recursive: true, force: true });
  });

  /** Start the runner; resolves handles for output, readiness and exit. */
  function start(mode, env = {}) {
    const proc = spawn(process.execPath, [launcher, mode], {
      env: { ...process.env, TMPDIR: parent, TMP: parent, TEMP: parent, ...env },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    spawned.add(proc);
    let out = '';
    let notifyReady;
    const ready = new Promise((resolve) => { notifyReady = resolve; });
    proc.stdout.on('data', (chunk) => {
      out += chunk;
      const match = out.match(/READY (\S+)/);
      if (match) notifyReady(match[1]);
    });
    const exit = new Promise((resolve) => proc.on('close', (code, signal) => resolve({ code, signal })));
    return { proc, ready, exit, output: () => out };
  }

  const ownedRoots = () => fs.readdirSync(parent).filter((name) => name.startsWith(ROOT_PREFIX));

  it('removes the owned root after success even when the child forgot its fixtures', async () => {
    const sentinel = path.join(parent, 'pre-existing-fixture');
    fs.mkdirSync(sentinel);
    const run = start('leak');
    assert.deepEqual(await run.exit, { code: 0, signal: null });
    assert.deepEqual(ownedRoots(), []);
    assert.ok(fs.existsSync(sentinel), 'pre-existing temp entries survive');
  });

  it('propagates a nonzero exit status and still removes the owned root', async () => {
    const run = start('fail');
    assert.deepEqual(await run.exit, { code: 3, signal: null });
    assert.deepEqual(ownedRoots(), []);
  });

  for (const [mode, code] of [['descendant', 0], ['descendant-fail', 3]]) {
    it(`${mode}: stops a surviving listener before removing its root`, { timeout: 10000 }, async () => {
      const run = start(mode);
      assert.deepEqual(await run.exit, { code, signal: null });
      const child = JSON.parse(fs.readFileSync(path.join(control, 'descendant.json'), 'utf8'));
      assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' }, 'owned descendant must already be stopped');
      assert.equal(fs.existsSync(child.root), false, 'descendant cannot recreate its deleted fixture root');
      assert.deepEqual(ownedRoots(), []);
      const socket = require('net').connect(child.port, '127.0.0.1');
      await assert.rejects(require('events').once(socket, 'connect'), { code: 'ECONNREFUSED' });
    });
  }

  for (const signal of ['SIGINT', 'SIGTERM']) {
    it(`${signal}: waits for the owned child to stop before removing its root`, async () => {
      const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      spawned.add(bystander);
      const sentinel = path.join(parent, 'pre-existing-fixture');
      fs.mkdirSync(sentinel);

      const run = start('graceful');
      const root = await run.ready;
      assert.ok(fs.existsSync(root));
      run.proc.kill(signal);
      const result = await run.exit;

      assert.equal(result.code, 0, 'runner reports the child\'s own exit status after it stops');
      assert.equal(fs.readFileSync(path.join(control, 'witness'), 'utf8'), 'root-present',
        'child was still running with its root intact when it stopped');
      assert.equal(fs.existsSync(root), false, 'root removed after the child stopped');
      assert.ok(fs.existsSync(sentinel), 'pre-existing temp entries survive');
      assert.equal(bystander.exitCode, null);
      assert.equal(bystander.signalCode, null, 'unrelated process untouched');
    });
  }

  it('escalates to SIGKILL for a child that ignores the signal, then cleans up', async () => {
    const run = start('stubborn', { KILL_GRACE_MS: '300' });
    const root = await run.ready;
    run.proc.kill('SIGTERM');
    const result = await run.exit;
    assert.equal(result.code, 128 + os.constants.signals.SIGKILL);
    assert.equal(fs.existsSync(root), false);
  });

  it('gives two simultaneous runs distinct roots and never cleans the sibling', async () => {
    const a = start('hold');
    const b = start('hold');
    const [rootA, rootB] = await Promise.all([a.ready, b.ready]);
    assert.notEqual(rootA, rootB);
    assert.equal(path.dirname(fs.realpathSync(rootA)), fs.realpathSync(parent));
    assert.equal(path.dirname(fs.realpathSync(rootB)), fs.realpathSync(parent));

    // Both children poll the same control file and exit once it appears.
    fs.writeFileSync(path.join(control, 'release'), '');
    const [resultA, resultB] = await Promise.all([a.exit, b.exit]);
    assert.equal(resultA.code, 0);
    assert.equal(resultB.code, 0);
    assert.deepEqual(ownedRoots(), []);
  });

  it('keeps the sibling root intact when one of two runs finishes first', async () => {
    const a = start('hold');
    const rootA = await a.ready;
    // B is a different mode so it outlives A's release.
    const b = start('graceful');
    const rootB = await b.ready;
    fs.writeFileSync(path.join(control, 'release'), '');
    assert.equal((await a.exit).code, 0);
    assert.equal(fs.existsSync(rootA), false);
    assert.ok(fs.existsSync(path.join(rootB, 'fixture.txt')), 'sibling fixture survives');
    b.proc.kill('SIGTERM');
    await b.exit;
    assert.equal(fs.existsSync(rootB), false);
  });

  it('preserves test selection, preloads and argument forwarding', () => {
    const args = defaultChildArgs(['--test-name-pattern=foo']);
    assert.deepEqual(args.slice(0, 7), [
      '--require', './tests/quiet-console.js',
      '--require', './tests/isolated-data-root.js',
      '--require', './tests/skip-fsync.js',
      '--test',
    ]);
    assert.ok(args.includes(path.join('tests', 'test-runner.test.js')));
    assert.ok(args.filter((a) => a.endsWith('.test.js')).every((a) => a.startsWith('tests' + path.sep)));
    assert.equal(args[7], '--test-name-pattern=foo', 'Node options must precede test file paths');
    const onDisk = fs.readdirSync(path.join(REPO_ROOT, 'tests')).filter((n) => n.endsWith('.test.js'));
    assert.equal(args.filter((a) => a.endsWith('.test.js')).length, onDisk.length);
    assert.equal(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).scripts.test, 'node scripts/test.js');
  });

  it('the actual CLI accepts forwarded selection and reporter options', { timeout: 10000 }, async () => {
    const repo = path.join(control, 'option-repo');
    fs.mkdirSync(path.join(repo, 'scripts/lib'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'tests'));
    fs.copyFileSync(path.join(REPO_ROOT, 'scripts/test.js'), path.join(repo, 'scripts/test.js'));
    fs.copyFileSync(path.join(REPO_ROOT, 'scripts/lib/process-group.js'), path.join(repo, 'scripts/lib/process-group.js'));
    fs.writeFileSync(path.join(repo, 'tests/quiet-console.js'), '');
    fs.copyFileSync(path.join(REPO_ROOT, 'tests/isolated-data-root.js'), path.join(repo, 'tests/isolated-data-root.js'));
    fs.writeFileSync(path.join(repo, 'tests/skip-fsync.js'), '');
    fs.writeFileSync(path.join(repo, 'tests/selection.test.js'), `
      const { test } = require('node:test');
      test('chosen', () => {
        // Concurrent test files must not share a data root.
        const dir = process.env.CRITICAL_MASS_DATA_DIR;
        if (require('path').basename(dir) !== 'pid-' + process.pid || !require('fs').statSync(dir).isDirectory()) {
          throw new Error('data root not isolated per test process: ' + dir);
        }
      });
      test('unselected', () => { throw new Error('filter was ignored'); });
    `);
    const env = { ...process.env, TMPDIR: parent, TMP: parent, TEMP: parent };
    // This fixture represents a shell invocation, not a nested test worker.
    delete env.NODE_TEST_CONTEXT;
    const proc = spawn(process.execPath, [path.join(repo, 'scripts/test.js'), '--test-name-pattern=chosen', '--test-reporter=tap'], {
      cwd: repo,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    spawned.add(proc);
    let output = '';
    for (const stream of [proc.stdout, proc.stderr]) stream.on('data', chunk => { output += chunk; });
    const [code] = await require('events').once(proc, 'close');
    assert.equal(code, 0, output);
    assert.match(output, /ok 1 - chosen/);
    assert.doesNotMatch(output, /not ok|filter was ignored/);
    assert.match(output, /^# pass 1$/m);
    assert.match(output, /^# fail 0$/m);
    assert.deepEqual(ownedRoots(), []);
  });
});
