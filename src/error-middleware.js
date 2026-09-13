// @ts-check
/**
 * Centralized JSON error boundary (issue #530).
 *
 * Registered in server.js after every route registration, the static file
 * server, and the SPA catch-all, so it is Express's last-resort handler for
 * every rejection in the app — replacing Express's built-in final handler,
 * which responds with an HTML page containing the full stack trace (and the
 * install's filesystem path) whenever NODE_ENV isn't 'production'. Every
 * route that awaits throwing I/O without its own try/catch or `.catch()`
 * relies on Express 5 forwarding the rejected promise to this middleware via
 * `next(err)` — some routes do this explicitly via the `asyncRoute` wrapper
 * in src/routes/route-utils.js, and Express 5 also does it automatically for
 * a plain async handler/middleware, which is how the pre-auth `requireAuth`
 * 429 path (src/operator-auth.js) reaches here.
 *
 * Extracted into its own module (rather than inlined in server.js) so it can
 * be unit-tested directly — see tests/route-error-handling.test.js.
 */

const { createContextLogger } = require('./logger');

// Whether a value is a usable HTTP status code for our own response — guards
// against adapter/exchange errors whose `.status` carries a different
// convention (e.g. the string 'network' or 'unknown' set by the exchange
// adapters — see src/adapters/*/api.js), which would otherwise crash
// `res.status()` or produce a nonsensical code.
const isHttpStatus = (value) => Number.isInteger(value) && value >= 400 && value < 600;

const routeErrorLogger = createContextLogger({ module: 'server' });

/**
 * @param {(Error & { status?: unknown, statusCode?: unknown, headers?: Record<string, string> })} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
const errorMiddleware = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  const status = isHttpStatus(err?.status)
    ? err.status
    : isHttpStatus(err?.statusCode)
      ? err.statusCode
      : 500;

  // Server-side detail (message, stack) never crosses this boundary for a
  // 5xx, regardless of NODE_ENV — only the thrower's own message is relayed
  // for a 4xx, since routes throw those deliberately with an actionable
  // message (e.g. "API keys not configured").
  const message = status < 500 ? (err?.message || 'Request failed') : 'Internal server error — see engine logs';

  // Restores headers the throw site attached (e.g. Retry-After on the
  // operator-auth rate-limit path), which Express's default handler ignores.
  if (err?.headers && typeof err.headers === 'object') {
    for (const [key, value] of Object.entries(err.headers)) res.set(key, value);
  }

  routeErrorLogger.error(`❌ [${status}] ${req.method} ${req.originalUrl} → ${err?.message}`, {
    action: 'route-error',
    method: req.method,
    url: req.originalUrl,
    status,
    stack: err?.stack,
  });

  res.status(status).json({ success: false, error: message });
};

module.exports = { errorMiddleware };
