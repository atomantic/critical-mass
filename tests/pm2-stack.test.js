const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { main } = require('../scripts/pm2-stack');

const repo = path.resolve(__dirname, '..');
const commands = require('../package.json').scripts;
// Real-process cases run each stub call as a separate Node process; on a loaded host a single start
// can take seconds, so the budget is generous. A real hang still hits this limit and fails with a timeout message.
const SPAWN_TIMEOUT_MS = 120000;
const TEST_TIMEOUT_MS = 300000;
const PORTS = { API: 5570, UI: 5571, COINBASE_IPC: 5572, GEMINI_IPC: 5573, CRYPTOCOM_IPC: 5574 };
const names = ['critical-mass', 'critical-mass-coinbase', 'critical-mass-gemini', 'critical-mass-cryptocom', 'critical-mass-ui'];

/**
 * In-process stand-in for the `pm2` and `lsof` binaries, injected into main() as its command
 * runner. Mirrors the executable stub used by the real-process cases below (same scenarios,
 * same state machine) but never spawns anything, so it can never reach a real PM2 daemon.
 */
function fakeTools(scenario, initial) {
  let state = [...initial, 'unrelated-app'].map((name, pm_id) => ({ name, pm_id, pid: pm_id + 100, pm2_env: { status: 'online' } }));
  const calls = [];
  const exit = (status, stdout = '') => ({ status, stdout });
  const run = (command, rawArgs) => {
    const args = rawArgs.filter(arg => arg !== '--silent');
    calls.push([command, ...args]);
    if (command === 'lsof') {
      if (args[0] === '-v') return exit(scenario === 'missing-lsof' ? 2 : 0);
      return exit(scenario === 'occupied-port' ? 0 : 1);
    }
    assert.equal(command, 'pm2', `unexpected command ${command}`);
    for (const app of state.filter(app => app.name === 'pm2-logrotate')) {
      app.pm2_env.version ||= scenario === 'rotation-v3' ? '3.0.0' : '2.7.0';
      if (scenario.startsWith('rotation-stopped') && !app.restarted) { app.pid = 0; app.pm2_env.status = 'stopped'; }
    }
    if (args[0] === 'jlist') return exit(0, scenario === 'bad-inventory' ? 'secret-fixture-value\n' : `${JSON.stringify(state)}\n`);
    if (scenario === 'rotation-offline' && args[0] === 'install') return exit(2);
    if (scenario === 'stop-failure' && args[0] === 'stop') return exit(2);
    if (args[0] === 'install') {
      state = state.filter(app => app.name !== 'pm2-logrotate');
      const pm_id = Math.max(-1, ...state.map(app => app.pm_id)) + 1;
      state.push({ name: 'pm2-logrotate', pm_id, pid: pm_id + 100, pm2_env: { status: 'online', version: '3.0.1' } });
    }
    if (args[0] === 'restart') {
      if (scenario === 'rotation-stopped-restart-failure') return exit(2);
      const app = state.find(app => app.name === args[1]);
      app.pid = app.pm_id + 100; app.pm2_env.status = 'online'; app.restarted = true;
    }
    if (args[0] === 'stop') {
      for (const app of state.filter(app => args.slice(1).includes(String(app.pm_id)))) {
        if (scenario === 'gateway-still-running' && app.name === 'critical-mass') continue;
        app.pid = 0; app.pm2_env.status = 'stopped';
      }
    }
    if (args[0] === 'delete') state = state.filter(app => !args.slice(1).includes(String(app.pm_id)));
    if (args[0] === 'start') {
      if (scenario === 'engine-start-failure') return exit(2);
      for (const name of args[args.indexOf('--only') + 1].split(',')) {
        const pm_id = Math.max(-1, ...state.map(app => app.pm_id)) + 1;
        state.push({ name, pm_id, pid: pm_id + 100, pm2_env: { status: scenario === 'errored-start' ? 'errored' : 'online' } });
      }
    }
    return exit(0);
  };
  return { run, calls, get state() { return state; } };
}

/** Drive main() in-process against the fake tools, reporting what the CLI would: exit status and stderr. */
function run(t, action = 'start', scenario = '', initial = names) {
  const tools = fakeTools(scenario, initial);
  let stderr = '';
  t.mock.method(console, 'warn', (...args) => { stderr += `${args.join(' ')}\n`; });
  let status = 0;
  try { main(action, { run: tools.run, ports: PORTS }); }
  catch (error) { status = 1; stderr += `${error.message}\n`; }
  return { status, stderr, stdout: '', calls: tools.calls, state: tools.state };
}

// Real-process harness: runs the advertised npm script text through /bin/sh against executable
// pm2/lsof stubs in a throwaway root (never the real pm2).
async function runReal(t, command = 'start', scenario = '', initial = names) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-stack-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of ['scripts/pm2-stack.js', 'ecosystem.config.cjs', 'src/runtime-env.js']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(repo, file), path.join(root, file));
  }
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  // Include a completely unrelated PM2 workload; it must never be stopped.
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify([...initial, 'unrelated-app'].map((name, pm_id) => ({
    name, pm_id, pid: pm_id + 100, pm2_env: { status: 'online' },
  }))));
  const stub = `#!${process.execPath}
    const fs = require('node:fs');
    const args = process.argv.slice(2).filter(arg => arg !== '--silent');
    const scenario = process.env.SCENARIO;
    const log = 'calls.jsonl';
    fs.appendFileSync(log, JSON.stringify([process.env.STUB_NAME, ...args]) + '\\n');
    if (process.env.STUB_NAME === 'lsof') {
      if (args[0] === '-v') process.exit(scenario === 'missing-lsof' ? 2 : 0);
      process.exit(scenario === 'occupied-port' ? 0 : 1);
    }
    let state = JSON.parse(fs.readFileSync('state.json'));
    for (const app of state.filter(app => app.name === 'pm2-logrotate')) {
      app.pm2_env.version ||= scenario === 'rotation-v3' ? '3.0.0' : '2.7.0';
      if (scenario.startsWith('rotation-stopped') && !app.restarted) { app.pid = 0; app.pm2_env.status = 'stopped'; }
    }
    if (args[0] === 'jlist') {
      if (scenario === 'bad-inventory') { console.log('secret-fixture-value'); process.exit(0); }
      console.log(JSON.stringify(state)); process.exit(0);
    }
    if (scenario === 'rotation-offline' && args[0] === 'install') { console.error('secret-fixture-value'); process.exit(2); }
    if (scenario === 'stop-failure' && args[0] === 'stop') process.exit(2);
    if (args[0] === 'install') {
      state = state.filter(app => app.name !== 'pm2-logrotate');
      const pm_id = Math.max(-1, ...state.map(app => app.pm_id)) + 1;
      state.push({ name:'pm2-logrotate',pm_id,pid:pm_id+100,pm2_env:{status:'online',version:'3.0.1'} });
    }
    if (args[0] === 'restart') {
      if (scenario === 'rotation-stopped-restart-failure') process.exit(2);
      const app = state.find(app => app.name === args[1]);
      app.pid=app.pm_id+100; app.pm2_env.status='online'; app.restarted=true;
    }
    if (args[0] === 'stop') {
      for (const app of state.filter(app => args.slice(1).includes(String(app.pm_id)))) {
        if (scenario === 'gateway-still-running' && app.name === 'critical-mass') continue;
        app.pid = 0; app.pm2_env.status = 'stopped';
      }
    }
    if (args[0] === 'delete') state = state.filter(app => !args.slice(1).includes(String(app.pm_id)));
    if (args[0] === 'start') {
      if (scenario === 'engine-start-failure') process.exit(2);
      const selected = args[args.indexOf('--only') + 1].split(',');
      for (const name of selected) {
        const pm_id = Math.max(-1, ...state.map(app => app.pm_id)) + 1;
        state.push({ name, pm_id, pid: pm_id + 100, pm2_env: { status: scenario === 'errored-start' ? 'errored' : 'online' } });
      }
    }
    fs.writeFileSync('state.json', JSON.stringify(state));
  `;
  for (const name of ['pm2', 'lsof']) {
    // Separate wrappers identify the tool without inheriting any live PM2 home.
    fs.writeFileSync(path.join(bin, name), stub.replace("process.env.SCENARIO;", "process.env.SCENARIO; process.env.STUB_NAME = '" + name + "';"), { mode: 0o755 });
  }
  const result = await new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', commands[command]], {
      cwd: root,
      env: { PATH: bin + path.delimiter + path.dirname(process.execPath), SCENARIO: scenario },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`pm2-stack "${command}" (scenario "${scenario || 'default'}") timed out after ${SPAWN_TIMEOUT_MS}ms`));
    }, SPAWN_TIMEOUT_MS);
    child.on('error', reject);
    child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
  const calls = fs.existsSync(path.join(root, 'calls.jsonl'))
    ? fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { ...result, calls, state: JSON.parse(fs.readFileSync(path.join(root, 'state.json'))) };
}

test('npm start confirms gateway stop before engines, recreates in dependency order, and saves only this stack', { timeout: TEST_TIMEOUT_MS }, t => {
  const result = run(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.filter(call => call[0] === 'pm2' && call[1] !== 'jlist'), [
    ['pm2', 'stop', '0'],
    ['pm2', 'stop', '1', '2', '3', '4'],
    ['pm2', 'delete', '0', '1', '2', '3', '4'],
    ['pm2', 'start', 'ecosystem.config.cjs', '--only', names.slice(1, 4).join(',')],
    ['pm2', 'start', 'ecosystem.config.cjs', '--only', [names[0], names[4]].join(',')],
    ['pm2', 'install', 'pm2-logrotate@3.0.1'],
    ...[['max_size', '20M'], ['retain', '5'], ['compress', 'true'], ['rotateInterval', '0 0 * * *']].map(([key, value]) => ['pm2', 'set', `pm2-logrotate:${key}`, value]),
    ['pm2', 'save'],
  ]);
  assert.equal(result.state.find(app => app.name === 'unrelated-app').pid, 105);
  assert.deepEqual(result.calls.filter(call => call[0] === 'lsof').slice(1).map(call => call[2]), [':5570', ':5571', ':5572', ':5573', ':5574']);
});

test('fresh and partial native installations start without treating absent processes as a stop failure', { timeout: TEST_TIMEOUT_MS }, t => {
  for (const initial of [[], ['critical-mass-gemini']]) {
    const result = run(t, 'start', '', initial);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.state.filter(app => names.includes(app.name)).length, 5);
  }
});

test('each distinct advertised PM2 action uses ordered stop; stop preserves registrations (real processes)', { timeout: TEST_TIMEOUT_MS }, async t => {
  const results = await Promise.all(['pm2:start', 'pm2:stop'].map(async command => [command, await runReal(t, command)]));
  for (const [command, result] of results) {
    assert.equal(result.status, 0, result.stderr);
    const mutations = result.calls.filter(call => call[0] === 'pm2' && call[1] !== 'jlist');
    assert.deepEqual(mutations.slice(0, 2), [['pm2', 'stop', '0'], ['pm2', 'stop', '1', '2', '3', '4']]);
    if (command === 'pm2:stop') {
      assert.equal(mutations.length, 2);
      assert.equal(result.state.filter(app => names.includes(app.name) && app.pm2_env.status === 'stopped').length, 5);
    }
  }
});

test('npm scripts map to the stack script actions and the in-process runner sees the same ordered stop', { timeout: TEST_TIMEOUT_MS }, t => {
  for (const command of ['start', 'pm2:start', 'pm2:restart']) assert.equal(commands[command], 'node scripts/pm2-stack.js start');
  assert.equal(commands['pm2:stop'], 'node scripts/pm2-stack.js stop');
  for (const action of ['start', 'stop']) {
    const mutations = run(t, action).calls.filter(call => call[0] === 'pm2' && call[1] !== 'jlist');
    assert.deepEqual(mutations.slice(0, 2), [['pm2', 'stop', '0'], ['pm2', 'stop', '1', '2', '3', '4']]);
    if (action === 'stop') assert.equal(mutations.length, 2);
  }
});

test('failed or unconfirmed gateway stop leaves engines running and never deletes or starts', { timeout: TEST_TIMEOUT_MS }, t => {
  for (const scenario of ['stop-failure', 'gateway-still-running']) {
    const result = run(t, 'start', scenario);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.calls.filter(call => call[0] === 'pm2' && call[1] !== 'jlist'), [['pm2', 'stop', '0']]);
    assert.ok(result.state.filter(app => names.slice(1, 4).includes(app.name)).every(app => app.pid > 0));
  }
});

test('unreadable inventory and missing port tool fail before any process mutation', { timeout: TEST_TIMEOUT_MS }, t => {
  for (const scenario of ['bad-inventory', 'missing-lsof']) {
    const result = run(t, 'start', scenario);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.calls.some(call => call[0] === 'pm2' && call[1] !== 'jlist'), false);
    assert.equal(result.stderr.includes('secret-fixture-value'), false);
  }
});

test('unreadable inventory leaks no inventory output through a real process', { timeout: TEST_TIMEOUT_MS }, async t => {
  const result = await runReal(t, 'start', 'bad-inventory');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.calls.some(call => call[0] === 'pm2' && call[1] !== 'jlist'), false);
  assert.equal((result.stdout + result.stderr).includes('secret-fixture-value'), false);
});

test('occupied ports or failed starts cannot save a broken process list', { timeout: TEST_TIMEOUT_MS }, t => {
  for (const scenario of ['occupied-port', 'engine-start-failure', 'errored-start']) {
    const result = run(t, 'start', scenario);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.calls.some(call => call[1] === 'save'), false);
    if (scenario === 'occupied-port') assert.equal(result.calls.some(call => call[1] === 'start'), false);
    if (scenario !== 'occupied-port') assert.equal(result.calls.filter(call => call[1] === 'start').length, 1);
  }
});

test('log rotation skips an installed module and reasserts bounded settings', { timeout: TEST_TIMEOUT_MS }, t => {
  const result = run(t, 'start', '', [...names, 'pm2-logrotate']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.some(call => call[1] === 'install'), false);
  assert.equal(result.calls.filter(call => call[1] === 'set').length, 4);
  assert.equal(result.state.find(app => app.name === 'pm2-logrotate').pid, 105);
});

test('offline rotation installation warns without failing', { timeout: TEST_TIMEOUT_MS }, t => {
  const result = run(t, 'start', 'rotation-offline');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /log rotation could not be configured/);
  assert.equal(result.calls.some(call => call[1] === 'save'), true);
});

test('offline rotation installation leaks no captured output through a real process', { timeout: TEST_TIMEOUT_MS }, async t => {
  const result = await runReal(t, 'start', 'rotation-offline');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /log rotation could not be configured/);
  assert.equal((result.stdout + result.stderr).includes('secret-fixture-value'), false);
  assert.equal(result.calls.some(call => call[1] === 'save'), true);
});

test('log rotation repairs stopped modules and migrates the broken compression release', { timeout: TEST_TIMEOUT_MS }, t => {
  for (const scenario of ['rotation-stopped', 'rotation-v3', 'rotation-stopped-restart-failure']) {
    const result = run(t, 'start', scenario, [...names, 'pm2-logrotate']);
    assert.equal(result.status, 0, result.stderr);
    if (scenario === 'rotation-v3') {
      assert.equal(result.calls.some(call => call[1] === 'install'), true);
      assert.equal(result.state.find(app => app.name === 'pm2-logrotate').pm2_env.version, '3.0.1');
    } else {
      assert.equal(result.calls.some(call => call[1] === 'restart' && call[2] === 'pm2-logrotate'), true);
      if (scenario.endsWith('failure')) assert.match(result.stderr, /log rotation could not be configured/);
      else assert.equal(result.state.find(app => app.name === 'pm2-logrotate').pm2_env.status, 'online');
    }
  }
});
