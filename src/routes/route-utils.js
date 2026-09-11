// @ts-check
/**
 * Shared Route Utilities
 *
 * Common helpers used across multiple route modules.
 */

const { resolveConfiguredPair } = require('../config-utils');

/**
 * Resolve the trading pair from a request's query string, falling back to the
 * configured exchange default. Callers must handle the returned error before
 * using the pair. Named to be distinct from `req.fundPair` accessors used
 * downstream of `withConfiguredPair` (e.g. regime/backtest routes' local
 * `getFundPair`), which read the already-validated pair off the request
 * instead of resolving one from params/query.
 * @param {import('express').Request} req
 * @returns {{ pair: string | null, error: string | null }}
 */
const resolvePairParam = (req) => resolveConfiguredPair(req.params.exchange, req.query?.pair);

/**
 * Guard a pair-aware route before it can access config, IPC, or persistence.
 * The canonical pair is attached to the request so every handler forwards the
 * same configured fund identity.
 *
 * @param {(req: import('express').Request, res: import('express').Response, next?: Function) => unknown} handler
 */
const withConfiguredPair = (handler) => (req, res, next) => {
  const { pair, error } = resolvePairParam(req);
  if (error) return res.status(400).json({ success: false, error });
  req.fundPair = pair;
  return handler(req, res, next);
};

/**
 * Look up the IPC client for a given exchange. Throws if not found
 * (prevents silent fallback to the wrong exchange).
 * @param {Object} exchangeIPCMap
 * @param {string} exchange
 * @returns {Object}
 */
const getIPC = (exchangeIPCMap, exchange) => {
  const ipc = Object.prototype.hasOwnProperty.call(exchangeIPCMap, exchange)
    ? exchangeIPCMap[exchange]
    : null;
  if (!ipc || typeof ipc.request !== 'function') {
    throw new Error(`No IPC client for exchange: ${exchange}`);
  }
  return ipc;
};

/**
 * Non-throwing variant of `getIPC` for call sites (route handlers) that need
 * a client-shaped fallback instead of a synchronous throw. The fallback
 * rejects on first use so the original "no IPC client" error still surfaces,
 * just deferred to the handler's async/await or `.catch`.
 * @param {Object} exchangeIPCMap
 * @param {string} exchange
 * @returns {{ request: (...args: unknown[]) => Promise<never> } | Object}
 */
const getSafeIPC = (exchangeIPCMap, exchange) => {
  try {
    return getIPC(exchangeIPCMap, exchange);
  } catch (err) {
    return { request: () => Promise.reject(err) };
  }
};

module.exports = { resolvePairParam, getIPC, getSafeIPC, withConfiguredPair };
