// @ts-check
/**
 * Named timing literals shared by the exchange adapters, candle cache,
 * notifier, backtest engine, order manager and regime engine. Values are the
 * previously inline numbers; changing one changes the cadence or timeout at
 * every call site that uses it.
 */

/** Per-request timeout for exchange REST calls (adapters and backtest fetches). */
const REST_TIMEOUT_MS = 30000;

/** Per-request timeout for candle-cache fetches. */
const CANDLE_FETCH_TIMEOUT_MS = 15000;

/** Per-request timeout for Telegram/notifier HTTP calls. */
const NOTIFIER_REQUEST_TIMEOUT_MS = 10000;

/** Live-mode state save cadence. Bounds how much state a crash can lose. */
const LIVE_STATE_SAVE_INTERVAL_MS = 300000;

/** Dry-run state save cadence. */
const DRY_RUN_STATE_SAVE_INTERVAL_MS = 60000;

/** Delay before re-querying fills that the exchange has not yet reported. */
const FILL_RETRY_DELAY_MS = 2000;

/** Short delay before retrying a failed order placement or TP placement. */
const PLACEMENT_RETRY_DELAY_MS = 1000;

module.exports = {
  REST_TIMEOUT_MS,
  CANDLE_FETCH_TIMEOUT_MS,
  NOTIFIER_REQUEST_TIMEOUT_MS,
  LIVE_STATE_SAVE_INTERVAL_MS,
  DRY_RUN_STATE_SAVE_INTERVAL_MS,
  FILL_RETRY_DELAY_MS,
  PLACEMENT_RETRY_DELAY_MS,
};
