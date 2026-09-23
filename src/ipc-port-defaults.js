// @ts-check
/**
 * IPC port resolution for the gateway and exchange engines.
 *
 * `ecosystem.config.cjs`'s `PORTS` object is the single source of truth for
 * every port this app binds (API 5570, UI 5571, COINBASE_IPC 5572,
 * GEMINI_IPC 5573, CRYPTOCOM_IPC 5574). A literal fallback that disagrees
 * with it is how an engine started outside PM2 (or by hand with no
 * `*_IPC_PORT` env var set) ends up dialing the gateway's own port or the
 * Vite dev server instead of another engine's IPC socket (issue #690).
 *
 * Pure and side-effect-free — unlike requiring an `engines/*.js` file, this
 * module never starts an IPC server or binds a port, so it can be required
 * directly by tests.
 */

const { PORTS } = require('../ecosystem.config.cjs');

/** @type {Record<string, string>} */
const IPC_PORT_ENV_VAR = {
  coinbase: 'COINBASE_IPC_PORT',
  gemini: 'GEMINI_IPC_PORT',
  cryptocom: 'CRYPTOCOM_IPC_PORT',
};

/** @type {Record<string, number>} */
const IPC_PORT_DEFAULT = {
  coinbase: PORTS.COINBASE_IPC,
  gemini: PORTS.GEMINI_IPC,
  cryptocom: PORTS.CRYPTOCOM_IPC,
};

/**
 * Resolve the IPC port for one exchange engine: its own `*_IPC_PORT` env var
 * when set to a positive integer, otherwise the `ecosystem.config.cjs`
 * default for that exchange — never a bare literal that could collide with
 * the gateway or the UI dev server.
 * @param {string} exchange - 'coinbase' | 'gemini' | 'cryptocom'
 * @param {NodeJS.ProcessEnv} [env] - defaults to `process.env`; pass a plain object in tests
 * @returns {number}
 */
function resolveIpcPort(exchange, env = process.env) {
  const envVar = IPC_PORT_ENV_VAR[exchange];
  const fallback = IPC_PORT_DEFAULT[exchange];
  if (!envVar || !fallback) {
    throw new Error(`resolveIpcPort: unknown exchange "${exchange}"`);
  }
  const parsed = parseInt(env[envVar], 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

module.exports = { resolveIpcPort, IPC_PORT_ENV_VAR, IPC_PORT_DEFAULT };
