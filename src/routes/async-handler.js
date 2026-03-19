// @ts-check
/**
 * Unified async route error wrapper for Express.
 * Catches rejected promises, logs the error, and sends a JSON error response.
 *
 * @param {string} prefix - Log prefix for error messages (e.g. 'coinbase', 'gemini')
 * @param {() => string} tsFn - Timestamp function for log formatting
 * @returns {(fn: Function) => Function}
 */
const { log } = require('../logger');

const createAsyncHandler = (prefix, tsFn) => {
  /**
   * @param {Function} fn - Async route handler
   * @returns {Function} Express middleware
   */
  return (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch((err) => {
      const message = typeof err === 'string' ? err
        : err instanceof Error ? err.message
        : err?.message ? String(err.message)
        : err?.error ? String(err.error)
        : typeof err === 'object' ? (() => { try { return JSON.stringify(err); } catch { return 'Unknown error (unserializable)'; } })()
        : 'Unknown error';
      const status = err?.status || 500;
      log('ERROR', `[${tsFn()}] ❌ ${prefix} ${req.method} ${req.path} failed: ${message}`);
      res.status(status).json({ error: message });
    });
};

module.exports = { createAsyncHandler };
