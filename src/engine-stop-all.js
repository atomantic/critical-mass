// @ts-check
/**
 * Engine "stop all" helper.
 *
 * Backup restore uses this (via IPC `regime:stop-all`) as its proof that an
 * engine process has no live writers left. That makes honesty the whole point:
 * a fund whose `stop()` rejected is NOT stopped, must NOT be dropped from the
 * registry, and must NOT have its running flag cleared — otherwise the process
 * forgets it owns a live engine and the caller is told everything is quiet
 * while a writer is still ticking (issue #429).
 */

// A timed-out drain or failed flush must remember that a now-stopped owner
// still owes its final snapshot when the operator retries.
const pendingFinalFlush = new WeakSet();

/**
 * Stop every regime engine in the registry, removing only the ones that
 * actually stopped.
 *
 * @param {Map<string, {stop: () => Promise<any>, getStatus?: Function, flushForBackup?: Function}>} regimeEngines - Registry keyed `exchange::pair`
 * @param {Object} deps
 * @param {(exchange: string, pair: string) => {info: Function, error: Function}} deps.logger - Context logger factory
 * @param {(exchange: string, pair: string) => string} deps.label - Fund label formatter
 * @param {(exchange: string, pair: string, running: boolean) => void} deps.setRunningFlag - Persists the resume flag
 * @param {() => Promise<{drained: boolean, pending?: Array<Object>}>} [deps.drainWrites] - Process writer join after producers stop
 * @returns {Promise<{error?: string, pending?: Array<Object>, success: boolean, stopped: Array<{exchange: string, pair: string}>, failed: Array<{exchange: string, pair: string, error: string}>}>} Stop report
 */
const stopAllRegimeEngines = async (regimeEngines, { logger, label, setRunningFlag, drainWrites = async () => ({ drained: true }) }) => {
  const stopped = [];
  const failed = [];
  const settled = [];

  for (const [key, engine] of regimeEngines) {
    const [exchange, pair] = key.split('::');
    const fundLogger = logger(exchange, pair);
    fundLogger.info(`ℹ️ 🛑 [${label(exchange, pair)}] Stopping regime engine (stop-all)...`);

    if (engine.getStatus?.().isRunning === true) pendingFinalFlush.add(engine);
    const error = await Promise.resolve()
      .then(() => engine.stop())
      .then(() => null, (err) => err);

    if (error) {
      // Keep ownership: the engine may still hold timers/websockets, and the
      // registry is the only handle left for a retry or an operator report.
      fundLogger.error(`❌ [${label(exchange, pair)}] Error stopping engine, retaining ownership: ${error.message}`, { error: error.message });
      failed.push({ exchange, pair, error: error.message });
      continue;
    }

    settled.push({ key, engine, exchange, pair });
  }

  // stop() fences producers but only joins its fill gate. Other accepted
  // callbacks (including standalone ledger writers) belong to the process
  // drain. Keep every owner and resume flag until that drain confirms idle.
  const drain = await drainWrites();
  if (!drain.drained) {
    return { success: false, stopped: [], failed, error: 'Engine writers are still draining', pending: drain.pending };
  }

  for (const { key, engine, exchange, pair } of settled) {
    try {
      // A callback may have finished AFTER stop() saved. Publish that final
      // generation, but never flush a partially started, unrecovered engine.
      if (pendingFinalFlush.has(engine)) engine.flushForBackup();
      pendingFinalFlush.delete(engine);
    } catch (err) {
      failed.push({ exchange, pair, error: err.message });
      continue;
    }
    regimeEngines.delete(key);
    setRunningFlag(exchange, pair, false);
    stopped.push({ exchange, pair });
  }

  return { success: failed.length === 0, stopped, failed };
};

/** Restore's process-wide join. The caller must hold the maintenance window. */
const createEngineStopAllHandler = ({
  regimeEngines, cancelStarts, drainPendingWrites, stopMarketServices,
  drainMarketStarts, clearCaches, getMaintenance, setQuiescing, logger, label, setRunningFlag,
}) => {
  let pending;
  return () => {
    if (pending) return pending;
    if (!getMaintenance()?.reason.startsWith('restore ')) {
      return Promise.resolve({ success: false, stopped: [], failed: [], error: 'Restore maintenance window is required' });
    }
    setQuiescing(true);
    pending = Promise.resolve().then(async () => {
      await cancelStarts({ clearDesired: true });
      // Join lifecycle commands before stopping owners: an accepted stop may
      // still be handing its fund to a newly starting standalone consumer.
      // Exclude this coordinator (and duplicate calls) to avoid joining itself.
      const accepted = await drainPendingWrites(30_000,
        entry => entry.label.startsWith('ipc:') && entry.label !== 'ipc:regime:stop-all');
      if (!accepted.drained) return { success: false, stopped: [], failed: [], error: 'Accepted engine requests are still running', pending: accepted.pending };
      stopMarketServices();
      await drainMarketStarts();
      const result = await stopAllRegimeEngines(regimeEngines, {
        logger, label, setRunningFlag,
        drainWrites: () => drainPendingWrites(30_000, entry => entry.label !== 'ipc:regime:stop-all'),
      });
      // A stale stopped-fund ledger or manual-trade store must never persist
      // over the restored generation on the first request after the window.
      if (result.success) clearCaches();
      return result;
    }).finally(() => { pending = null; setQuiescing(false); });
    return pending;
  };
};

module.exports = { stopAllRegimeEngines, createEngineStopAllHandler };
