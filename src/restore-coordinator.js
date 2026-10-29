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
 *  - Gateway services that own archived files: UpDown (contract/position/signal
 *    history/paper book) and Sentinel (alerts/seen items) — each stopped before
 *    the copy and reloaded from the restored files afterwards
 *  - Gateway work that was ALREADY running when the lock was taken (a scheduled
 *    DCA cycle), joined via `src/pending-writes.js`
 *
 * Engine processes are additionally put into a maintenance window over IPC so
 * they refuse mutating requests for the duration; other in-gateway mutations are
 * held off by the maintenance lock in `src/restore-maintenance.js`.
 */

const { beginMaintenance, endMaintenance } = require('./restore-maintenance');
const { IPC_CHANNELS } = require('./ipc/ipc-protocol');
const { FILL_DRAIN_MS } = require('./engine-locks');

/** Engines flush state on stop; give them meaningfully longer than a status poll. */
const DEFAULT_STOP_TIMEOUT_MS = 30_000;

/** A fund start drains fills and reconciles orders; match the dashboard's Start timeout. */
const DEFAULT_START_TIMEOUT_MS = FILL_DRAIN_MS + 50_000;

/** How long to wait for gateway work that was already in flight to finish. */
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

/**
 * Lifetime of the engine-side maintenance window. It must outlast the slowest
 * restore, and it must expire on its own so a gateway that dies mid-restore
 * cannot leave an engine permanently unable to trade.
 */
const ENGINE_MAINTENANCE_TTL_MS = 15 * 60_000;

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

  const outcome = await ipc.request(IPC_CHANNELS.REGIME_STOP_ALL, {}, exchange, timeoutMs)
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
 * Open or close the engine-side maintenance window on every configured engine.
 *
 * Best effort by design: an engine we cannot reach has to fail the stop gate
 * anyway, so a missed window is never the thing that decides a restore.
 *
 * @param {Object} params
 * @param {Object} params.exchangeIPCMap - Map of exchange name -> IPC client
 * @param {string[]} params.configuredExchanges - Exchanges with a live engine process
 * @param {boolean} params.active - Open (true) or close (false) the window
 * @param {string} params.reason - Operator-facing reason shown in engine refusals
 * @param {{info: Function, warn: Function, error: Function}} params.logger - Context logger
 * @param {number} params.timeoutMs - Per-engine acknowledgement timeout
 * @returns {Promise<string[]>} Exchanges that acknowledged
 */
const setEngineMaintenanceWindows = async ({ exchangeIPCMap, configuredExchanges, active, reason, logger, timeoutMs }) => {
  const results = await Promise.all(configuredExchanges.map(async (exchange) => {
    const ipc = exchangeIPCMap[exchange];
    if (!ipc || typeof ipc.request !== 'function') return null;
    // A client that already knows it is disconnected has nothing to tell; the
    // stop gate below is what decides whether that engine blocks the restore.
    if (typeof ipc.isConnected === 'function' && !ipc.isConnected()) return null;
    const failure = await ipc
      .request(IPC_CHANNELS.ENGINE_MAINTENANCE, { active, kind: 'restore', reason, ttlMs: ENGINE_MAINTENANCE_TTL_MS }, exchange, timeoutMs)
      .then(() => null, (err) => err);
    if (failure) {
      logger.warn(`⚠️ 💾 Engine "${exchange}" did not acknowledge the maintenance window (${active ? 'open' : 'close'}): ${failure.message}`, {
        action: 'restore-backup', exchange, active, error: failure.message,
      });
      return null;
    }
    return exchange;
  }));
  return results.filter((name) => name !== null);
};

/**
 * Stop a gateway-local writer, tolerating a throwing stop().
 *
 * @param {{name: string, stop?: Function}} writer - Writer descriptor
 * @param {{info: Function, warn: Function, error: Function}} logger - Context logger
 * @param {string} filename - Backup filename (log context)
 * @returns {Promise<Error|null>} The failure, if stopping threw
 */
const stopGatewayWriter = async (writer, logger, filename) => {
  if (typeof writer.stop !== 'function') return null;
  const failure = await Promise.resolve().then(() => writer.stop()).then(() => null, (err) => err);
  if (failure) {
    logger.error(`❌ 💾 ${writer.name} writer failed to drain for restore: ${failure.message}`, {
      action: 'restore-backup', filename, writer: writer.name, error: failure.message,
    });
    return failure;
  }
  logger.info(`ℹ️ 💾 ${writer.name} writer drained for restore`, { action: 'restore-backup', filename, writer: writer.name });
  return null;
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
 * Restart the funds a refused restore stopped, through the same `regime:start`
 * path the dashboard uses. Funds on one engine start one after another (as at
 * engine boot); engines start in parallel. Never throws.
 *
 * The caller must have closed the engine maintenance windows first — an engine
 * refuses `regime:start` while its restore window is open.
 *
 * @param {Object} params
 * @param {Array<any>} params.funds - `{exchange, pair}` descriptors from the stop acknowledgements
 * @param {Object} params.exchangeIPCMap - Map of exchange name -> IPC client
 * @param {{info: Function, warn: Function, error: Function}} params.logger - Context logger
 * @param {string} params.filename - Backup filename (log context)
 * @param {number} params.timeoutMs - Per-fund start acknowledgement timeout
 * @returns {Promise<{restarted: string[], failed: Array<{fund: string, error: string}>}>} Outcome per fund
 */
const restartStoppedFunds = async ({ funds, exchangeIPCMap, logger, filename, timeoutMs }) => {
  const byExchange = new Map();
  const failed = [];
  for (const entry of funds) {
    if (!entry || typeof entry !== 'object' || !entry.exchange || !entry.pair) {
      failed.push({ fund: describeFund(entry), error: 'fund identity unknown' });
      continue;
    }
    if (!byExchange.has(entry.exchange)) byExchange.set(entry.exchange, []);
    byExchange.get(entry.exchange).push(entry.pair);
  }

  const restarted = [];
  await Promise.all([...byExchange].map(async ([exchange, pairs]) => {
    const ipc = exchangeIPCMap[exchange];
    for (const pair of pairs) {
      const fund = describeFund({ exchange, pair });
      const outcome = !ipc || typeof ipc.request !== 'function'
        ? { error: 'no IPC client' }
        : await ipc.request(IPC_CHANNELS.REGIME_START, {}, exchange, pair, timeoutMs).then(
          (ack) => (ack?.success === true ? {} : { error: (typeof ack?.error === 'string' && ack.error) || 'engine refused the start' }),
          (err) => ({ error: err?.message || String(err) }),
        );
      if (outcome.error) {
        failed.push({ fund, error: outcome.error });
        logger.error(`❌ 💾 Could not restart ${fund} after the refused restore of ${filename}: ${outcome.error}`, {
          action: 'restore-backup', filename, exchange, pair, error: outcome.error,
        });
      } else {
        restarted.push(fund);
        logger.info(`ℹ️ 💾 Restarted ${fund} after the refused restore of ${filename}`, { action: 'restore-backup', filename, exchange, pair });
      }
    }
  }));
  return { restarted, failed };
};

/**
 * Engines are stopped (and their running flags cleared) before the restore can
 * refuse. Say in the operator-facing error what happened to them: restarted,
 * or still stopped and needing a manual restart.
 * @param {string} error
 * @param {{restarted: string[], failed: Array<{fund: string, error: string}>}} restart
 * @returns {string}
 */
const noteRestartOutcome = (error, { restarted, failed }) => {
  const notes = [
    restarted.length > 0 ? `Engines stopped for the restore were restarted: ${restarted.join(', ')}.` : null,
    failed.length > 0
      ? `Engines stopped for the restore are still stopped: ${failed.map((f) => `${f.fund} (${f.error})`).join(', ')} — restart them from the dashboard.`
      : null,
  ].filter(Boolean);
  if (notes.length === 0) return error;
  return `${error}${/[.!?]$/.test(error) ? '' : '.'} ${notes.join(' ')}`;
};

/**
 * Archive the live data directory once every writer has stopped and before any
 * destination changes. A committed restore discards its rollback copies, so
 * this archive is the only way back from restoring the wrong or an older
 * archive. It fails open: restore is also the remedy for a corrupt config or
 * data file, the same damage that can make archiving fail.
 * @param {(() => Promise<{success: boolean, filename?: string, error?: string}>) | undefined} createRecoveryPoint
 * @param {{info: Function, error: Function}} logger
 * @param {string} filename - Archive being restored, for log context
 * @returns {Promise<{filename: string} | {error: string} | null>} null when no recovery point is configured
 */
const saveRecoveryPoint = async (createRecoveryPoint, logger, filename) => {
  if (!createRecoveryPoint) return null;
  const result = await Promise.resolve()
    .then(() => createRecoveryPoint())
    .then((r) => r, (err) => ({ success: false, error: err.message }));
  if (result?.success === true && typeof result.filename === 'string') {
    logger.info(`ℹ️ 💾 Pre-restore recovery archive saved: ${result.filename}`, {
      action: 'restore-backup', filename, recoveryPoint: result.filename,
    });
    return { filename: result.filename };
  }
  const error = result?.error || 'archive creation returned no file';
  logger.error(`❌ 💾 Pre-restore recovery archive failed before restoring ${filename}: ${error} — continuing without an undo point`, {
    action: 'restore-backup', filename, error,
  });
  return { error };
};

/**
 * The restore body, run while the maintenance lock is held: confirm every
 * writer stopped, apply the archive, then reload the gateway's writers and
 * drop the caches that still mirror the pre-restore files.
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
 * @param {Array<{name: string, stop?: Function, resume?: Function}>} params.gatewayWriters - Gateway services owning archived files
 * @param {(timeoutMs: number) => Promise<{drained: boolean, pending: Array<{label: string, runningMs: number}>}>} [params.drainPendingWrites] - Join for work already in flight
 * @param {() => any} [params.invalidateCaches] - Drops in-memory views of the restored files
 * @param {() => Promise<{success: boolean, filename?: string, error?: string}>} [params.createRecoveryPoint] - Archives the live data before it is replaced
 * @param {{info: Function, warn: Function, error: Function}} params.logger - Context logger
 * @param {number} params.stopTimeoutMs - Per-engine acknowledgement timeout
 * @param {number} params.drainTimeoutMs - How long to wait for in-flight gateway work
 * @returns {Promise<{status: number, body: Object, restartFunds?: Array<Object>}>} HTTP status + response body,
 *   plus the stopped funds that are safe to restart when the restore refused
 */
const applyRestoreUnderLock = async ({
  filename,
  force,
  exchangeIPCMap,
  configuredExchanges,
  restore,
  gatewayWriters,
  drainPendingWrites,
  invalidateCaches,
  createRecoveryPoint,
  logger,
  stopTimeoutMs,
  drainTimeoutMs,
}) => {
  const startedAt = Date.now();
  logger.info(`ℹ️ 💾 Restore starting: ${filename} — draining ${configuredExchanges.length} engine process(es) and ${gatewayWriters.length} gateway writer(s)`, {
    action: 'restore-backup', filename, exchanges: configuredExchanges.join(',') || 'none', force,
  });

  // Engines and already-running gateway work are independent writers; drain
  // both before deciding anything.
  const [acks, drain] = await Promise.all([
    Promise.all(configuredExchanges.map((name) => requestEngineStop(name, exchangeIPCMap[name], stopTimeoutMs))),
    drainPendingWrites
      ? drainPendingWrites(drainTimeoutMs)
      : Promise.resolve({ drained: true, pending: [] }),
  ]);

  const stoppedFunds = acks.flatMap((a) => a.stopped || []);
  const stoppedEngines = stoppedFunds.map(describeFund);
  const unconfirmed = acks.filter((a) => !a.confirmed).map((a) => ({
    exchange: a.exchange,
    reason: a.reason,
    ...(a.error ? { error: a.error } : {}),
    ...(a.failed?.length ? { failedFunds: a.failed } : {}),
  }));
  // Work still running after the drain window is exactly as dangerous as an
  // engine that never confirmed: it is writing the files we are about to
  // replace, and we cannot observe when it stops.
  if (!drain.drained) {
    unconfirmed.push({
      exchange: 'gateway',
      reason: 'pending-writes-in-flight',
      error: `Still running after ${drainTimeoutMs}ms: ${drain.pending.map((w) => w.label).join(', ')}`,
      pendingWrites: drain.pending,
    });
  }

  if (unconfirmed.length > 0) {
    const summary = unconfirmed.map((u) => `${u.exchange}:${u.reason}`).join(', ');
    if (!force) {
      logger.error(`❌ 💾 Restore blocked after ${Date.now() - startedAt}ms: writers not confirmed stopped (${summary}) — no files written`, {
        action: 'restore-backup', filename, unconfirmed: summary, elapsedMs: Date.now() - startedAt,
      });
      // Nothing was written, so the funds that did stop can trade again.
      return { status: 409, restartFunds: stoppedFunds, body: {
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

  // Gateway-local writers: stop them only once the engines are settled, so a
  // blocked restore never perturbs their persistence.
  const warnings = [];
  const drainedWriters = [];
  for (const writer of gatewayWriters) {
    const failure = await stopGatewayWriter(writer, logger, filename);
    if (failure) {
      warnings.push(`${writer.name} failed to drain cleanly: ${failure.message}`);
      unconfirmed.push({ exchange: 'gateway', writer: writer.name, reason: 'gateway-writer-stop-failed', error: failure.message });
    }
    // Resume it regardless: a writer whose stop() threw is in an unknown state,
    // and leaving it dead after the restore is a second outage on top of the first.
    drainedWriters.push(writer);
  }

  // The initial drain only joined work admitted before the engines settled;
  // a producer that was still live (e.g. an UpDown scorecard append that already
  // owns the maintenance lock) may have registered since. Join it now that every
  // gateway-local producer is stopped, before anything is archived or replaced.
  if (drainPendingWrites) {
    const lateDrain = await drainPendingWrites(drainTimeoutMs);
    if (!lateDrain.drained) {
      unconfirmed.push({
        exchange: 'gateway',
        reason: 'pending-writes-in-flight',
        error: `Still running after ${drainTimeoutMs}ms once gateway writers stopped: ${lateDrain.pending.map((w) => w.label).join(', ')}`,
        pendingWrites: lateDrain.pending,
      });
      if (force) {
        logger.warn(`⚠️ 💾 Restore FORCED past late pending writes (${lateDrain.pending.map((w) => w.label).join(', ')})`, {
          action: 'restore-backup', filename, force: true,
        });
      }
    }
  }

  const proceed = unconfirmed.length === 0 || force;
  const recoveryPoint = proceed ? await saveRecoveryPoint(createRecoveryPoint, logger, filename) : null;
  if (recoveryPoint && 'error' in recoveryPoint) {
    warnings.push(`Could not save a pre-restore recovery archive (${recoveryPoint.error}); this restore cannot be undone from an archive.`);
  }

  // A throwing applier (ENOSPC mid-copy, unreadable archive) must still reach
  // the reload below.
  const applied = await Promise.resolve()
    .then(() => !proceed
      ? { success: false, code: 'writers-not-quiesced', error: 'Gateway writers did not confirm shutdown. No files were changed.', rolledBack: true }
      : restore(filename))
    .then((r) => ({ ok: true, result: r }), (err) => ({ ok: false, err }));

  // Reload from the (possibly unchanged) files on disk before anything can
  // persist again — on failure this puts each writer back on the pre-restore state.
  // An incomplete rollback is not safe to load or persist. Keep services stopped
  // until a process restart completes the durable journal's recovery.
  const recoveryBlocked = applied.ok && applied.result?.rolledBack === false;
  for (const writer of recoveryBlocked ? [] : drainedWriters.reverse()) {
    if (typeof writer.resume !== 'function') continue;
    const reloadError = await Promise.resolve().then(() => writer.resume()).then(() => null, (err) => err);
    if (reloadError) {
      warnings.push(`${writer.name} failed to reload restored state: ${reloadError.message}`);
      logger.error(`❌ 💾 ${writer.name} reload after restore failed: ${reloadError.message}`, {
        action: 'restore-backup', filename, writer: writer.name, error: reloadError.message,
      });
    }
  }

  // In-memory views of the replaced files outlive the copy. Drop them before
  // the maintenance lock is released, or the first post-restore request is
  // answered from the pre-restore snapshot.
  if (invalidateCaches) {
    const cacheError = await Promise.resolve().then(() => invalidateCaches()).then(() => null, (err) => err);
    if (cacheError) {
      warnings.push(`Cache invalidation failed: ${cacheError.message}`);
      logger.error(`❌ 💾 Cache invalidation after restore failed: ${cacheError.message}`, {
        action: 'restore-backup', filename, error: cacheError.message,
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
    // Surface the applier's own code (e.g. a legacy archive with no
    // configuration manifest) so the UI can offer the right next step (#430).
    const code = typeof applied.result?.code === 'string' ? applied.result.code : 'restore-failed';
    // `rolledBack: false` means the data directory is a mixed generation and the
    // rollback artifacts are being retained for a retry — the UI must say so
    // rather than presenting this as a plain failed restore (#431). Engines stay
    // down until recovery then: trading on a mixed generation is the one thing
    // worse than a stopped fund. Otherwise the destination is back on its
    // pre-restore bytes and the stopped funds can resume.
    return { status: code === 'writers-not-quiesced' ? 409 : 500, restartFunds: recoveryBlocked ? [] : stoppedFunds, body: {
      success: false,
      code,
      ...(unconfirmed.length > 0 ? { unconfirmed } : {}),
      error,
      stoppedEngines,
      ...(recoveryBlocked ? { rolledBack: false } : {}),
      ...(applied.result?.recovery ? { recovery: applied.result.recovery } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    } };
  }
  const result = applied.result;

  logger.info(`ℹ️ 💾 Restore complete in ${Date.now() - startedAt}ms: ${result.filesRestored} files from ${filename}, stopped=[${stoppedEngines.join(', ')}]`, {
    action: 'restore-backup', filename, filesRestored: result.filesRestored, elapsedMs: Date.now() - startedAt,
  });

  const savedRecoveryPoint = recoveryPoint && 'filename' in recoveryPoint ? recoveryPoint.filename : null;
  const restoredText = `Restored ${result.filesRestored} ${result.filesRestored === 1 ? 'file' : 'files'}.`;
  return { status: 200, body: {
    success: true,
    filesRestored: result.filesRestored,
    configRestored: result.configRestored === true,
    legacy: result.legacy === true,
    stoppedEngines,
    ...(savedRecoveryPoint ? { recoveryPoint: savedRecoveryPoint } : {}),
    ...(force && unconfirmed.length > 0 ? { forced: true, unconfirmed } : {}),
    ...(warnings.length + (result.warnings?.length ?? 0) > 0 ? { warnings: [...warnings, ...(result.warnings ?? [])] } : {}),
    message: [
      restoredText,
      savedRecoveryPoint ? `The data it replaced is saved as ${savedRecoveryPoint}; restore that backup to undo.` : null,
      stoppedEngines.length > 0 ? `Stopped engines: ${stoppedEngines.join(', ')}. Restart engines manually from dashboard.` : null,
    ].filter(Boolean).join(' '),
  } };
};

/**
 * Acquire the exclusive maintenance lock, put every engine into its maintenance
 * window, and run the restore under both.
 *
 * `preflight` runs first, before any engine window opens or any engine is asked
 * to stop: a restore that its archive or acknowledgements would refuse anyway
 * refuses with every fund still running. When the restore still refuses after
 * engines stopped (an unconfirmed writer, or an applier failure that rolled
 * back), the stopped funds are restarted once the engine windows close and the
 * response reports `restartedEngines` / `restartFailed`. An incomplete rollback
 * (`rolledBack: false`) restarts nothing (#1384).
 *
 * The lock and engine windows are released on ordinary exits, including a
 * thrown fs error inside the archive applier — a leaked lock would 503 every
 * mutating API request for the rest of the process lifetime, and a leaked
 * engine window would refuse trading until its TTL expired. An incomplete
 * rollback retains the gateway lock until startup recovery proves coherence.
 *
 * @param {Object} params - See `applyRestoreUnderLock`, plus:
 * @param {() => Promise<{ok: boolean, code?: string, error?: string}> | {ok: boolean, code?: string, error?: string}} [params.preflight]
 *   - Archive and acknowledgement checks that need no writer stopped
 * @param {number} [params.startTimeoutMs] - Per-fund restart acknowledgement timeout
 * @returns {Promise<{status: number, body: Object}>} HTTP status + response body
 */
const performRestore = async ({
  filename,
  force = false,
  exchangeIPCMap = {},
  configuredExchanges = [],
  restore,
  gatewayWriters = [],
  drainPendingWrites,
  invalidateCaches,
  createRecoveryPoint,
  logger,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
  drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
  startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  preflight,
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

  // Checked under the lock so no other maintenance operation changes the
  // destination between this verdict and the restore it gates.
  if (preflight) {
    const check = await Promise.resolve()
      .then(() => preflight())
      .then((r) => r, (err) => ({ ok: false, error: err?.message || String(err) }));
    if (check?.ok !== true) {
      endMaintenance();
      const error = check?.error || 'Restore pre-check failed';
      logger.warn(`⚠️ 💾 Restore of ${filename} refused before stopping any engine: ${error}`, {
        action: 'restore-backup', filename, code: check?.code, error,
      });
      return { status: 400, body: {
        success: false,
        code: typeof check?.code === 'string' ? check.code : 'restore-precheck-failed',
        error,
        stoppedEngines: [],
      } };
    }
  }

  // Open the engine windows BEFORE asking anything to stop, so nothing can be
  // started back up in the gap between the stop acknowledgement and the copy.
  const windowArgs = { exchangeIPCMap, configuredExchanges, reason: `restore ${filename}`, logger, timeoutMs: stopTimeoutMs };
  await setEngineMaintenanceWindows({ ...windowArgs, active: true });

  const outcome = await applyRestoreUnderLock({
    filename, force, exchangeIPCMap, configuredExchanges, restore, gatewayWriters,
    drainPendingWrites, invalidateCaches, createRecoveryPoint, logger, stopTimeoutMs, drainTimeoutMs,
  }).catch((err) => {
    logger.error(`❌ 💾 Restore aborted by an unexpected error on ${filename}: ${err.message}`, {
      action: 'restore-backup', filename, error: err.message,
    });
    return { status: 500, body: { success: false, code: 'restore-error', error: err.message } };
  });

  await setEngineMaintenanceWindows({ ...windowArgs, active: false });

  // Restart while the gateway lock is still held, so a second restore cannot
  // stop these funds again mid-start. The windows are closed by now — an
  // engine refuses `regime:start` inside one.
  const { restartFunds = [], ...response } = outcome;
  if (restartFunds.length > 0) {
    const restart = await restartStoppedFunds({ funds: restartFunds, exchangeIPCMap, logger, filename, timeoutMs: startTimeoutMs });
    response.body = {
      ...response.body,
      error: noteRestartOutcome(response.body.error, restart),
      restartedEngines: restart.restarted,
      ...(restart.failed.length > 0 ? { restartFailed: restart.failed } : {}),
    };
  }

  // Preserve the gateway gate when accounting files are still mixed. Startup
  // recovery clears the journal before this process may resume any writers.
  if (response.body?.rolledBack !== false) endMaintenance();
  return response;
};

module.exports = {
  performRestore,
  requestEngineStop,
  classifyStopAck,
  DEFAULT_STOP_TIMEOUT_MS,
  DEFAULT_DRAIN_TIMEOUT_MS,
  DEFAULT_START_TIMEOUT_MS,
  ENGINE_MAINTENANCE_TTL_MS,
};
