// @ts-check
/**
 * Shared HTTP plumbing for the exchange adapters: the request deadline and the
 * `status === 'network'` error shape that callers (reconciliation, health
 * monitor, order owners) inspect. Exchange-specific signing, error-body
 * parsing and the ambiguous-placement branches stay in each adapter.
 */

const { REST_TIMEOUT_MS } = require('../timing-constants');

/** Per-request deadline; the shared REST timeout from timing-constants. */
const DEFAULT_REQUEST_TIMEOUT_MS = REST_TIMEOUT_MS;

/**
 * Run `run(signal, controller)` under an abort deadline. The timer stays armed
 * until `run` settles, so a caller that awaits the response BODY inside `run`
 * (not just fetch headers) is covered by the same deadline, and it is always
 * cleared afterwards (success or failure).
 * @template T
 * @param {(signal: AbortSignal, controller: AbortController) => Promise<T>} run
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<T>}
 */
const withAbortTimeout = async (run, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal, controller);
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * Build the error thrown for a transport failure: `status = 'network'` plus the
 * endpoint label, and `cause` only when an underlying error is supplied.
 * @param {string} message
 * @param {string} endpoint
 * @param {any} [cause]
 * @returns {Error & {status: string, endpoint: string, cause?: any}}
 */
const createNetworkError = (message, endpoint, cause) => {
  const error = /** @type {any} */ (new Error(message));
  error.status = 'network';
  error.endpoint = endpoint;
  if (cause !== undefined) error.cause = cause;
  return error;
};

/**
 * Network error for an unauthenticated (public) request: distinguishes a
 * deadline abort ("timed out") from any other transport failure.
 * @param {string} exchangeLabel - e.g. 'Gemini', 'Crypto.com'
 * @param {string} endpoint
 * @param {any} err - The error fetch/body-read threw
 * @returns {Error & {status: string, endpoint: string, cause?: any}}
 */
const createPublicNetworkError = (exchangeLabel, endpoint, err) =>
  createNetworkError(
    err && err.name === 'AbortError'
      ? `${exchangeLabel} public request timed out for ${endpoint}`
      : `${exchangeLabel} public request failed for ${endpoint}: ${err && err.message ? err.message : String(err)}`,
    endpoint,
    err,
  );

module.exports = {
  DEFAULT_REQUEST_TIMEOUT_MS,
  withAbortTimeout,
  createNetworkError,
  createPublicNetworkError,
};
