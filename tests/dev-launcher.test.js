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

test('shutdown escalates for a stubborn child and stops its watch descendant', {
  skip: process.platform === 'win32',
  timeout: 10000,
}, async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-stubborn-'));
  const script = path.join(dir, 'watch.cjs');
  writeFileSync(script, "process.on('SIGTERM', () => {}); console.log('pid=' + process.pid); setInterval(() => {}, 1000);");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const io = capture();
  const pids = [];
  // Ignore the signal in both the watch supervisor and its application child.
  const source = "process.on('SIGTERM', () => {}); const { spawn } = require('node:child_process'); spawn(process.execPath, ['--watch', " + JSON.stringify(script) + "], { stdio: 'inherit' }); console.log('pid=' + process.pid); setInterval(() => {}, 1000);";
  t.after(() => {
    for (const pid of pids) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
  });
  io.stdout.write = text => {
    const match = text.match(/pid=(\d+)/);
    if (match) pids.push(Number(match[1]));
    if (pids.length === 2) io.signals.emit('SIGTERM');
  };
  assert.equal(await launch([fixture('stubborn', source)], { ...io, killGraceMs: 100 }), 1);
  assert.match(io.errors(), /shutdown grace period; sending SIGKILL/);
  assert.equal(pids.length, 2);
  for (const pid of pids) {
    // Reaping a force-killed orphan can lag its closed stdout briefly.
    for (let tries = 0; tries < 100; tries++) {
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
  assert.deepEqual(io.signals.eventNames(), []);
});

for (const mode of [0, 7, 'signal']) {
  test(`direct child exit ${mode} stops an ignored-stdio descendant`, {
    skip: process.platform === 'win32',
    timeout: 10000,
  }, async t => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dev-descendant-'));
    const witness = path.join(dir, 'listener.json');
    const fs = require('node:fs');
    t.after(() => {
      if (fs.existsSync(witness)) {
        try { process.kill(JSON.parse(fs.readFileSync(witness, 'utf8')).pid, 'SIGKILL'); } catch { /* gone */ }
      }
      rmSync(dir, { recursive: true, force: true });
    });
    const descendant = `
      process.on('SIGTERM', () => {});
      const server = require('net').createServer();
      server.listen(0, '127.0.0.1', () => {
        const fs = require('fs');
        fs.writeFileSync(${JSON.stringify(witness + '.tmp')}, JSON.stringify({ pid: process.pid, port: server.address().port }));
        fs.renameSync(${JSON.stringify(witness + '.tmp')}, ${JSON.stringify(witness)});
      });
    `;
    const source = `
      const child = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' });
      child.unref();
      process.on('SIGTERM', () => process.exit(0));
      const timer = setInterval(() => {
        if (require('fs').existsSync(${JSON.stringify(witness)})) {
          clearInterval(timer);
          ${mode === 'signal' ? "setInterval(() => {}, 1000); console.log('ready');" : `process.exit(${mode});`}
        }
      }, 10);
    `;
    const io = capture();
    io.stdout.write = text => { if (text.includes('ready')) io.signals.emit('SIGTERM'); };
    let signalDuringClose = false;
    if (mode === 0) {
      const realKill = process.kill;
      t.after(() => { process.kill = realKill; });
      // Deliver a shutdown request when real group cleanup starts. Keep real
      // signal outcomes: this checks the closing -> closed ownership boundary.
      process.kill = function(pid, signal) {
        if (signal === 'SIGKILL' && !signalDuringClose) {
          signalDuringClose = true;
          io.signals.emit('SIGTERM');
        }
        return realKill.call(process, pid, signal);
      };
    }
    assert.equal(await launch([fixture('parent', source)], { ...io, killGraceMs: 100 }), mode === 7 ? 1 : 0);
    const child = JSON.parse(fs.readFileSync(witness, 'utf8'));
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
    const socket = require('net').connect(child.port, '127.0.0.1');
    await assert.rejects(require('events').once(socket, 'connect'), { code: 'ECONNREFUSED' });
    assert.deepEqual(io.signals.eventNames(), []);
    if (mode === 0) {
      assert.equal(signalDuringClose, true);
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(io.errors(), '', 'no escalation timer may survive close');
    }
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
