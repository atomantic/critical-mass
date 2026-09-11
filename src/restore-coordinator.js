// @ts-check
/**
 * Restore Coordinator
 *
 * Backup restore overwrites live data files in place. Doing that while any
 * writer is still alive loses the recovered state: the survivor's next
 * periodic save replaces the restored file with its own pre-restore snapshot.
 *
 * This module owns the prerequisite: prove every writer is quiescent, THEN
 * apply the archive. The core rule is that a rejected request, an IPC timeout,
 * a disconnected client, a negative acknowledgement or a malformed payload is
 * NEVER evidence that a process stopped — each of those blocks the restore and
 * leaves every destination file untouched (issue #429).
 *
 * Writers covered here:
 *  - Exchange engine processes (regime engines), stopped over IPC `regime:stop-all`
 *  - The gateway's UpDown service (contract/position/signal history/paper book)
 *
 * Other in-gateway mutations are held off by the maintenance lock in
 * `src/restore-maintenance.js` for the duration of the operation.
 */

const { beginMaintenance, endMaintenance } = require('./restore-maintenance');

/** Engines flush state on stop; give them meaningfully longer than a status poll. */
const DEFAULT_STOP_TIMEOUT_MS = 30_000;

/**
 * Classify an engine's `regime:stop-all` acknowledgement.
 *
 * Only an explicit `{ success: true, stopped: [...] }` counts as confirmed
 * quiescence. Anything else — including a truthy-but-shapeless response — is
 * treated as "unknown", which is the same as "still writing".
 *
 * @param {any} ack - Raw IPC response
 * @returns {{confirmed: boolean, reason?: string, stopped?: Array<Object>, failed?: Array<Object>, error?: string}} Classification
 */
const classifyStopAck = (ack) => {
  if (!ack || typeof ack !== 'object' || Array.isArray(ack)) {
    return { confirmed: false, reason: 'malformed-ack' };
  }
  if (ack.success !== true) {
    return {
      confirmed: false,
      reason: 'stop-reported-failure',
      error: typeof ack.error === 'string' ? ack.error : undefined,
      failed: Array.isArray(ack.failed) ? ack.failed : [],
    };
  }
  if (!Array.isArray(ack.stopped)) {
    return { confirmed: false, reason: 'malformed-ack' };
  }
  // An engine that reports both success and failed funds is self-contradictory;
  // believe the failures.
  if (Array.isArray(ack.failed) && ack.failed.length > 0) {
    return { confirmed: false, reason: 'stop-reported-failure', failed: ack.failed };
  }
  return { confirmed: true, stopped: ack.stopped, failed: [] };
};

/**
 * Ask one exchange engine to stop every regime engine it owns and classify the
 * answer. Never throws.
 *
 * @param {string} exchange - Exchange name
 * @param {{request: Function, isConnected?: () => boolean}} [ipc] - IPC client for that engine
 * @param {number} timeoutMs - Acknowledgement timeout
 * @returns {Promise<{exchange: string, confirmed: boolean, reason?: string, stopped?: Array<Object>, failed?: Array<Object>, error?: string}>} Per-exchange result
 */
const requestEngineStop = async (exchange, ipc, timeoutMs) => {
  if (!ipc || typeof ipc.request !== 'function') {
    return { exchange, confirmed: false, reason: 'no-ipc-client' };
  }
  // A dropped socket says nothing about the process behind it: the engine may
  // be mid-reconnect and still saving state on its own timers.
  if (typeof ipc.isConnected === 'function' && !ipc.isConnected()) {
    return { exchange, confirmed: false, reason: 'ipc-disconnected' };
  }

  const outcome = await ipc.request('regime:stop-all', {}, exchange, timeoutMs)
    .then((ack) => ({ ok: true, ack }), (err) => ({ ok: false, err }));

  if (!outcome.ok) {
    return {
      exchange,
      confirmed: false,
      reason: 'stop-request-failed',
      error: outcome.err?.message || String(outcome.err),
    };
  }
  return { exchange, ...classifyStopAck(outcome.ack) };
};

/**
 * Format a stopped-fund descriptor for operator-facing text.
 * @param {any} entry - `{exchange, pair}` descriptor (or a legacy string)
 * @returns {string} Human label
 */
const describeFund = (entry) => {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return 'unknown';
  return [entry.exchange, entry.pair].filter(Boolean).join(' ') || 'unknown';
};

/**
 * The restore body, run while the maintenance lock is held: confirm every
 * writer stopped, apply the archive, then reload the gateway's writers.
 *
 * The returned object is an HTTP status plus a JSON body so the route stays a
 * thin adapter and this whole flow is testable without express or real IPC.
 *
 * @param {Object} params
 * @param {string} params.filename - Backup archive filename
 * @param {boolean} [params.force] - Operator override: apply even with unconfirmed writers
 * @param {Object} params.exchangeIPCMap - Map of exchange name -> IPC client
 * @param {string[]} params.configuredExchanges - Exchanges expected to have a live engine process
 * @param {(filename: string) => {success: boolean, filesRestored?: number, error?: string}} params.restore - Archive applier
 * @param {{stop: Function, start: Function}} [params.updownService] - Gateway UpDown writer
 * @param {{info: Function, warn: Function, error: Function}} params.logger - Context logger
 * @param {number} [params.stopTimeoutMs] - Per-engine acknowledgement timeout
 * @returns {Promise<{status: number, body: Object}>} HTTP status + response body
 */
const applyRestoreUnderLock = async ({
  filename,
  force,
  exchangeIPCMap,
  configuredExchanges,
  restore,
  updownService,
  logger,
  stopTimeoutMs,
}) => {
  const startedAt = Date.now();
  logger.info(`ℹ️ 💾 Restore starting: ${filename} — draining ${configuredExchanges.length} engine process(es)`, {
    action: 'restore-backup', filename, exchanges: configuredExchanges.join(',') || 'none', force,
  });

  const acks = await Promise.all(
    configuredExchanges.map((name) => requestEngineStop(name, exchangeIPCMap[name], stopTimeoutMs))
  );

  const stoppedEngines = acks.flatMap((a) => (a.stopped || []).map(describeFund));
  const unconfirmed = acks.filter((a) => !a.confirmed).map((a) => ({
    exchange: a.exchange,
    reason: a.reason,
    ...(a.error ? { error: a.error } : {}),
    ...(a.failed?.length ? { failedFunds: a.failed } : {}),
  }));

  if (unconfirmed.length > 0) {
    const summary = unconfirmed.map((u) => `${u.exchange}:${u.reason}`).join(', ');
    if (!force) {
      logger.error(`❌ 💾 Restore blocked after ${Date.now() - startedAt}ms: writers not confirmed stopped (${summary}) — no files written`, {
        action: 'restore-backup', filename, unconfirmed: summary, elapsedMs: Date.now() - startedAt,
      });
      return { status: 409, body: {
        success: false,
        code: 'writers-not-quiesced',
        error: `Cannot restore: ${unconfirmed.length} writer(s) did not confirm shutdown (${summary}). No files were changed.`,
        unconfirmed,
        stoppedEngines,
      } };
    }
    logger.warn(`⚠️ 💾 Restore FORCED past unconfirmed writers (${summary}) — surviving writers may overwrite restored files`, {
      action: 'restore-backup', filename, unconfirmed: summary, force: true,
    });
  }

  // Gateway-local writer: stop it only once the engines are settled, so a
  // blocked restore never perturbs UpDown persistence.
  let updownDrained = false;
  if (updownService?.stop) {
    updownService.stop();
    updownDrained = true;
    logger.info('ℹ️ 💾 UpDown writer drained for restore', { action: 'restore-backup', filename });
  }

  // A throwing applier (ENOSPC mid-copy, unreadable archive) must still reach
  // the reload below — leaving UpDown dead after a failed restore would be a
  // second outage on top of the first.
  const applied = await Promise.resolve()
    .then(() => restore(filename))
    .then((r) => ({ ok: true, result: r }), (err) => ({ ok: false, err }));

  // Reload from the (possibly unchanged) files on disk before anything can
  // persist again — on failure this puts UpDown back on the pre-restore state.
  const warnings = [];
  if (updownDrained && updownService?.start) {
    const reloadError = await Promise.resolve()
      .then(() => updownService.start())
      .then(() => null, (err) => err);
    if (reloadError) {
      warnings.push(`UpDown failed to reload restored state: ${reloadError.message}`);
      logger.error(`❌ 💾 UpDown reload after restore failed: ${reloadError.message}`, {
        action: 'restore-backup', filename, error: reloadError.message,
      });
    }
  }

  const error = applied.ok
    ? (applied.result?.success === true ? null : (applied.result?.error || 'Archive applier returned no result'))
    : applied.err.message;
  if (error) {
    logger.error(`❌ 💾 Restore failed to apply ${filename}: ${error}`, {
      action: 'restore-backup', filename, error,
    });
    return { status: 500, body: { success: false, code: 'restore-failed', error, stoppedEngines, ...(warnings.length > 0 ? { warnings } : {}) } };
  }
  const result = applied.result;

  logger.info(`ℹ️ 💾 Restore complete in ${Date.now() - startedAt}ms: ${result.filesRestored} files from ${filename}, stopped=[${stoppedEngines.join(', ')}]`, {
    action: 'restore-backup', filename, filesRestored: result.filesRestored, elapsedMs: Date.now() - startedAt,
  });

  return { status: 200, body: {
    success: true,
    filesRestored: result.filesRestored,
    stoppedEngines,
    ...(force && unconfirmed.length > 0 ? { forced: true, unconfirmed } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    message: stoppedEngines.length > 0
      ? `Restored ${result.filesRestored} files. Stopped engines: ${stoppedEngines.join(', ')}. Restart engines manually from dashboard.`
      : `Restored ${result.filesRestored} files.`,
  } };
};

/**
 * Acquire the exclusive maintenance lock and run the restore under it.
 *
 * The lock is released on EVERY exit path, including a thrown fs error inside
 * the archive applier — a leaked lock would 503 every mutating API request for
 * the rest of the process lifetime.
 *
 * @param {Object} params - See `applyRestoreUnderLock`
 * @returns {Promise<{status: number, body: Object}>} HTTP status + response body
 */
const performRestore = async ({
  filename,
  force = false,
  exchangeIPCMap = {},
  configuredExchanges = [],
  restore,
  updownService,
  logger,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
}) => {
  const lock = beginMaintenance(`restore ${filename}`);
  if (!lock.acquired) {
    logger.warn(`⚠️ 💾 Restore rejected: maintenance already held by "${lock.heldBy}" for ${lock.sinceMs}ms`, {
      action: 'restore-backup', filename, heldBy: lock.heldBy, sinceMs: lock.sinceMs,
    });
    return {
      status: 409,
      body: {
        success: false,
        code: 'restore-already-running',
        error: `Another maintenance operation is in progress (${lock.heldBy})`,
      },
    };
  }

  const outcome = await applyRestoreUnderLock({
    filename, force, exchangeIPCMap, configuredExchanges, restore, updownService, logger, stopTimeoutMs,
  }).catch((err) => {
    logger.error(`❌ 💾 Restore aborted by an unexpected error on ${filename}: ${err.message}`, {
      action: 'restore-backup', filename, error: err.message,
    });
    return { status: 500, body: { success: false, code: 'restore-error', error: err.message } };
  });
  endMaintenance();
  return outcome;
};

module.exports = {
  performRestore,
  requestEngineStop,
  classifyStopAck,
  DEFAULT_STOP_TIMEOUT_MS,
};
