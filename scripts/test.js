#!/usr/bin/env node
// @ts-check
/**
 * `npm test` runner. Runs the Node test runner with a runner-owned, disposable
 * temp root so a suite that forgets to clean up its fixtures cannot leave them
 * in the shared system temp directory.
 *
 * - allocates one unique root under os.tmpdir() and points TMPDIR/TMP/TEMP at it,
 *   plus CRITICAL_MASS_DATA_DIR at <root>/data (the suite never sees the live data/);
 *   the isolated-data-root preload narrows that to one subdirectory per test file
 *   process, so concurrently running files never share fixtures
 * - preserves the quiet-console preload, the tests/*.test.js selection and any
 *   extra CLI arguments, and the child's exit status
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
const { stopProcessGroup } = require('./lib/process-group');

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
    '--require', './tests/isolated-data-root.js',
    '--test',
    ...extraArgs,
    ...files,
  ];
}

/** Sorted recursive listing (path, size, mtime) of the checkout's data/, or [] if absent. */
function listLiveData() {
  const base = path.join(REPO_ROOT, 'data');
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let st;
      try { st = fs.lstatSync(full); } catch { continue; } // vanished mid-walk
      out.push(`${path.relative(base, full)}:${st.size}:${st.mtimeMs}`);
      if (entry.isDirectory()) walk(full);
    }
  };
  if (fs.existsSync(base)) walk(base);
  return out.sort();
}

/**
 * @param {{ childArgs?: string[], extraArgs?: string[], killGraceMs?: number }} [options]
 * @returns {Promise<number>} the exit code the runner should exit with
 */
function runOwned(options = {}) {
  const { extraArgs = [], killGraceMs = KILL_GRACE_MS } = options;
  const childArgs = options.childArgs || defaultChildArgs(extraArgs);
  // CI only: on a dev box the PM2 engines legitimately write data/ while tests run.
  const liveBefore = !options.childArgs && process.env.CI ? listLiveData() : null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), ROOT_PREFIX));
  // Disposable data root: src/paths.js resolves DATA_DIR from this, so the
  // suite can never reach the checkout's live data/.
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(dataRoot);

  return new Promise((resolve) => {
    // detached => own process group, so signals reach any grandchildren too.
    const child = spawn(process.execPath, childArgs, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      detached: true,
      env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root, CRITICAL_MASS_DATA_DIR: dataRoot },
    });

    let killTimer = null;
    let finishing = false;
    const killGroup = (signal) => {
      if (!child.pid) return false;
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch (error) {
        if (error.code === 'ESRCH') return false;
        throw error;
      }
    };
    const handlers = FORWARDED_SIGNALS.map((signal) => {
      const handler = () => {
        if (finishing) return;
        killGroup(signal);
        if (!killTimer) {
          killTimer = setTimeout(() => killGroup('SIGKILL'), killGraceMs);
        }
      };
      process.on(signal, handler);
      return [signal, handler];
    });

    const finish = async (code) => {
      if (finishing) return;
      finishing = true;
      clearTimeout(killTimer);
      try {
        // A successful direct child can still leave stdio-detached descendants.
        // Stop the owned group on EVERY exit, before deleting its fixtures.
        await stopProcessGroup(child.pid);
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch (error) {
        console.error(`test runner: cleanup failed; retaining its temporary root: ${error.message}`);
        code = 1;
      }
      if (liveBefore && JSON.stringify(listLiveData()) !== JSON.stringify(liveBefore)) {
        console.error('test runner: the suite created or modified files under the checkout\'s data/ (or the engine did concurrently); tests must use the disposable data root');
        code = code || 1;
      }
      for (const [signal, handler] of handlers) process.off(signal, handler);
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
