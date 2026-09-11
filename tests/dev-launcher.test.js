const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtempSync, writeFileSync, rmSync, realpathSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { launch, developmentChildren } = require('../scripts/dev');

const fixture = (name, source) => ({ name, command: process.execPath, args: ['-e', source] });
function capture() {
  let out = '';
  let err = '';
  return {
    signals: new EventEmitter(),
    stdout: { write: text => { out += text; } },
    stderr: { write: text => { err += text; } },
    output: () => out,
    errors: () => err,
  };
}

test('both children succeed, with attributed stdout/stderr and final partial lines', async () => {
  const io = capture();
  assert.equal(await launch([
    fixture('server', "process.stdout.write('first\\nlast'); process.stderr.write('warning')"),
    fixture('ui', "process.stdout.write('ui ready')"),
  ], io), 0);
  assert.deepEqual(io.output().split('\n').filter(line => line.startsWith('[server]')), ['[server] first', '[server] last']);
  assert.match(io.output(), /\[ui\] ui ready\n/);
  assert.equal(io.errors(), '[server] warning\n');
});

for (const exitCode of [0, 7]) {
  test('waits for sibling after exit ' + exitCode, async () => {
    const io = capture();
    assert.equal(await launch([
      fixture('server', 'process.exit(' + exitCode + ')'),
      fixture('ui', "setTimeout(() => console.log('finished independently'), 150)"),
    ], io), exitCode === 0 ? 0 : 1);
    assert.match(io.output(), /finished independently/);
  });
}

test('spawn failure reports failure but lets the other child finish', async () => {
  const io = capture();
  assert.equal(await launch([
    { name: 'missing', command: path.join(__dirname, 'nonexistent-launcher-command') },
    fixture('ui', "setTimeout(() => console.log('finished'), 50)"),
  ], io), 1);
  assert.match(io.errors(), /\[missing\] Failed to start:.*ENOENT/);
  assert.match(io.output(), /\[ui\] finished/);
});

test('synchronous spawn failure also removes signal listeners', async () => {
  const io = capture();
  assert.equal(await launch([{ name: 'invalid', command: null }], io), 1);
  assert.deepEqual(io.signals.eventNames(), []);
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  test(signal + ' drains both children, is idempotent, and removes listeners', { timeout: 10000 }, async () => {
    const io = capture();
    let ready = 0;
    io.stdout.write = text => {
      if (text.includes('ready') && ++ready === 2) {
        io.signals.emit(signal);
        io.signals.emit(signal);
      }
    };
    const source = "let count = 0; process.on('" + signal + "', () => { count++; setTimeout(() => { console.error('signals=' + count); process.exit(2); }, 40); }); console.log('ready'); setInterval(() => {}, 1000)";
    assert.equal(await launch([fixture('server', source), fixture('ui', source)], io), signal === 'SIGINT' ? 0 : 1);
    assert.equal((io.errors().match(/signals=1/g) || []).length, 2);
    assert.deepEqual(io.signals.eventNames(), []);
  });

  test(signal + ' stops a real watch-mode descendant and its sibling', {
    skip: process.platform === 'win32',
    timeout: 10000,
  }, async t => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dev-watch-'));
    const script = path.join(dir, 'watch.cjs');
    writeFileSync(script, "console.log('pid=' + process.pid); setInterval(() => {}, 1000);");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const io = capture();
    const pids = [];
    io.stdout.write = text => {
      const match = text.match(/pid=(\d+)/);
      if (match) pids.push(Number(match[1]));
      if (pids.length === 2) io.signals.emit(signal);
    };
    const result = await launch([
      { name: 'server', command: process.execPath, args: ['--watch', script] },
      fixture('ui', "console.log('pid=' + process.pid); setInterval(() => {}, 1000)"),
    ], io);
    assert.equal(result, signal === 'SIGINT' ? 0 : 1);
    assert.equal(pids.length, 2);
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  });
}

test('development specs preserve script cwd, node executable and port environment', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-specs-'));
  const { mkdirSync } = require('node:fs');
  const vite = path.join(dir, 'admin/node_modules/vite');
  mkdirSync(vite, { recursive: true });
  writeFileSync(path.join(vite, 'package.json'), '{"name":"vite"}');
  try {
    const [server, ui] = developmentChildren(dir, { CUSTOM: 'retained', VITE_PORT: '1234' });
    assert.equal(server.command, process.execPath);
    assert.equal(ui.command, process.execPath);
    assert.deepEqual(server.args, ['--watch', 'server.js']);
    assert.deepEqual(ui.args, [path.join(realpathSync(vite), 'bin/vite.js')]);
    assert.equal(server.cwd, dir);
    assert.equal(ui.cwd, path.join(dir, 'admin'));
    assert.deepEqual(server.env, { CUSTOM: 'retained', VITE_PORT: '1234', VITE_API_PORT: '5570' });
    assert.deepEqual(ui.env, { CUSTOM: 'retained', VITE_PORT: '5571', VITE_API_PORT: '5570' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
