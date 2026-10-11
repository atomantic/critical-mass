#!/usr/bin/env node
// @ts-check
/**
 * `npm test` runner. Runs the Node test runner with a runner-owned, disposable
 * temp root so a suite that forgets to clean up its fixtures cannot leave them
 * in the shared system temp directory.
 *
 * - allocates one unique root under os.tmpdir() and points TMPDIR/TMP/TEMP at it
 * - preserves the quiet-console preload, serial concurrency, the tests/*.test.js
 *   selection and any extra CLI arguments, and the child's exit status
 * - removes ONLY its own root after the child closes (success, failure or signal)
 * - forwards SIGINT/SIGTERM/SIGHUP to the child's process group, waits for it to
 *   stop, then cleans up; escalates to SIGKILL after a bounded grace period
 *
 * SIGKILL of the runner itself (or power loss) is outside orderly teardown.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const ROOT_PREFIX = 'cm-test-';
const KILL_GRACE_MS = 10000;
const FORWARDED_SIGNALS = /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP']);

/** Default child command: the documented node --test invocation. */
function defaultChildArgs(extraArgs) {
  const testsDir = path.join(REPO_ROOT, 'tests');
  const files = fs.readdirSync(testsDir)
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => path.join('tests', name));
  return [
    '--require', './tests/quiet-console.js',
    '--test', '--test-concurrency=1',
    ...files,
    ...extraArgs,
  ];
}

/**
 * @param {{ childArgs?: string[], extraArgs?: string[], killGraceMs?: number }} [options]
 * @returns {Promise<number>} the exit code the runner should exit with
 */
function runOwned(options = {}) {
  const { extraArgs = [], killGraceMs = KILL_GRACE_MS } = options;
  const childArgs = options.childArgs || defaultChildArgs(extraArgs);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), ROOT_PREFIX));

  return new Promise((resolve) => {
    // detached => own process group, so signals reach any grandchildren too.
    const child = spawn(process.execPath, childArgs, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      detached: true,
      env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
    });

    let signalled = null;
    let killTimer = null;
    const killGroup = (signal) => {
      try { process.kill(-child.pid, signal); } catch { /* group already gone */ }
    };
    const handlers = FORWARDED_SIGNALS.map((signal) => {
      const handler = () => {
        signalled = signalled || signal;
        killGroup(signal);
        if (!killTimer) {
          killTimer = setTimeout(() => killGroup('SIGKILL'), killGraceMs);
        }
      };
      process.on(signal, handler);
      return [signal, handler];
    });

    const finish = (code) => {
      clearTimeout(killTimer);
      for (const [signal, handler] of handlers) process.off(signal, handler);
      // Reap stragglers left in the group before removing their fixtures.
      if (signalled) killGroup('SIGKILL');
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      resolve(code);
    };

    child.on('error', (err) => {
      console.error(`test runner: failed to start tests: ${err.message}`);
      finish(1);
    });
    child.on('close', (code, signal) => {
      if (signal) finish(128 + (os.constants.signals[signal] || 0));
      else finish(code ?? 1);
    });
  });
}

module.exports = { runOwned, defaultChildArgs, ROOT_PREFIX };

if (require.main === module) {
  runOwned({ extraArgs: process.argv.slice(2) }).then((code) => process.exit(code));
}
