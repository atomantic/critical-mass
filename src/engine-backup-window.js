// @ts-check
const { getEngineMaintenance, getEngineMaintenanceGeneration, setEngineMaintenance, setEngineBackupPaused, DEFAULT_MAINTENANCE_TTL_MS } = require('./engine-maintenance');
const { IPC_CHANNELS } = require('./ipc/ipc-protocol');

// Grace after the gateway's maintenance window expires before this process
// treats the pause as abandoned.
const ABANDON_GRACE_MS = 1_000;

/**
 * Quiesce live funds in place for a backup: drain accepted work, hold each
 * engine's fill gate and ladder lock, and publish one generation of its files.
 * Engines and market-data feeds keep running; fills that arrive during the
 * hold queue at the gate and run once the backup resumes.
 */
const registerEngineBackupHandlers = (registry, {
  regimeEngines, drainPendingWrites, drainStarts = async () => {},
  pauseBuffers = () => {}, resumeBuffers = () => {}, logger,
  onGatewayDisconnect = () => {}, isShuttingDown = () => false,
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now,
}) => {
  let pausePromise = null;
  let pauseGeneration = null;
  let abandonTimer = null;
  let held = [];
  let buffersPaused = false;

  const settleStarts = async (timeoutMs) => {
    let timer;
    const expired = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs, false); });
    try { return await Promise.race([Promise.resolve(drainStarts()).then(() => true), expired]); } finally { clearTimeout(timer); }
  };
  const releaseHolds = (key) => {
    const keep = [];
    for (const entry of held) {
      if (key === undefined || entry.key === key) entry.engine.releaseBackupHold?.();
      else keep.push(entry);
    }
    held = keep;
  };
  /** Reopen every gate, restart the passive buffers, and end the pause. */
  const releasePause = () => {
    if (abandonTimer) clearTimer(abandonTimer);
    abandonTimer = null;
    releaseHolds();
    if (buffersPaused) { buffersPaused = false; resumeBuffers(); }
    pausePromise = null;
    setEngineBackupPaused(false);
  };

  /**
   * The gateway that paused this process is gone or its window lapsed: nothing
   * will send `engine:backup-resume`, so reopen the gates here. A gateway that
   * is merely late sees an idempotent resume.
   */
  const recoverAbandonedPause = async (why) => {
    if (isShuttingDown()) return;
    const ownerGeneration = pauseGeneration;
    await pausePromise;
    if (!pausePromise) return;
    logger.warn(`Backup pause has no gateway owner (${why}); reopening engine fill gates`, { reason: why });
    // The owner's transport window closes with it; a newer gateway's window stays.
    if (getEngineMaintenanceGeneration() === ownerGeneration) setEngineMaintenance({ active: false });
    releasePause();
  };

  onGatewayDisconnect(() => {
    if (pausePromise) void recoverAbandonedPause('gateway disconnected');
  });

  registry.onRequest(IPC_CHANNELS.ENGINE_BACKUP_PAUSE, async () => {
    if (!getEngineMaintenance()) return { success: false, error: 'Maintenance window is required' };
    if (pausePromise) return pausePromise;
    pauseGeneration = getEngineMaintenanceGeneration();
    setEngineBackupPaused(true);
    // The gateway bounds its own copy by this window; past it, nobody owns the pause.
    const expiresAt = getEngineMaintenance()?.expiresAt ?? now() + DEFAULT_MAINTENANCE_TTL_MS;
    abandonTimer = setTimer(() => { abandonTimer = null; void recoverAbandonedPause('maintenance window expired'); },
      Math.max(0, expiresAt - now()) + ABANDON_GRACE_MS);
    abandonTimer?.unref?.();
    const attempt = (async () => {
      const accepted = await drainPendingWrites(30_000, (entry) => entry.label.startsWith('ipc:'));
      if (!accepted.drained) return { success: false, error: 'Accepted engine requests are still running' };
      // Automatic retries are not IPC requests: let an in-flight one settle so
      // its engine (if any) is held like every other owner.
      if (!await settleStarts(30_000)) return { success: false, error: 'Fund startups are still running' };
      held = [...regimeEngines].map(([key, engine]) => ({ key, engine }));
      const results = await Promise.allSettled(held.map(({ engine }) => engine.holdForBackup()));
      const failed = results.flatMap((entry, i) => {
        if (entry.status === 'fulfilled' && entry.value?.quiesced) return [];
        return [{ fund: held[i].key, error: entry.status === 'rejected' ? entry.reason?.message : entry.value?.error }];
      });
      if (failed.length) return { success: false, error: 'Engine writers did not confirm quiescence', failures: failed };
      // Queued fill callbacks wait at the gate by design, so they are excluded
      // from the drain. Anything else still writing finishes first, then each
      // held engine republishes the final generation.
      const drain = await drainPendingWrites(30_000, (entry) => !entry.label.startsWith('engine-order:'));
      if (!drain.drained) return { success: false, error: 'Engine writers did not confirm quiescence', pending: drain.pending };
      for (const { engine } of held) engine.flushForBackup();
      pauseBuffers();
      buffersPaused = true;
      return { success: true, quiesced: true };
    })().catch((err) => ({ success: false, error: err.message }));
    pausePromise = attempt;
    // A failed capture must not leave gates closed until the window lapses:
    // the gateway still sends resume, but never relies on it for a refusal.
    void attempt.then((result) => { if (!result.success && pausePromise === attempt) releaseHolds(); });
    return attempt;
  });
  registry.onRequest(IPC_CHANNELS.ENGINE_BACKUP_RESUME, async () => {
    await pausePromise;
    releasePause();
    return { success: true };
  });
  // An operator stop/restore tears the engine down itself; drop its hold first
  // so queued fills are refused (recovered on next start) rather than waiting.
  const cancelFund = (key) => { releaseHolds(key); };
  return { cancelFund, cancelAll: () => releaseHolds() };
};
module.exports = { registerEngineBackupHandlers, ABANDON_GRACE_MS };
