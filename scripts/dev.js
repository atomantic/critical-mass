// The combined development command owns only these two processes, not a shell.
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const path = require('node:path');

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

function developmentChildren(root = path.resolve(__dirname, '..'), env = process.env) {
  const admin = path.join(root, 'admin');
  const vitePackage = require.resolve('vite/package.json', { paths: [admin] });
  return [
    {
      name: 'server',
      command: process.execPath,
      args: ['--watch', 'server.js'],
      cwd: root,
      env: { ...env, VITE_API_PORT: '5570' },
    },
    {
      name: 'ui',
      command: process.execPath,
      args: [path.join(path.dirname(vitePackage), 'bin', 'vite.js')],
      cwd: admin,
      env: { ...env, VITE_PORT: '5571', VITE_API_PORT: '5570' },
    },
  ];
}

/** Inject fixture child specs and an event emitter to test without application state. */
function launch(children, { signals = process, stdout = process.stdout, stderr = process.stderr } = {}) {
  const running = new Set();
  let shutdownSignal;
  let failed = false;

  function shutdown(signal) {
    if (shutdownSignal) return;
    shutdownSignal = signal;
    for (const child of running) {
      try {
        // A separate POSIX process group includes node --watch's application
        // child. It also prevents terminal Ctrl-C from being delivered twice.
        if (process.platform === 'win32') child.kill(signal);
        else if (child.pid) process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') {
          failed = true;
          stderr.write('[dev] Signal forwarding failed: ' + error.message + '\n');
        }
      }
    }
  }

  const listeners = SIGNALS.map(signal => {
    const listener = () => shutdown(signal);
    signals.on(signal, listener);
    return [signal, listener];
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
    for (const [stream, output] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      createInterface({ input: stream, crlfDelay: Infinity }).on('line', line => {
        output.write('[' + spec.name + '] ' + line + '\n');
      });
    }
    child.on('error', reportError);
    // close, rather than exit, guarantees that final partial lines are drained.
    child.once('close', code => {
      running.delete(child);
      resolve(!spawnFailed && (shutdownSignal === 'SIGINT' || code === 0));
    });
  }));

  return Promise.all(completions).then(results => {
    for (const [signal, listener] of listeners) signals.off(signal, listener);
    return !failed && results.every(Boolean) ? 0 : 1;
  });
}

if (require.main === module) {
  Promise.resolve().then(() => launch(developmentChildren())).then(code => {
    process.exitCode = code;
  }).catch(error => {
    console.error('[dev] ' + error.message);
    process.exitCode = 1;
  });
}

module.exports = { developmentChildren, launch };
