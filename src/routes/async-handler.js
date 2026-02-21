// @ts-check
/**
 * Unified async route error wrapper for Express.
 * Catches rejected promises and forwards to Express error handling.
 *
 * @param {string} prefix - Log prefix for error messages (e.g. 'kalshi', 'hedge')
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
        : typeof err === 'object' ? JSON.stringify(err)
        : 'Unknown error';
      const status = err?.status || 500;
      log('ERROR', `[${tsFn()}] ❌ ${prefix} ${req.method} ${req.path} failed: ${message}`);
      res.status(status).json({ error: message });
    });
};

module.exports = { createAsyncHandler };
