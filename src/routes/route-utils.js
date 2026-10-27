// @ts-check
/**
 * Shared Route Utilities
 *
 * Common helpers used across multiple route modules.
 */

const { resolveConfiguredPair } = require('../config-utils');
const { IPC_ERROR_CODE } = require('../ipc/ipc-protocol');
const { createContextLogger } = require('../logger');

const routeUtilsLogger = createContextLogger({ module: 'route-utils' });

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

/**
 * Bind `getSafeIPC` to a route module's exchange->client map so handlers can
 * call `getIPC(exchange)` without re-declaring the closure.
 * @param {Object} exchangeIPCMap
 * @returns {(exchange: string) => Object}
 */
const createIPCResolver = (exchangeIPCMap) => (exchange) => getSafeIPC(exchangeIPCMap, exchange);

// ---------------------------------------------------------------------------
// Engine IPC failure contract
//
// A gateway->engine request can fail three ways, and each maps to one HTTP
// status (see IPC_ERROR_CODE in ipc-protocol.js):
//   - transport / timeout (or an untagged rejection, e.g. a missing client):
//       the engine is unreachable            -> 503 "Engine unavailable: ..."
//   - handler (the engine answered with an error reply; its handler threw):
//       the engine is healthy, the request blew up -> 500, raw message logged
//       server-side only (same policy as error-middleware.js for 5xx)
//   - a resolved `{ success: false, ... }` domain reply:
//       the engine refused the request       -> its explicit `statusCode`, else 400
//       admission's engine-busy keeps its structured code and statusCode:503
// The failure kind rides on `engineError`'s result under a non-enumerable
// symbol so it never reaches the JSON body or deepEqual comparisons.
// ---------------------------------------------------------------------------

const IPC_FAILURE_STATUS = Symbol('ipcFailureStatus');
const IPC_FAILURE_KIND = Symbol('ipcFailureKind');

const HANDLER_FAILURE_MESSAGE = 'Internal server error — see engine logs';

/**
 * Turn a rejected IPC request into a `{ success: false, error }` result carrying
 * its HTTP status. Use as `ipc.request(...).catch(engineError)`.
 * @param {Error & {code?: string}} err
 * @returns {{success: false, error: string}}
 */
const engineError = (err) => {
  const handlerFailure = err?.code === IPC_ERROR_CODE.HANDLER;
  if (handlerFailure) {
    routeUtilsLogger.error(`❌ Engine handler failed: ${err.message}`, { action: 'engine-handler-error', error: err.message });
  }
  const result = {
    success: false,
    error: handlerFailure ? HANDLER_FAILURE_MESSAGE : `Engine unavailable: ${err?.message}`,
  };
  Object.defineProperty(result, IPC_FAILURE_STATUS, { value: handlerFailure ? 500 : 503 });
  Object.defineProperty(result, IPC_FAILURE_KIND, {
    value: handlerFailure ? IPC_ERROR_CODE.HANDLER : (err?.code === IPC_ERROR_CODE.TIMEOUT ? IPC_ERROR_CODE.TIMEOUT : IPC_ERROR_CODE.TRANSPORT),
  });
  return result;
};

/**
 * Failure kind of a result produced by `engineError`, or null for an engine
 * domain reply.
 * @param {Object} result
 * @returns {string | null}
 */
const ipcFailureKind = (result) => result?.[IPC_FAILURE_KIND] ?? null;

/**
 * HTTP status and body for a failed engine result (see contract above).
 * @param {{error?: string, statusCode?: number}} result - `engineError` output or an engine `{success:false}` reply
 * @returns {{status: number, body: Object}}
 */
const ipcFailureResponse = (result) => {
  const tagged = result?.[IPC_FAILURE_STATUS];
  if (tagged) return { status: tagged, body: result };
  const explicit = result?.statusCode;
  return { status: Number.isInteger(explicit) && explicit >= 400 && explicit < 600 ? explicit : 400, body: result };
};

/**
 * Send the response for a failed engine result.
 * @param {import('express').Response} res
 * @param {Object} result
 */
const sendIpcFailure = (res, result) => {
  const { status, body } = ipcFailureResponse(result);
  return res.status(status).json(body);
};

/**
 * Wrap an async route handler so a thrown error or rejected promise is
 * forwarded to Express's error pipeline via `next(err)` — funneled into the
 * JSON error-handling middleware registered in server.js — instead of
 * becoming an unhandled rejection or falling through to Express's built-in
 * HTML error page (issue #530). Express 5 already forwards a rejected
 * handler promise to `next(err)` automatically, but wrapping keeps each
 * route's failure handling explicit at the call site rather than relying
 * solely on that framework behavior.
 * Returns the settled promise (always resolved, never rejected — a thrown
 * error is routed to `next` rather than propagated) so callers that await a
 * handler directly, such as route-level unit tests invoking it with a fake
 * `req`/`res`, still observe completion before making assertions.
 * @param {(req: import('express').Request, res: import('express').Response, next: Function) => unknown} handler
 */
/**
 * Whether an error or result is a typed DCA admission refusal (issue #1814).
 * @param {unknown} value
 * @returns {boolean}
 */
const isDcaBusy = (value) => Boolean(
  value && typeof value === 'object' && ('code' in value || 'name' in value) &&
    (/** @type {any} */ (value).code === 'dca-busy' || /** @type {any} */ (value).name === 'DcaBusyError')
);

/**
 * Send a 503 response for a DCA admission refusal carrying Retry-After (issue #1814).
 * @param {import('express').Response} res
 * @param {any} failure
 */
const sendDcaBusyResponse = (res, failure) => {
  const retryAfter = failure?.retryAfter ?? 1;
  if (typeof res.set === 'function') {
    res.set('Retry-After', String(retryAfter));
  } else if (typeof res.setHeader === 'function') {
    res.setHeader('Retry-After', String(retryAfter));
  }
  return res.status(503).json({
    success: false,
    code: 'dca-busy',
    error: failure?.message || failure?.error || 'DCA engine queue is full; retry after outstanding operations complete',
    retryAfter: Number(retryAfter) || 1,
  });
};

const asyncRoute = (handler) => (req, res, next) =>
  Promise.resolve()
    .then(() => handler(req, res, next))
    .catch((err) => {
      if (isDcaBusy(err)) {
        return sendDcaBusyResponse(res, err);
      }
      return next(err);
    });

/**
 * HTTP status for a manual DCA trade result. An accepted buy whose fill is
 * still being recovered answers 202 Accepted (the exchange took the order; a
 * retry resumes it and will not buy again), distinct from a definitive
 * rejection, which propagates as an error (issue #963). Capacity refusals
 * map to 503 (issue #1814). Everything else is 200.
 * @param {{status?: string, code?: string}} result - runIntervalCycle result
 * @returns {number} HTTP status code
 */
const tradeResultStatusCode = (result) => {
  if (result?.code === 'dca-busy') return 503;
  return result?.status === 'buy_fill_pending' ? 202 : 200;
};

const MAX_PAGE_LIMIT = 500;

/**
 * Bounded paging for list endpoints. Always returns `{ limit, offset }`: a missing
 * or invalid `limit` falls back to `defaultLimit` (MAX_PAGE_LIMIT unless given) and
 * any limit is capped at MAX_PAGE_LIMIT, so an unpaged request is never unbounded.
 * @param {Object} query - Express req.query
 * @param {number} [defaultLimit] - limit used when the request sends none
 * @returns {{limit: number, offset: number}}
 */
const parsePaging = (query, defaultLimit = MAX_PAGE_LIMIT) => {
  const limit = parseInt(query?.limit, 10);
  const offset = parseInt(query?.offset, 10);
  return {
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_PAGE_LIMIT) : Math.min(defaultLimit, MAX_PAGE_LIMIT),
    offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
  };
};

/**
 * The one paged-list envelope: `{ success, items, total, limit, offset }`. `alias`
 * also publishes the page under a legacy key (`trades`, `alerts`) for one release.
 * @param {Array} all - the full list
 * @param {{limit: number, offset: number}} paging
 * @param {string} [alias]
 */
const pagedEnvelope = (all, paging, alias) => {
  const items = all.slice(paging.offset, paging.offset + paging.limit);
  return { success: true, items, ...(alias && { [alias]: items }), total: all.length, limit: paging.limit, offset: paging.offset };
};

module.exports = { parsePaging, pagedEnvelope, MAX_PAGE_LIMIT, resolvePairParam, getIPC, getSafeIPC, createIPCResolver, engineError, ipcFailureKind, ipcFailureResponse, sendIpcFailure, withConfiguredPair, asyncRoute, tradeResultStatusCode, isDcaBusy, sendDcaBusyResponse };
