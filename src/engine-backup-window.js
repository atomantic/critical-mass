// @ts-check
const { getEngineMaintenance, getEngineMaintenanceGeneration, refuseDuringMaintenance, setEngineMaintenance, setEngineBackupPaused, DEFAULT_MAINTENANCE_TTL_MS } = require('./engine-maintenance');
const { IPC_CHANNELS } = require('./ipc/ipc-protocol');

// Grace after the gateway's maintenance window expires before this process
// treats the pause as abandoned, and the retry cadence while writers drain.
const ABANDON_GRACE_MS = 1_000;
const RECOVERY_RETRY_MS = 5_000;

/** Temporarily stop producers, drain accepted work, then flush one generation. */
const registerEngineBackupHandlers = (registry, {
  regimeEngines, getMarketFunds, stopMarketServices, drainMarketStarts,
  drainPendingWrites, startMarketService, resumeFund, getStartStatus = () => null, drainStarts = async () => {},
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
  // Keep the only owner of unflushed state separate from replacement-start
  // failures. Healthy funds and passive buffers can resume independently.
  const failedFlushes = new Map();
  let pendingProducers = null;
  // Funds whose post-backup restart failed; reported until they run again,
  // are stopped by the operator, or the process restarts.
  const unresumed = new Set();
  const recovery = (status) => (status?.state === 'retrying' || status?.state === 'starting'
    ? { recovering: true, nextRetryAt: status.nextRetryAt } : {});
  const pendingRecovery = () => {
    const failures = [];
    for (const key of unresumed) {
      const [exchange, pair] = key.split('::');
      const status = getStartStatus(exchange, pair);
      if (regimeEngines.has(key) || !status || status.state === 'stopped') { unresumed.delete(key); continue; }
      failures.push({ exchange, pair, error: status.error || 'Fund restart is still pending', ...recovery(status) });
    }
    return failures;
  };
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

  const owns = ({ key, engine, cancelled }) => !cancelled && !isShuttingDown() && regimeEngines.get(key) === engine;
  const flushFailures = () => {
    for (const [key, owner] of failedFlushes) if (!owns(owner)) failedFlushes.delete(key);
    return [...failedFlushes.values()].map(({ key, error }) => ({ fund: key, error }));
  };
  const producerFailures = () => pendingProducers
    ? [...pendingProducers.failures, ...(pendingProducers.buffers ? [{ error: 'Backup buffers are still paused', recovering: true }] : [])] : [];
  const retryDelay = (attempts) => Math.min(RECOVERY_RETRY_MS * 2 ** Math.min(attempts, 6), 300_000);
  // Stop coordinators synchronously cancel their owners and join recovery.
  // Excluding them prevents recovery from joining its own joiners.
  const drainRecoveryWrites = () => drainPendingWrites(30_000,
    entry => !['ipc:regime:stop', 'ipc:regime:stop-all'].includes(entry.label));
  const resumeProducers = async (current) => {
    const producers = pendingProducers;
    if (!producers) return;
    const remaining = [];
    const failures = [];
    for (const fund of producers.marketFunds) {
      if (pendingProducers !== producers || producers.cancelled) return;
      if (!producers.marketFunds.includes(fund)) continue;
      const { exchange, pair } = fund;
      if (!current() || isShuttingDown()) {
        remaining.push(fund);
        failures.push({ exchange, pair, error: 'Backup market-data writer is still paused', recovering: true });
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
  const scheduleFlushRecovery = () => {
    clearRecoveryTimer();
    flushFailures();
    if ((!failedFlushes.size && !pendingProducers) || isShuttingDown()) return;
    const generation = timerGeneration;
    const deadlines = [...failedFlushes.values()].map(owner => owner.nextRetryAt);
    if (pendingProducers) deadlines.push(pendingProducers.nextRetryAt);
    const delay = Math.max(0, Math.min(...deadlines) - now());
    recoveryTimer = setTimer(() => {
      if (generation !== timerGeneration) return;
      recoveryTimer = null;
      return retryFailedFlushes(false);
    }, delay);
    recoveryTimer?.unref?.();
  };
  const deferOwner = (owner, error) => {
    owner.error = error;
    owner.nextRetryAt = now() + retryDelay(owner.attempts++);
    failedFlushes.set(owner.key, owner);
  };
  /** Final flush and identity check must precede every replacement. */
  const resumeOwner = async (owner, current) => {
    if (!owns(owner)) return null;
    if (!current()) {
      const error = 'A newer maintenance window fenced backup recovery';
      deferOwner(owner, error);
      return { fund: owner.key, error };
    }
    const { key, engine } = owner;
    let flushError;
    try { await engine.flushForBackup(); }
    catch (err) { flushError = err; }
    // Stop, shutdown, replacement or a new maintenance window may have won
    // while the flush settled. Never delete the winner or admit a stale start.
    if (!owns(owner)) { failedFlushes.delete(key); return null; }
    if (flushError || !current()) {
      const error = flushError?.message || 'A newer maintenance window fenced backup recovery';
      deferOwner(owner, error);
      return { fund: key, error };
    }
    failedFlushes.delete(key);
    const [exchange, pair] = key.split('::');
    regimeEngines.delete(key);
    let result;
    try { result = await resumeFund(exchange, pair); }
    catch (err) { result = { success: false, error: err.message }; }
    if (result?.success) { unresumed.delete(key); return null; }
    unresumed.add(key);
    return { exchange, pair, error: result?.error || 'No restart acknowledgement', ...recovery(getStartStatus(exchange, pair)) };
  };
  const retryFailedFlushes = (explicit = true) => {
    if (resumePromise) return resumePromise;
    clearRecoveryTimer();
    resumePromise = (async () => {
      const generation = getEngineMaintenanceGeneration();
      const current = () => generation === getEngineMaintenanceGeneration() && !refuseDuringMaintenance('regime:start');
      const owners = [...failedFlushes.values()].filter(owner => explicit || owner.nextRetryAt <= now());
      // A newer maintenance owner (or retained restore journal) owns writes.
      // Drain accepted work again: callbacks can arrive after the first resume.
      const drain = current() && !isShuttingDown() ? await drainRecoveryWrites() : null;
      for (const owner of owners) {
        if (!owns(owner)) { failedFlushes.delete(owner.key); continue; }
        if (!drain?.drained || !current()) {
          deferOwner(owner, owner.error);
          continue;
        }
        await resumeOwner(owner, current);
      }
      if (drain?.drained && (explicit || pendingProducers?.nextRetryAt <= now())) await resumeProducers(current);
      else if (pendingProducers && pendingProducers.nextRetryAt <= now()) {
        pendingProducers.nextRetryAt = now() + retryDelay(pendingProducers.attempts++);
      }
      const failures = [...flushFailures(), ...producerFailures(), ...pendingRecovery()];
      return failures.length ? { success: false, failures } : { success: true };
    })().finally(() => { resumePromise = null; scheduleFlushRecovery(); });
    return resumePromise;
  };

  /** Restart every captured owner; shared by the gateway's resume and self-recovery. */
  const resumeWriters = () => {
    if (resumePromise) return resumePromise;
    resumePromise = (async () => {
      const drain = await drainRecoveryWrites();
      if (!drain.drained) return { success: false, error: 'Engine writers are still draining; funds remain stopped' };
      const failures = [];
      const current = () => paused.generation === getEngineMaintenanceGeneration();
      for (const owner of paused.funds) {
        const failure = await resumeOwner(owner, current);
        if (failure) failures.push(failure);
      }
      if (!paused.cancelled) {
        pendingProducers = { marketFunds: paused.marketFunds, buffers: true, failures: [], attempts: 0, nextRetryAt: now() };
        await resumeProducers(current);
        failures.push(...producerFailures());
      }
      paused = null;
      releaseGate();
      if (failures.length) logger.error('Backup completed but some engine writers could not resume', { failures });
      return { success: failures.length === 0, failures };
    })().finally(() => { resumePromise = null; if (!paused) scheduleFlushRecovery(); });
    return resumePromise;
  };

  /**
   * The gateway that paused this process is gone or its window lapsed: nothing
   * will ever send `engine:backup-resume`, and without it every captured fund
   * stays stopped (and `regime:start` refused) until the process restarts.
   * Resume the writers here; a gateway that is merely late sees an idempotent
   * resume. Writers still draining are retried rather than abandoned.
   */
  const recoverAbandonedPause = async (why) => {
    if (isShuttingDown()) return;
    const ownerGeneration = pauseGeneration;
    await pausePromise;
    if (!pausePromise || resumePromise || isShuttingDown()) return;
    logger.warn(`Backup pause has no gateway owner (${why}); resuming engine writers`, { reason: why });
    // The owner's transport window closes with it; a newer gateway's window stays.
    if (getEngineMaintenanceGeneration() === ownerGeneration) setEngineMaintenance({ active: false });
    if (!paused) { releaseGate(); scheduleFlushRecovery(); return; }
    const result = await resumeWriters();
    if (paused) scheduleRecovery(why, RECOVERY_RETRY_MS);
    else if (!result.success) logger.error('Self-resume after an abandoned backup pause left funds stopped', { reason: why, failures: result.failures });
  };

  onGatewayDisconnect(() => {
    if (pausePromise) void recoverAbandonedPause('gateway disconnected');
  });

  registry.onRequest(IPC_CHANNELS.ENGINE_BACKUP_PAUSE, async () => {
    // A self-recovery still restarting the previous generation's owners must
    // finish before a new gateway captures the registry as quiesced.
    await resumePromise;
    if (!getEngineMaintenance()) return { success: false, error: 'Maintenance window is required' };
    if (pausePromise) return pausePromise;
    // The new capture assumes ownership of retained objects; fence all old
    // callbacks before it drains and stops this generation.
    clearRecoveryTimer();
    pauseGeneration = getEngineMaintenanceGeneration();
    setEngineBackupPaused(true);
    // The gateway bounds its own copy by this window; past it, nobody owns the pause.
    const expiresAt = getEngineMaintenance()?.expiresAt ?? now() + DEFAULT_MAINTENANCE_TTL_MS;
    scheduleRecovery('maintenance window expired', Math.max(0, expiresAt - now()) + ABANDON_GRACE_MS);
    pausePromise = (async () => {
      const accepted = await drainPendingWrites(30_000, (entry) => entry.label.startsWith('ipc:'));
      if (!accepted.drained) return { success: false, error: 'Accepted engine requests are still running' };
      // Automatic retries are not IPC requests: let an in-flight one settle so
      // its engine (if any) is captured and stopped like every other owner.
      if (!await settleStarts(30_000)) return { success: false, error: 'Fund startups are still running' };
      const marketFunds = [...new Map([...(pendingProducers?.marketFunds || []), ...getMarketFunds()]
        .map(fund => [`${fund.exchange}::${fund.pair}`, fund])).values()];
      failedFlushes.clear();
      if (pendingProducers) pendingProducers.cancelled = true;
      pendingProducers = null;
      paused = { generation: pauseGeneration, funds: [...regimeEngines].map(([key, engine]) => ({ key, engine, attempts: 0 })), marketFunds };
      stopMarketServices();
      const stopped = await Promise.allSettled(paused.funds.map(({ engine }) => engine.stop({ keepHeartbeat: true })));
      await drainMarketStarts();
      const drain = await drainPendingWrites();
      if (!drain.drained || stopped.some((entry) => entry.status === 'rejected')) {
        return { success: false, error: 'Engine writers did not confirm quiescence', pending: drain.pending };
      }
      // Stops may have saved before an accepted callback finished. Publish its
      // final state only AFTER the process-wide drain, retaining resume flags.
      for (const { engine } of paused.funds) engine.flushForBackup();
      pauseBuffers();
      return { success: true, quiesced: true };
    })().catch((err) => ({ success: false, error: err.message }));
    return pausePromise;
  });
  registry.onRequest(IPC_CHANNELS.ENGINE_BACKUP_RESUME, async () => {
    await pausePromise;
    if (!paused) {
      await resumePromise;
      releaseGate();
      if (failedFlushes.size || pendingProducers) return retryFailedFlushes();
      // A repeat resume must not report a fund still awaiting recovery as restored.
      const failures = pendingRecovery();
      return failures.length ? { success: false, failures } : { success: true };
    }
    return resumeWriters();
  });
  // Cancellation happens before awaiting the shared attempt. Lifecycle callers
  // then join it before flushing/stopping or handing ownership to a consumer.
  const cancelFund = (key) => {
    if (key === undefined && paused) paused.cancelled = true;
    for (const owner of [...failedFlushes.values(), ...(paused?.funds || [])]) {
      if (key === undefined || owner.key === key) { owner.cancelled = true; failedFlushes.delete(owner.key); }
    }
    if (pendingProducers && key === undefined) { pendingProducers.cancelled = true; pendingProducers = null; }
    else if (pendingProducers) {
      pendingProducers.marketFunds = pendingProducers.marketFunds.filter(({ exchange, pair }) => `${exchange}::${pair}` !== key);
      pendingProducers.failures = pendingProducers.failures.filter(({ exchange, pair }) => `${exchange}::${pair}` !== key);
    }
    if (key === undefined) unresumed.clear();
    else unresumed.delete(key);
    if (!paused) scheduleFlushRecovery();
    return resumePromise;
  };
  return { cancelFund, cancelAll: () => cancelFund() };
};
module.exports = { registerEngineBackupHandlers, ABANDON_GRACE_MS, RECOVERY_RETRY_MS };
