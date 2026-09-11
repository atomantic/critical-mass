// @ts-check
/**
 * Engine-side Maintenance Window
 *
 * The gateway's maintenance lock only guards the gateway's own `/api` boundary.
 * An engine process is a separate writer with its own IPC surface, so during a
 * backup restore it can still be told to start a fund, rebuild a ladder or
 * import a trade — each of which writes the very files being replaced.
 *
 * The gateway opens a window here (over the built-in `engine:maintenance` IPC
 * channel) once it has taken the maintenance lock, and closes it when the
 * restore finishes. While the window is open the engine answers reads normally
 * and refuses everything that mutates (issue #429).
 *
 * The window ALWAYS expires on its own. A gateway that crashes mid-restore must
 * not leave an engine permanently unable to trade, and an in-memory flag cannot
 * be cleaned up by anyone else.
 */

const DEFAULT_MAINTENANCE_TTL_MS = 15 * 60_000;
const MAX_MAINTENANCE_TTL_MS = 60 * 60_000;

/**
 * Channels that stay available while the window is open: read-only queries, the
 * shutdown path the restore itself depends on, and the window control channel.
 *
 * This is an allowlist on purpose. A denylist silently admits every channel
 * added later, and the failure mode of getting it wrong here is a lost recovery
 * rather than a temporarily unavailable dashboard panel.
 */
const MAINTENANCE_SAFE_CHANNELS = new Set([
  'engine:maintenance',
  'regime:stop',
  'regime:stop-all',
  'regime:status',
  'regime:config',
  'regime:chart-data',
  'regime:fills',
  'regime:open-orders',
  'regime:unaccounted-fills',
  'regime:manual-trades',
  'regime:preview-ladder',
  'regime:dry-run-log',
  'regime:dry-run-pnl',
  'regime:dry-run-state',
]);

/** @type {{reason: string, startedAt: number, expiresAt: number} | null} */
let window_ = null;

/**
 * @returns {{reason: string, startedAt: number, expiresAt: number} | null} The active window, or null
 */
const getEngineMaintenance = () => {
  if (window_ && Date.now() >= window_.expiresAt) window_ = null;
  return window_ ? { ...window_ } : null;
};

/**
 * Open or close the maintenance window.
 *
 * @param {{active?: boolean, reason?: string, ttlMs?: number}} [payload] - Control payload from the gateway
 * @returns {{success: true, maintenance: {reason: string, startedAt: number, expiresAt: number} | null}} Acknowledgement
 */
const setEngineMaintenance = (payload = {}) => {
  if (payload?.active !== true) {
    window_ = null;
    return { success: true, maintenance: null };
  }
  const requested = Number(payload.ttlMs);
  const ttlMs = Number.isFinite(requested) && requested > 0
    ? Math.min(requested, MAX_MAINTENANCE_TTL_MS)
    : DEFAULT_MAINTENANCE_TTL_MS;
  const startedAt = Date.now();
  window_ = {
    reason: typeof payload.reason === 'string' && payload.reason ? payload.reason : 'gateway maintenance',
    startedAt,
    expiresAt: startedAt + ttlMs,
  };
  return { success: true, maintenance: { ...window_ } };
};

/**
 * Decide whether a request may run right now.
 *
 * @param {string} channel - IPC request channel
 * @returns {{success: false, code: string, error: string, heldBy: string, expiresAt: number} | null} Refusal, or null to allow
 */
const refuseDuringMaintenance = (channel) => {
  const active = getEngineMaintenance();
  if (!active || MAINTENANCE_SAFE_CHANNELS.has(channel)) return null;
  return {
    success: false,
    code: 'maintenance-in-progress',
    error: `Engine is in maintenance (${active.reason}); "${channel}" is blocked until it completes`,
    heldBy: active.reason,
    expiresAt: active.expiresAt,
  };
};

module.exports = {
  setEngineMaintenance,
  getEngineMaintenance,
  refuseDuringMaintenance,
  MAINTENANCE_SAFE_CHANNELS,
  DEFAULT_MAINTENANCE_TTL_MS,
  MAX_MAINTENANCE_TTL_MS,
};
