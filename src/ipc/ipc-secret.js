// @ts-check
/**
 * IPC shared secret (issue #1580)
 *
 * The engine IPC WebSocket listens on loopback and drives manual trades, config
 * updates and stop/pause channels. Rejecting browser `Origin`s is not a
 * credential, so any local process could connect. The gateway and every engine
 * now share one secret that the gateway sends in a header on the upgrade
 * request and the engine compares with `crypto.timingSafeEqual`.
 *
 * Where it lives: `CRITICAL_MASS_IPC_SECRET` when set (explicit override, e.g.
 * orchestrated deployments), otherwise a 0600 file `<data dir>/ipc-secret`.
 * Gateway and engines share the data dir in the PM2, Docker and Umbrel
 * deployments. Whichever process needs the secret first creates the file
 * (written to a temp file and hard-linked into place, so a concurrent reader
 * never sees a partial value and two creators agree on one winner); the others
 * read it. Nothing needs to run before anything else, so there is no start
 * order that locks an engine out. A rollout that mixes versions degrades
 * safely: a new gateway talking to an old engine just sends an ignored header,
 * and a new engine refuses an old gateway only until the gateway restarts
 * (the client keeps reconnecting with backoff).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const IPC_SECRET_HEADER = 'x-critical-mass-ipc-secret';
const IPC_SECRET_ENV = 'CRITICAL_MASS_IPC_SECRET';
const IPC_SECRET_FILE = 'ipc-secret';

/** @type {Map<string, string>} */
const cache = new Map();

/**
 * @param {string} file
 * @returns {string} trimmed secret, or '' when absent/empty
 */
const readSecretFile = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').split('\n')[0].trim();
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return '';
    throw err;
  }
};

/**
 * Create the secret file if it does not exist, then return its contents.
 * @param {string} file
 * @returns {string}
 */
const ensureSecretFile = (file) => {
  const existing = readSecretFile(file);
  if (existing) return existing;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const candidate = crypto.randomBytes(32).toString('hex');
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${candidate}\n`, { mode: 0o600 });
  try {
    fs.linkSync(tmp, file);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const winner = readSecretFile(file);
  if (!winner) throw new Error(`IPC secret file ${file} is empty`);
  return winner;
};

/**
 * Resolve the shared IPC secret, creating the file on first use.
 * @param {{ env?: NodeJS.ProcessEnv, dataDir?: string }} [options]
 * @returns {string}
 */
const getIpcSecret = ({ env = process.env, dataDir } = {}) => {
  const fromEnv = (env[IPC_SECRET_ENV] || '').trim();
  if (fromEnv) return fromEnv;
  const dir = dataDir ?? require('../paths').DATA_DIR;
  const file = path.join(dir, IPC_SECRET_FILE);
  const cached = cache.get(file);
  if (cached) return cached;
  const secret = ensureSecretFile(file);
  cache.set(file, secret);
  return secret;
};

/**
 * Constant-time comparison of a presented secret against the expected one.
 * @param {unknown} presented
 * @param {string} expected
 * @returns {boolean}
 */
const ipcSecretMatches = (presented, expected) => {
  if (typeof presented !== 'string' || !expected) return false;
  // Hash both so unequal lengths still compare in constant time.
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
};

/** Test hook: forget cached file reads. */
const resetIpcSecretCache = () => cache.clear();

module.exports = { IPC_SECRET_HEADER, IPC_SECRET_ENV, IPC_SECRET_FILE, getIpcSecret, ipcSecretMatches, resetIpcSecretCache };
