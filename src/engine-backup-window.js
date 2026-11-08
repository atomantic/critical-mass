// @ts-check
const { getEngineMaintenance, getEngineMaintenanceGeneration, refuseDuringMaintenance, setEngineMaintenance, setEngineBackupPaused, DEFAULT_MAINTENANCE_TTL_MS } = require('./engine-maintenance');
const { isParkedWrite } = require('./pending-writes');
const { IPC_CHANNELS } = require('./ipc/ipc-protocol');

// Grace after the gateway's maintenance window expires before this process
// treats the pause as abandoned, and the retry cadence while writers drain.
const ABANDON_GRACE_MS = 1_000;
const RECOVERY_RETRY_MS = 5_000;

/**
 * Quiesce this process's writers for a backup and publish one generation of
 * every fund's files (issue #1945).
 *
 * Live funds quiesce IN PLACE: each engine closes its backup fence, lets the
 * writers already past it finish (bounded) and flushes. Its websockets, market
 * data and resting orders stay live; fills and other writers that arrive meanwhile
 * park at the fence and run once, in order, after the backup resumes. Parked
 * writers are excluded from the process-wide drain, so they cannot stall it.
 * Standalone market-data services of stopped funds keep the stop/restart path.
 * They are cheap to restart and own the ledger of a fund with no engine.
 */
const registerEngineBackupHandlers = (registry, {
  regimeEngines, getMarketFunds, stopMarketServices, drainMarketStarts,
  drainPendingWrites, startMarketService, drainStarts = async () => {},
  pauseBuffers = () => {}, resumeBuffers = () => {}, logger,
  onGatewayDisconnect = () => {}, isShuttingDown = () => false,
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now,
}) => {
  let paused = null;
  let pausePromise = null;
  let pauseGeneration = null;
  let resumePromise = null;
  let recoveryTimer = null;
  let timerGeneration = 0;
  // Standalone market-data services and chart buffers still to restart after
  // a backup; retried with backoff until they run or an operator takes over.
  let pendingProducers = null;
  const settleStarts = async (timeoutMs) => {
    let timer;
    const expired = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs, false); });
    try { return await Promise.race([Promise.resolve(drainStarts()).then(() => true), expired]); } finally { clearTimeout(timer); }
  };
  const clearRecoveryTimer = () => {
    timerGeneration++;
    if (recoveryTimer) clearTimer(recoveryTimer);
    recoveryTimer = null;
  };
  const scheduleRecovery = (why, delayMs) => {
    clearRecoveryTimer();
    const generation = timerGeneration;
    recoveryTimer = setTimer(() => {
      if (generation !== timerGeneration) return;
      recoveryTimer = null;
      void recoverAbandonedPause(why);
    }, delayMs);
    recoveryTimer?.unref?.();
  };
  /** A pause that captured nothing (or finished resuming) only holds the gate. */
  const releaseGate = () => {
    clearRecoveryTimer();
    pausePromise = null;
    setEngineBackupPaused(false);
  };
  /** Reopen the backup fence of every held engine, or of one fund. */
  const releaseHolds = (key) => {
    if (!paused) return;
    const keep = [];
    for (const owner of paused.funds) {
      if (key === undefined || owner.key === key) owner.engine.releaseBackupHold();
      else keep.push(owner);
    }
    paused.funds = keep;
  };

  const producerFailures = () => pendingProducers
    ? [...pendingProducers.failures, ...(pendingProducers.buffers ? [{ error: 'Backup buffers are still paused', recovering: true }] : [])] : [];
  const retryDelay = (attempts) => Math.min(RECOVERY_RETRY_MS * 2 ** Math.min(attempts, 6), 300_000);
  // A service the pause retired may still finish order work it accepted; its
  // replacement must not overlap that ledger writer (issue #1008).
  const drainMarketWrites = () => drainPendingWrites(30_000, entry => entry.label.startsWith('market-'));
  const resumeProducers = async (current) => {
    const producers = pendingProducers;
    if (!producers) return;
    const remaining = [];
    const failures = [];
    const ready = current() && !isShuttingDown();
    const drained = ready && producers.marketFunds.length ? (await drainMarketWrites()).drained : ready;
    if (pendingProducers !== producers || producers.cancelled) return;
    for (const fund of producers.marketFunds) {
      if (pendingProducers !== producers || producers.cancelled) return;
      if (!producers.marketFunds.includes(fund)) continue;
      const { exchange, pair } = fund;
      const blocked = !current() || isShuttingDown();
      if (blocked || !drained) {
        remaining.push(fund);
        failures.push({ exchange, pair, error: blocked ? 'Backup market-data writer is still paused' : 'Backup market-data writers are still draining', recovering: true });
        continue;
      }
      if (regimeEngines.has(`${exchange}::${pair}`)) continue;
      let result;
      try { result = await startMarketService(exchange, pair); }
      catch (err) { result = { success: false, error: err.message }; }
      if (!result?.success && producers.marketFunds.includes(fund)) {
        remaining.push(fund);
        failures.push({ exchange, pair, error: result?.error || 'No restart acknowledgement' });
      }
    }
    if (pendingProducers !== producers || producers.cancelled) return;
    producers.marketFunds = remaining.filter(fund => producers.marketFunds.includes(fund));
    producers.failures = failures.filter(failure => producers.marketFunds.some(fund => fund.exchange === failure.exchange && fund.pair === failure.pair));
    if (current() && !isShuttingDown() && producers.buffers) { resumeBuffers(); producers.buffers = false; }
    if (!producers.marketFunds.length && !producers.buffers) pendingProducers = null;
    else producers.nextRetryAt = now() + retryDelay(producers.attempts++);
  };
  const scheduleProducerRecovery = () => {
    clearRecoveryTimer();
    if (!pendingProducers || isShuttingDown()) return;
    const generation = timerGeneration;
    const delay = Math.max(0, pendingProducers.nextRetryAt - now());
    recoveryTimer = setTimer(() => {
      if (generation !== timerGeneration) return;
      recoveryTimer = null;
      return retryProducers(false);
    }, delay);
    recoveryTimer?.unref?.();
  };
  const retryProducers = (explicit = true) => {
    if (resumePromise) return resumePromise;
    clearRecoveryTimer();
    resumePromise = (async () => {
      const generation = getEngineMaintenanceGeneration();
      // A newer maintenance owner (or retained restore journal) owns writes.
      const current = () => generation === getEngineMaintenanceGeneration() && !refuseDuringMaintenance('regime:start');
      if (pendingProducers && (explicit || pendingProducers.nextRetryAt <= now())) await resumeProducers(current);
      const failures = producerFailures();
      return failures.length ? { success: false, failures } : { success: true };
    })().finally(() => { resumePromise = null; scheduleProducerRecovery(); });
    return resumePromise;
  };

  /** Reopen every held fence and restart the paused producers; shared by the gateway's resume and self-recovery. */
  const resumeWriters = () => {
    if (resumePromise) return resumePromise;
    resumePromise = (async () => {
      // Fences first: parked fills must not wait on a market-data restart.
      releaseHolds();
      const current = () => paused.generation === getEngineMaintenanceGeneration();
      if (!paused.cancelled) {
        pendingProducers = { marketFunds: paused.marketFunds, buffers: true, failures: [], attempts: 0, nextRetryAt: now() };
        await resumeProducers(current);
      }
      const failures = producerFailures();
      paused = null;
      releaseGate();
      if (failures.length) logger.error('Backup completed but some engine writers could not resume', { failures });
      return { success: failures.length === 0, failures };
    })().finally(() => { resumePromise = null; if (!paused) scheduleProducerRecovery(); });
    return resumePromise;
  };

  /**
   * The gateway that paused this process is gone or its window lapsed: nothing
   * will ever send `engine:backup-resume`, and without it every held fund keeps
   * its fills parked (and `regime:start` refused) until the process restarts.
   * Resume the writers here; a gateway that is merely late sees an idempotent
   * resume.
   */
  const recoverAbandonedPause = async (why) => {
    if (isShuttingDown()) return;
    const ownerGeneration = pauseGeneration;
    await pausePromise;
    if (!pausePromise || resumePromise || isShuttingDown()) return;
    logger.warn(`Backup pause has no gateway owner (${why}); resuming engine writers`, { reason: why });
    // The owner's transport window closes with it; a newer gateway's window stays.
    if (getEngineMaintenanceGeneration() === ownerGeneration) setEngineMaintenance({ active: false });
    if (!paused) { releaseGate(); scheduleProducerRecovery(); return; }
    const result = await resumeWriters();
    if (!result.success) logger.error('Self-resume after an abandoned backup pause left writers paused', { reason: why, failures: result.failures });
  };

  onGatewayDisconnect(() => {
    if (pausePromise) void recoverAbandonedPause('gateway disconnected');
  });

  registry.onRequest(IPC_CHANNELS.ENGINE_BACKUP_PAUSE, async () => {
    // A self-recovery still restarting the previous generation's producers
    // must finish before a new gateway captures the registry as quiesced.
    await resumePromise;
    if (!getEngineMaintenance()) return { success: false, error: 'Maintenance window is required' };
    if (pausePromise) return pausePromise;
    // The new capture assumes ownership of retained objects; fence all old
    // callbacks before it drains and holds this generation.
    clearRecoveryTimer();
    pauseGeneration = getEngineMaintenanceGeneration();
    setEngineBackupPaused(true);
    // The gateway bounds its own copy by this window; past it, nobody owns the pause.
    const expiresAt = getEngineMaintenance()?.expiresAt ?? now() + DEFAULT_MAINTENANCE_TTL_MS;
    scheduleRecovery('maintenance window expired', Math.max(0, expiresAt - now()) + ABANDON_GRACE_MS);
    const attempt = (async () => {
      const accepted = await drainPendingWrites(30_000, (entry) => entry.label.startsWith('ipc:'));
      if (!accepted.drained) return { success: false, error: 'Accepted engine requests are still running' };
      // Automatic retries are not IPC requests: let an in-flight one settle so
      // its engine (if any) is held like every other owner.
      if (!await settleStarts(30_000)) return { success: false, error: 'Fund startups are still running' };
      const marketFunds = [...new Map([...(pendingProducers?.marketFunds || []), ...getMarketFunds()]
        .map(fund => [`${fund.exchange}::${fund.pair}`, fund])).values()];
      if (pendingProducers) pendingProducers.cancelled = true;
      pendingProducers = null;
      paused = { generation: pauseGeneration, funds: [...regimeEngines].map(([key, engine]) => ({ key, engine })), marketFunds };
      stopMarketServices();
      const results = await Promise.allSettled(paused.funds.map(({ engine }) => engine.holdForBackup()));
      await drainMarketStarts();
      const failed = results.flatMap((entry, i) => {
        if (entry.status === 'fulfilled' && entry.value?.quiesced === true) return [];
        return [{ fund: paused.funds[i].key, error: entry.status === 'rejected' ? entry.reason?.message : entry.value?.error }];
      });
      if (failed.length) return { success: false, error: 'Engine writers did not confirm quiescence', failures: failed };
      // Writers parked at a fence wait for resume by design; everything else
      // still running (a fire-and-forget chain, a retired service's order
      // work) must finish before the final generation is published.
      const drain = await drainPendingWrites(30_000, (entry) => !isParkedWrite(entry));
      if (!drain.drained) return { success: false, error: 'Engine writers did not confirm quiescence', pending: drain.pending };
      const lost = paused.funds.filter(({ key, engine }) => regimeEngines.get(key) !== engine || !engine.isBackupHeld());
      if (lost.length) return { success: false, error: 'A fund stopped during the backup hold', failures: lost.map(({ key }) => ({ fund: key })) };
      for (const { engine } of paused.funds) engine.flushForBackup();
      pauseBuffers();
      return { success: true, quiesced: true };
    })().catch((err) => ({ success: false, error: err.message }));
    pausePromise = attempt;
    // A refused capture must not keep fills parked until resume: reopen the
    // fences now. Producers still restart on the gateway's resume.
    void attempt.then((result) => { if (!result.success && pausePromise === attempt) releaseHolds(); });
    return attempt;
  });
  registry.onRequest(IPC_CHANNELS.ENGINE_BACKUP_RESUME, async () => {
    await pausePromise;
    if (!paused) {
      await resumePromise;
      releaseGate();
      if (pendingProducers) return retryProducers();
      return { success: true };
    }
    return resumeWriters();
  });
  // An operator stop or restore tears the engine down itself. Reopen its
  // fence first so its parked writers meet the stopping engine instead of
  // waiting. Lifecycle callers then join the returned recovery before
  // flushing/stopping or handing ownership to a consumer.
  const cancelFund = (key) => {
    releaseHolds(key);
    if (key === undefined && paused) paused.cancelled = true;
    if (pendingProducers && key === undefined) { pendingProducers.cancelled = true; pendingProducers = null; }
    else if (pendingProducers) {
      pendingProducers.marketFunds = pendingProducers.marketFunds.filter(({ exchange, pair }) => `${exchange}::${pair}` !== key);
      pendingProducers.failures = pendingProducers.failures.filter(({ exchange, pair }) => `${exchange}::${pair}` !== key);
    }
    if (!paused) scheduleProducerRecovery();
    return resumePromise;
  };
  return { cancelFund, cancelAll: () => cancelFund() };
};
module.exports = { registerEngineBackupHandlers, ABANDON_GRACE_MS, RECOVERY_RETRY_MS };
