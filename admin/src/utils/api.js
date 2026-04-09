/**
 * API URL helpers for the multi-pair fund routes.
 *
 * The gateway resolves the active fund via an optional `?pair=` query
 * parameter on every per-exchange route. When pair is omitted (or
 * undefined), the gateway falls back to the exchange's default pair —
 * which is wrong for non-default funds, so callers should always thread
 * the current pair through.
 */

/**
 * Build the `?pair=...` query string segment for a fund.
 * Returns an empty string when pair is undefined so legacy single-pair
 * installs keep working.
 */
export const pairQuery = (pair) => (pair ? `?pair=${encodeURIComponent(pair)}` : '');

/**
 * Build a complete API URL for a per-fund endpoint.
 * Example: apiUrl('coinbase', 'regime/status', 'BTC-USDC')
 *   → '/api/coinbase/regime/status?pair=BTC-USDC'
 */
export const apiUrl = (exchange, endpoint, pair) =>
  `/api/${exchange}/${endpoint}${pairQuery(pair)}`;
