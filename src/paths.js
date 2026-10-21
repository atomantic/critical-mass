// @ts-check
/**
 * Centralized path constants for data directories.
 * Single source of truth — import from here instead of re-declaring DATA_DIR.
 */

const path = require('path');

const APP_ROOT = path.join(__dirname, '..');

/**
 * Resolve the data root. CRITICAL_MASS_DATA_DIR (set by scripts/test.js to a
 * disposable temp dir) overrides <repo>/data. Under `node --test`, resolving a
 * data root inside the checkout would let a suite touch the live data the PM2
 * engines trade from, so refuse it outright.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function resolveDataDir(env = process.env) {
  const override = env.CRITICAL_MASS_DATA_DIR;
  const dataDir = override ? path.resolve(override) : path.join(APP_ROOT, 'data');
  if (env.NODE_TEST_CONTEXT) {
    const rel = path.relative(APP_ROOT, dataDir);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      throw new Error(
        `Refusing to resolve DATA_DIR (${dataDir}) inside the repository checkout under node --test. ` +
        'Run tests via `npm test` (scripts/test.js sets CRITICAL_MASS_DATA_DIR to a disposable temp dir), ' +
        'set CRITICAL_MASS_DATA_DIR to a directory outside the checkout, or use createIsolatedDataDir from tests/test-data-dir.js.'
      );
    }
  }
  return dataDir;
}

const DATA_DIR = resolveDataDir();
const UPDOWN_DATA_DIR = path.join(DATA_DIR, 'updown');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEYS_DIR = path.join(APP_ROOT, 'keys');

module.exports = { resolveDataDir, APP_ROOT, DATA_DIR, UPDOWN_DATA_DIR, BACKUP_DIR, KEYS_DIR };
