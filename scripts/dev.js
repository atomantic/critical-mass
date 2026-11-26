require('../src/runtime-env').loadRuntimeEnv();

// The combined development command owns only these two processes, not a shell.
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const path = require('node:path');
const { PORTS } = require('../ecosystem.config.cjs');
const { stopProcessGroup } = require('./lib/process-group');

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
// Allow the gateway's 30-second drain before forcing its watch group to stop.
const KILL_GRACE_MS = 40000;

function developmentChildren(root = path.resolve(__dirname, '..'), env = process.env, target) {
  const port = env.PORT || String(PORTS.API);
  const children = [];
  if (target !== 'ui') {
    children.push({
      name: 'server',
      command: process.execPath,
      args: ['--watch', 'server.js'],
      cwd: root,
      env: { ...env, PORT: port },
    });
  }
  if (target !== 'server') {
    const admin = path.join(root, 'admin');
    const vitePackage = require.resolve('vite/package.json', { paths: [admin] });
    children.push({
      name: 'ui',
      command: process.execPath,
      args: [path.join(path.dirname(vitePackage), 'bin', 'vite.js')],
      cwd: admin,
      env: { ...env, VITE_PORT: env.VITE_PORT || String(PORTS.UI), VITE_API_PORT: env.VITE_API_PORT || port },
    });
  }
  return children;
}

/** Inject fixture child specs and an event emitter to test without application state. */
function launch(children, { signals = process, stdout = process.stdout, stderr = process.stderr, killGraceMs = KILL_GRACE_MS } = {}) {
  const running = new Set();
  const killTimers = new Map();
  let shutdownSignal;
  let failed = false;

  function signalChild(child, signal) {
    try {
      // Include node --watch's application child in the POSIX process group.
      if (process.platform === 'win32') child.kill(signal);
      else if (child.pid) process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') {
        failed = true;
        stderr.write('[dev] Signal forwarding failed: ' + error.message + '\n');
      }
    }
  }

  function shutdown(signal) {
    if (shutdownSignal) return;
    shutdownSignal = signal;
    for (const child of running) {
      signalChild(child, signal);
      killTimers.set(child, setTimeout(() => {
        failed = true;
        stderr.write('[dev] Child did not stop within the shutdown grace period; sending SIGKILL\n');
        signalChild(child, 'SIGKILL');
      }, killGraceMs));
    }
  }

  const listeners = SIGNALS.map(signal => {
    const listener = () => shutdown(signal);
    signals.on(signal, listener);
    return { signal, listener };
  });

  const completions = children.map(spec => new Promise(resolve => {
    let child;
    let spawnFailed = false;
    const reportError = error => {
      spawnFailed = true;
      stderr.write('[' + spec.name + '] Failed to start: ' + error.message + '\n');
    };
    try {
      child = spawn(spec.command, spec.args || [], {
        cwd: spec.cwd,
        env: spec.env || process.env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reportError(error);
      resolve(false);
      return;
    }
    running.add(child);
    for (const { stream, output } of [{ stream: child.stdout, output: stdout }, { stream: child.stderr, output: stderr }]) {
      createInterface({ input: stream, crlfDelay: Infinity }).on('line', line => {
        output.write('[' + spec.name + '] ' + line + '\n');
      });
    }
    child.on('error', reportError);
    // close, rather than exit, guarantees that final partial lines are drained.
    child.once('close', async code => {
      // Cleanup owns this group now; shutdown must not add another kill timer.
      running.delete(child);
      clearTimeout(killTimers.get(child));
      killTimers.delete(child);
      try {
        if (process.platform !== 'win32') await stopProcessGroup(child.pid);
      } catch (error) {
        failed = true;
        stderr.write('[' + spec.name + '] Cleanup failed: ' + error.message + '\n');
      }
      resolve(!spawnFailed && (shutdownSignal === 'SIGINT' || code === 0));
    });
  }));

  return Promise.all(completions).then(results => {
    for (const { signal, listener } of listeners) signals.off(signal, listener);
    return !failed && results.every(Boolean) ? 0 : 1;
  });
}

if (require.main === module) {
  Promise.resolve().then(() => launch(developmentChildren(undefined, undefined, process.argv[2]))).then(code => {
    process.exitCode = code;
  }).catch(error => {
    console.error('[dev] ' + error.message);
    process.exitCode = 1;
  });
}

module.exports = { developmentChildren, launch };
