#!/usr/bin/env node
// Native whole-stack lifecycle. Never stop engines until the gateway has drained.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { createServer } = require('node:net');

const ROOT = path.resolve(__dirname, '..');
const GATEWAY = 'critical-mass';
const ENGINES = ['critical-mass-coinbase', 'critical-mass-gemini', 'critical-mass-cryptocom'];
const UI = 'critical-mass-ui';
const PRODUCTION_NAMES = [GATEWAY, ...ENGINES];
const NAMES = [...PRODUCTION_NAMES, UI];
const ROTATION_SETTINGS = { max_size: '20M', retain: '5', compress: 'true', rotateInterval: '0 0 * * *' };

/** @param {(command: string, args: string[], options: import('node:child_process').SpawnSyncOptionsWithStringEncoding) => {error?: Error, status: number | null, stdout: string}} run */
function createStack(run) {
  function pm2(args, capture = false) {
    const result = run('pm2', ['--silent', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: capture ? 'pipe' : 'inherit',
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
    });
    // jlist contains environment secrets. Never include its output or the spawn
    // error (which may embed output) in an exception or diagnostic.
    if (result.error || result.status !== 0) throw new Error(`PM2 ${args[0]} failed; stack operation stopped.`);
    return result.stdout;
  }

  function inventory() {
    let list;
    try { list = JSON.parse(pm2(['jlist'], true)); }
    catch { throw new Error('Unable to read PM2 process inventory; stack operation stopped.'); }
    if (!Array.isArray(list)) throw new Error('Invalid PM2 process inventory; stack operation stopped.');
    return list;
  }

  function processes(list = inventory()) {
    const owned = list.filter(app => NAMES.includes(app?.name));
    if (owned.some(app => !Number.isInteger(app.pm_id) || app.pm_id < 0)) {
      throw new Error('Invalid Critical Mass process ID; stack operation stopped.');
    }
    return owned;
  }

  function stopGroup(names) {
    const targets = processes().filter(app => names.includes(app.name));
    if (!targets.length) return [];
    const ids = targets.map(app => String(app.pm_id));
    pm2(['stop', ...ids]);
    if (processes().some(app => ids.includes(String(app.pm_id)) &&
        (app.pm2_env?.status !== 'stopped' || app.pid !== 0))) {
      throw new Error('PM2 did not confirm Critical Mass stopped; dependent processes were left untouched.');
    }
    return ids;
  }

  function confirmOnline(names) {
    const running = inventory();
    const owned = processes(running);
    if (names.some(name => !owned.some(app => app.name === name && app.pm2_env?.status === 'online' && app.pid > 0))) {
      throw new Error('PM2 did not report every requested Critical Mass process online; stack operation stopped without saving.');
    }
    return running;
  }

  function ensureLogRotation(running) {
    // Installation may need the network. Logging must never prevent an otherwise
    // healthy stack from starting, and inventory output must remain private.
    try {
      const isRotation = app => app?.name === 'pm2-logrotate';
      const isOnline = app => app?.pm2_env?.status === 'online' && app.pid > 0;
      const existing = running.find(isRotation);
      // 3.0.1 fixes 3.0.0 compression with PMX boolean configuration casting.
      const install = !existing || existing.pm2_env?.version === '3.0.0';
      if (install) pm2(['install', 'pm2-logrotate@3.0.1'], true);
      const settings = install ? {} : existing.pm2_env?.env;
      let changed = install;
      for (const [setting, value] of Object.entries(ROTATION_SETTINGS)) {
        if (String(settings?.[setting]) === value) continue;
        pm2(['set', `pm2-logrotate:${setting}`, value], true);
        changed = true;
      }
      const configured = changed ? inventory().find(isRotation) : existing;
      if (isOnline(configured)) return;
      pm2(['restart', 'pm2-logrotate'], true);
      if (!isOnline(inventory().find(isRotation))) throw new Error('Log rotation module is not online.');
    } catch {
      console.warn('Warning: PM2 log rotation could not be configured; retry npm run pm2:start when the module is available.');
    }
  }
  return { pm2, stopGroup, confirmOnline, ensureLogRotation };
}

/** @param {number} port */
function checkPort(port) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error(`Required port ${port} is occupied or could not be checked; startup stopped.`)));
    probe.listen(port, () => probe.close(error => error ? reject(error) : resolve(undefined)));
  });
}

async function main(action = 'start', { run = spawnSync, ports = require('../ecosystem.config.cjs').PORTS, probe = checkPort } = {}) {
  if (!['start', 'stop'].includes(action)) throw new Error('Usage: node scripts/pm2-stack.js [start|stop]');
  const { pm2, stopGroup, confirmOnline, ensureLogRotation } = createStack(run);
  const { UI: devPort, ...productionPorts } = ports;
  const requiredPorts = Object.values(productionPorts);
  if (action === 'start' && requiredPorts.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('Invalid Critical Mass production port; no processes were stopped.');
  }

  const stopped = [...stopGroup([GATEWAY]), ...stopGroup([...ENGINES, UI])];
  if (action === 'stop') return;
  for (const port of requiredPorts) await probe(port);
  if (stopped.length) pm2(['delete', ...stopped]);

  // Recreate rather than restart so edited .env values replace PM2's old env.
  pm2(['start', 'ecosystem.config.cjs', '--only', ENGINES.join(',')]);
  confirmOnline(ENGINES);
  pm2(['start', 'ecosystem.config.cjs', '--only', GATEWAY]);
  ensureLogRotation(confirmOnline(PRODUCTION_NAMES));
  pm2(['save']);
}

if (require.main === module) {
  main(process.argv[2]).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { main, checkPort };
