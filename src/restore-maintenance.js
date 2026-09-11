// @ts-check
/**
 * Restore Maintenance Lock
 *
 * A backup restore overwrites the same files that the gateway's own writers
 * (UpDown, sentinel, scheduled DCA) and the operator API mutate. While a
 * restore is in flight the gateway must behave as a single writer: no other
 * mutation may land between "writers confirmed stopped" and "restored files
 * applied", or the restored snapshot is silently partially overwritten.
 *
 * The lock is process-local (the gateway is a single process) and deliberately
 * dumb: acquire, release, ask. Engine processes are quiesced separately over
 * IPC — see `src/restore-coordinator.js`.
 */

/** @type {{reason: string, startedAt: number} | null} */
let activeLock = null;

/**
 * Paths (relative to the `/api` mount) that are allowed through the guard
 * because they OWN the lock. The restore endpoint must reach its handler so it
 * can report a structured 409 for a second concurrent restore.
 */
const LOCK_OWNER_PATH = /^\/backups\/[^/]+\/restore\/?$/;

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Acquire the exclusive maintenance lock.
 * @param {string} reason - Short description of the operation holding the lock
 * @returns {{acquired: boolean, heldBy?: string, sinceMs?: number}} Acquisition result
 */
const beginMaintenance = (reason) => {
  if (activeLock) {
    return { acquired: false, heldBy: activeLock.reason, sinceMs: Date.now() - activeLock.startedAt };
  }
  activeLock = { reason, startedAt: Date.now() };
  return { acquired: true };
};

/**
 * Release the exclusive maintenance lock. Safe to call when not held.
 * @returns {void}
 */
const endMaintenance = () => {
  activeLock = null;
};

/**
 * @returns {boolean} True while a maintenance operation holds the lock
 */
const isMaintenanceActive = () => activeLock !== null;

/**
 * @returns {{reason: string, startedAt: number} | null} Copy of the current lock state
 */
const getMaintenanceState = () => (activeLock ? { ...activeLock } : null);

/**
 * Express middleware (mount on `/api`) that rejects mutating requests while a
 * restore holds the lock. Reads stay available so the dashboard can still
 * render, and the restore endpoint itself is exempt so a concurrent restore
 * gets the coordinator's structured 409 instead of this 503.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
const maintenanceGuard = (req, res, next) => {
  if (!activeLock) return next();
  if (!MUTATING_METHODS.has(req.method)) return next();
  if (LOCK_OWNER_PATH.test(req.path || '')) return next();
  res.status(503).json({
    success: false,
    code: 'maintenance-in-progress',
    error: `Gateway is in maintenance (${activeLock.reason}); mutating requests are blocked until it completes`,
    heldBy: activeLock.reason,
    sinceMs: Date.now() - activeLock.startedAt,
  });
};

module.exports = {
  beginMaintenance,
  endMaintenance,
  isMaintenanceActive,
  getMaintenanceState,
  maintenanceGuard,
};
