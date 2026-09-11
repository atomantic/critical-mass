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

/**
 * Stop every regime engine in the registry, removing only the ones that
 * actually stopped.
 *
 * @param {Map<string, {stop: () => Promise<any>}>} regimeEngines - Registry keyed `exchange::pair`
 * @param {Object} deps
 * @param {(exchange: string, pair: string) => {info: Function, error: Function}} deps.logger - Context logger factory
 * @param {(exchange: string, pair: string) => string} deps.label - Fund label formatter
 * @param {(exchange: string, pair: string, running: boolean) => void} deps.setRunningFlag - Persists the resume flag
 * @returns {Promise<{success: boolean, stopped: Array<{exchange: string, pair: string}>, failed: Array<{exchange: string, pair: string, error: string}>}>} Stop report
 */
const stopAllRegimeEngines = async (regimeEngines, { logger, label, setRunningFlag }) => {
  const stopped = [];
  const failed = [];

  for (const [key, engine] of regimeEngines) {
    const [exchange, pair] = key.split('::');
    const fundLogger = logger(exchange, pair);
    fundLogger.info(`ℹ️ 🛑 [${label(exchange, pair)}] Stopping regime engine (stop-all)...`);

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

    regimeEngines.delete(key);
    setRunningFlag(exchange, pair, false);
    stopped.push({ exchange, pair });
  }

  return { success: failed.length === 0, stopped, failed };
};

module.exports = { stopAllRegimeEngines };
