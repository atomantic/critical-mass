#!/usr/bin/env node
// Native whole-stack lifecycle. Never stop engines until the gateway has drained.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const GATEWAY = 'critical-mass';
const ENGINES = ['critical-mass-coinbase', 'critical-mass-gemini', 'critical-mass-cryptocom'];
const UI = 'critical-mass-ui';
const NAMES = [GATEWAY, ...ENGINES, UI];

function pm2(args, capture = false) {
  const result = spawnSync('pm2', ['--silent', ...args], {
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

function processes() {
  let list;
  try { list = JSON.parse(pm2(['jlist'], true)); }
  catch { throw new Error('Unable to read PM2 process inventory; stack operation stopped.'); }
  if (!Array.isArray(list)) throw new Error('Invalid PM2 process inventory; stack operation stopped.');
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
  const running = processes();
  if (names.some(name => !running.some(app => app.name === name && app.pm2_env?.status === 'online' && app.pid > 0))) {
    throw new Error('PM2 did not report every requested Critical Mass process online; stack operation stopped without saving.');
  }
}

function main(action = 'start') {
  if (!['start', 'stop'].includes(action)) throw new Error('Usage: node scripts/pm2-stack.js [start|stop]');
  // Validate configuration before interrupting any running process.
  const { PORTS } = require('../ecosystem.config.cjs');
  // The existing port preflight uses lsof. Fail before stopping if unavailable.
  if (action === 'start') {
    const probe = spawnSync('lsof', ['-v'], { stdio: 'ignore' });
    if (probe.error || probe.status !== 0) throw new Error('lsof is required for native startup port checks; no processes were stopped.');
  }

  const stopped = [...stopGroup([GATEWAY]), ...stopGroup([...ENGINES, UI])];
  if (action === 'stop') return;
  if (stopped.length) pm2(['delete', ...stopped]);

  for (const port of Object.values(PORTS)) {
    const result = spawnSync('lsof', ['-i', `:${port}`, '-sTCP:LISTEN', '-t'], { stdio: 'ignore' });
    if (result.error || result.status !== 1) {
      throw new Error(`Required port ${port} is occupied or could not be checked; startup stopped.`);
    }
  }

  // Recreate rather than restart so edited .env values replace PM2's old env.
  pm2(['start', 'ecosystem.config.cjs', '--only', ENGINES.join(',')]);
  confirmOnline(ENGINES);
  pm2(['start', 'ecosystem.config.cjs', '--only', [GATEWAY, UI].join(',')]);
  confirmOnline(NAMES);
  pm2(['save']);
}

if (require.main === module) {
  try { main(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { main };
