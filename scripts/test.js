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
 *   extra CLI arguments, and the child's exit status. Positional file or
 *   directory arguments replace the default file list; `--changed` selects the
 *   tests relevant to the branch's changes. Isolation and preloads always apply.
 * - the skip-fsync preload turns fs.fsyncSync into a descriptor check: every
 *   fixture write lands in this disposable root, so flushing it buys nothing
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

const PRELOADS = [
  '--require', './tests/quiet-console.js',
  '--require', './tests/isolated-data-root.js',
  '--require', './tests/skip-fsync.js',
];

/** Every tests/*.test.js, repo-relative and sorted. */
function allTestFiles() {
  return fs.readdirSync(path.join(REPO_ROOT, 'tests'))
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => path.join('tests', name));
}

/** Recursive *.test.js listing under an absolute directory. */
function testFilesIn(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFilesIn(full));
    else if (entry.name.endsWith('.test.js')) out.push(full);
  }
  return out.sort();
}

/** Repo-relative when inside the checkout, absolute otherwise. */
function displayPath(abs) {
  const rel = path.relative(REPO_ROOT, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs;
}

/** node --test options whose value may follow as a separate argument (never a test path). */
const VALUE_OPTIONS = new Set([
  '--require', '-r', '--import', '--test-reporter', '--test-reporter-destination', '--test-name-pattern',
  '--test-skip-pattern', '--test-concurrency', '--test-timeout', '--test-shard', '--env-file', '--watch-path',
  '--test-coverage-include', '--test-coverage-exclude',
]);

/**
 * Split CLI args into node options and explicit test selections. A non-option
 * argument that resolves to an existing file selects it; an existing directory
 * selects its *.test.js files. Anything else is forwarded untouched (it may be
 * a stray word), except a missing `.js` path or a directory with no tests, which is an error rather than a silent fallback
 * to the full suite.
 * @returns {{ options: string[], files: string[], error?: string }}
 */
function parseSelection(extraArgs, cwd = process.cwd()) {
  const options = [];
  const files = [];
  for (let i = 0; i < extraArgs.length; i += 1) {
    const arg = extraArgs[i];
    if (arg.startsWith('-')) {
      options.push(arg);
      // A space-separated value belongs to its option, even when it looks like a path.
      if (VALUE_OPTIONS.has(arg) && i + 1 < extraArgs.length) options.push(extraArgs[++i]);
      continue;
    }
    const abs = path.resolve(cwd, arg);
    let st = null;
    try { st = fs.statSync(abs); } catch { /* not a path */ }
    if (st && st.isFile()) files.push(displayPath(abs));
    else if (st && st.isDirectory()) {
      const found = testFilesIn(abs);
      if (!found.length) return { options, files, error: `no *.test.js files under ${arg}` };
      files.push(...found.map(displayPath));
    }
    else if (arg.endsWith('.js')) return { options, files, error: `test file not found: ${arg}` };
    else options.push(arg);
  }
  return { options, files: [...new Set(files)] };
}

const SOURCE_DIRS = ['src/', 'shared/', 'engines/'];

/**
 * Pick the tests relevant to a set of changed files: changed test files that
 * still exist, plus tests whose text mentions the basename of a changed
 * src/shared/engines file. Empty when nothing matches (caller runs everything).
 * @param {string[]} changed repo-relative, forward-slash paths
 * @param {string[]} testFiles repo-relative test paths
 * @param {(file: string) => string} readText
 */
function selectChangedTests(changed, testFiles, readText) {
  const norm = (f) => f.split(path.sep).join('/');
  const tests = new Set(testFiles.map(norm));
  const picked = new Set();
  const names = new Set();
  for (const file of changed.map(norm)) {
    if (tests.has(file)) picked.add(file);
    else if (SOURCE_DIRS.some((d) => file.startsWith(d)) && /\.[cm]?[jt]sx?$/.test(file)) {
      names.add(path.basename(file).replace(/\.[^.]+$/, ''));
    }
  }
  if (names.size) {
    for (const test of tests) {
      if (picked.has(test)) continue;
      const text = readText(test);
      for (const name of names) if (text.includes(name)) { picked.add(test); break; }
    }
  }
  return [...picked].sort();
}

/** Files changed vs origin/main (or main), plus uncommitted and untracked ones. Null when git cannot say. */
function gitChangedFiles() {
  const { spawnSync } = require('child_process');
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
    return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : null;
  };
  const base = ['origin/main', 'main'].find((ref) => git(['rev-parse', '--verify', '--quiet', ref]));
  if (!base) return null;
  const parts = [git(['diff', '--name-only', `${base}...HEAD`]), git(['diff', '--name-only', 'HEAD']),
    git(['ls-files', '--others', '--exclude-standard'])];
  if (parts.some((p) => p === null)) return null;
  return [...new Set(parts.flat())];
}

/** Default child command: the documented node --test invocation. */
function defaultChildArgs(extraArgs) {
  const { options, files, error } = parseSelection(extraArgs);
  if (error) throw new Error(error);
  return [...PRELOADS, '--test', ...options, ...(files.length ? files : allTestFiles())];
}

/** `--changed`: replace the flag with the relevant file selection (full suite when none match). */
function applyChanged(extraArgs) {
  if (!extraArgs.includes('--changed')) return extraArgs;
  const rest = extraArgs.filter((a) => a !== '--changed');
  const changed = gitChangedFiles();
  const picked = changed ? selectChangedTests(changed, allTestFiles(),
    (f) => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8')) : [];
  if (picked.length) {
    console.error(`test runner: ${picked.length} changed/related test file(s)`);
    return [...rest, ...picked.map((f) => path.join(REPO_ROOT, f))];
  }
  console.error('test runner: no changed tests matched; running the full suite');
  return rest;
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
  let childArgs = options.childArgs;
  if (!childArgs) {
    try { childArgs = defaultChildArgs(applyChanged(extraArgs)); } catch (error) {
      console.error(`test runner: ${error.message}`);
      return Promise.resolve(1);
    }
  }
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

module.exports = { runOwned, defaultChildArgs, parseSelection, selectChangedTests, ROOT_PREFIX };

if (require.main === module) {
  runOwned({ extraArgs: process.argv.slice(2) }).then((code) => process.exit(code));
}
