// @ts-check
const { getEngineMaintenance, setEngineBackupPaused } = require('./engine-maintenance');

/** Temporarily stop producers, drain accepted work, then flush one generation. */
const registerEngineBackupHandlers = (registry, {
  regimeEngines, getMarketFunds, stopMarketServices, drainMarketStarts,
  drainPendingWrites, startMarketService, startFund, pauseBuffers = () => {}, resumeBuffers = () => {}, logger,
}) => {
  let paused = null;
  let pausePromise = null;
  registry.onRequest('engine:backup-pause', () => {
    if (!getEngineMaintenance()) return { success: false, error: 'Maintenance window is required' };
    if (pausePromise) return pausePromise;
    setEngineBackupPaused(true);
    pausePromise = (async () => {
      const accepted = await drainPendingWrites(30_000, (entry) => entry.label.startsWith('ipc:'));
      if (!accepted.drained) return { success: false, error: 'Accepted engine requests are still running' };
      paused = { funds: [...regimeEngines].map(([key, engine]) => ({ key, engine })), marketFunds: getMarketFunds() };
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
  registry.onRequest('engine:backup-resume', async () => {
    await pausePromise;
    if (!paused) { pausePromise = null; setEngineBackupPaused(false); return { success: true }; }
    const drain = await drainPendingWrites();
    if (!drain.drained) return { success: false, error: 'Engine writers are still draining; funds remain stopped' };
    const failures = [];
    for (const { key, engine } of paused.funds) {
      const flushError = await Promise.resolve().then(() => engine.flushForBackup()).then(() => null, (err) => err);
      if (flushError) { failures.push({ fund: key, error: flushError.message }); continue; }
      const [exchange, pair] = key.split('::');
      // Lifecycle start must replace the stopped object and reload its final files.
      regimeEngines.delete(key);
      const result = await Promise.resolve().then(() => startFund({}, exchange, pair)).catch((err) => ({ success: false, error: err.message }));
      if (!result?.success) failures.push({ exchange, pair, error: result?.error || 'No restart acknowledgement' });
    }
    for (const { exchange, pair } of paused.marketFunds) {
      if (regimeEngines.has(`${exchange}::${pair}`)) continue;
      const result = await Promise.resolve().then(() => startMarketService(exchange, pair)).catch((err) => ({ success: false, error: err.message }));
      if (!result?.success) failures.push({ exchange, pair, error: result?.error || 'No restart acknowledgement' });
    }
    resumeBuffers();
    paused = pausePromise = null;
    setEngineBackupPaused(false);
    if (failures.length) logger.error('Backup completed but some engine writers could not resume', { failures });
    return { success: failures.length === 0, failures };
  });
};
module.exports = { registerEngineBackupHandlers };
