// @ts-check
/**
 * Crypto Exchange Engine Graceful Shutdown.
 *
 * Ensures clean, ordered termination of an exchange engine process:
 * 1. Single-flight idempotence: duplicate signals share the shutdown promise.
 * 2. Immediate intake closure on IPC server: marks server as shutting down so
 *    new requests/updates are rejected and new connections are refused.
 * 3. Cancels pending fund startup supervision and settles in-flight starts
 *    (bounded: a start hung on exchange REST must not starve the engine stops).
 * 4. Drains in-flight accepted IPC requests (e.g. rebuild-ladder, manual-trade).
 * 5. Stops background jobs (unaccounted fills) and market data services.
 * 6. Drains in-flight market data service starts (bounded like step 3).
 * 7. Stops all active regime engines (draining in-flight fills).
 * 8. Drains process-wide pending writes across all funds (order updates, bookings,
 *    metrics, optimizers, reconciles).
 * 9. Publishes final state and fill ledger (flushForBackup) for cleanly stopped
 *    engines to persist writes that landed during the drain.
 * 10. Flushes chart data buffers.
 * 11. Flushes pending outbound IPC frames to gateway.
 * 12. Closes the IPC server.
 * 13. Enforces an in-process watchdog timeout (exits 1 if teardown exceeds budget).
 */

// Budget (see tests/pm2-kill-timeout.test.js): the bounded steps before the
// engine stops, plus stop()'s shared flash-cancel/fill drain (FILL_DRAIN_MS) and
// the post-stop process drain, must fit inside the watchdog, which in turn stays
// below the PM2 kill_timeout (25s).
const DEFAULT_SHUTDOWN_WATCHDOG_MS = 22000;
const DEFAULT_IPC_DRAIN_TIMEOUT_MS = 3000;
const DEFAULT_PROCESS_DRAIN_TIMEOUT_MS = 3000;
const DEFAULT_START_JOIN_TIMEOUT_MS = 2000;

/**
 * Await `fn()` for at most `timeoutMs`. A timeout or rejection is logged and
 * swallowed: the joined work is already cancelled/unneeded, and the engine
 * stops that follow must still run.
 */
const joinBounded = async (label, fn, timeoutMs, logger) => {
  let timer;
  const expired = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs, false); });
  const joined = await Promise.race([
    Promise.resolve().then(fn).then(() => true, (err) => {
      logger?.error?.(`❌ ${label} failed: ${err.message}`, { error: err.message });
      return true;
    }),
    expired,
  ]);
  clearTimeout(timer);
  if (!joined) {
    logger?.warn?.(`⚠️ ${label} still running after ${timeoutMs}ms — abandoning the join and stopping engines`, { timeout: timeoutMs });
  }
};

/**
 * Create engine shutdown coordinator
 *
 * @param {Object} options
 * @param {Object} [options.ipcServer] - IPC server instance
 * @param {Map<string, Object>} [options.regimeEngines] - Map of active regime engines
 * @param {Function} [options.cancelStarts] - Lifecycle supervisor cancelAll
 * @param {Function} [options.settleStarts] - Lifecycle supervisor settle
 * @param {Object} [options.unaccountedFillsJobs] - Background unaccounted fills job runner
 * @param {Function} [options.stopMarketServices] - Stop all standalone market data services
 * @param {Function} [options.drainMarketStarts] - Drain in-flight market data starts
 * @param {Function} [options.drainPendingWrites] - Drain tracked in-flight writes
 * @param {Function} [options.shutdownAllBuffers] - Flush/retire chart data buffers
 * @param {Object} [options.logger] - Context logger
 * @param {Function} [options.exit] - Exit handler (default: process.exit)
 * @param {number} [options.watchdogMs] - Watchdog timeout ms
 * @param {number} [options.ipcDrainTimeoutMs] - Accepted IPC drain timeout ms
 * @param {number} [options.processDrainTimeoutMs] - Process pending writes drain timeout ms
 * @param {number} [options.startJoinTimeoutMs] - Bound on each start join (fund and market data starts)
 * @returns {{shutdown: (signal: string) => Promise<number>, isStopping: () => boolean}}
 */
const createEngineShutdown = ({
  ipcServer,
  regimeEngines,
  cancelStarts,
  settleStarts = async () => {},
  unaccountedFillsJobs,
  stopMarketServices,
  drainMarketStarts = async () => {},
  drainPendingWrites,
  shutdownAllBuffers,
  logger,
  exit = (code) => process.exit(code),
  watchdogMs = DEFAULT_SHUTDOWN_WATCHDOG_MS,
  ipcDrainTimeoutMs = DEFAULT_IPC_DRAIN_TIMEOUT_MS,
  processDrainTimeoutMs = DEFAULT_PROCESS_DRAIN_TIMEOUT_MS,
  startJoinTimeoutMs = DEFAULT_START_JOIN_TIMEOUT_MS,
}) => {
  let shutdownPromise = null;
  let stopping = false;

  const shutdown = (signal) => {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    const shutdownLogger = logger;
    shutdownLogger?.info?.(`ℹ️ Received ${signal}, shutting down...`, { signal });

    let finished = false;
    let finish;
    shutdownPromise = new Promise((resolve) => { finish = resolve; });

    const complete = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(watchdogTimer);
      finish(code);
      exit(code);
    };

    const watchdogTimer = setTimeout(() => {
      shutdownLogger?.error?.(
        `❌ Forcing exit after shutdown timeout (${watchdogMs / 1000}s)`,
        { timeout: watchdogMs }
      );
      complete(1);
    }, watchdogMs);
    watchdogTimer.unref?.();

    Promise.resolve().then(async () => {
      // 1. Close IPC server intake so new requests/updates are rejected
      if (ipcServer?.setShuttingDown) {
        ipcServer.setShuttingDown(true);
      }

      // 2. Cancel and settle startup supervision. cancelStarts cancels
      // synchronously but then awaits every in-flight start, which a slow
      // exchange can hold for minutes, so it shares the bounded join.
      await joinBounded('Fund start settle', async () => {
        if (cancelStarts) await cancelStarts({ shutdown: true });
        await settleStarts?.();
      }, startJoinTimeoutMs, shutdownLogger);

      // 3. Drain in-flight accepted IPC requests
      if (drainPendingWrites) {
        await drainPendingWrites(ipcDrainTimeoutMs, (entry) => entry.label.startsWith('ipc:'));
      }

      // 4. Stop background jobs
      if (unaccountedFillsJobs?.shutdown) {
        unaccountedFillsJobs.shutdown();
      }

      // 5. Stop market data services and drain in-flight starts
      if (stopMarketServices) {
        stopMarketServices();
      }
      if (drainMarketStarts) {
        await joinBounded('Market data start drain', drainMarketStarts, startJoinTimeoutMs, shutdownLogger);
      }

      // 6. Stop all running regime engines
      const stopPromises = [];
      const engineEntries = regimeEngines ? [...regimeEngines.entries()] : [];
      for (const [key, engine] of engineEntries) {
        shutdownLogger?.info?.(`ℹ️ Stopping regime engine for ${key}...`, { fundKey: key });
        stopPromises.push(Promise.resolve().then(() => engine.stop()));
      }

      const results = await Promise.allSettled(stopPromises);
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === 'rejected') {
          const fundKey = engineEntries[i][0];
          shutdownLogger?.error?.(`❌ Engine stop failed for ${fundKey}: ${results[i].reason.message}`, {
            fundKey,
            error: results[i].reason.message,
          });
        }
      }

      // 7. Drain process-wide pending writes
      if (drainPendingWrites) {
        const drain = await drainPendingWrites(processDrainTimeoutMs);
        if (!drain.drained) {
          shutdownLogger?.warn?.(
            `⚠️ Engine writers did not confirm quiescence within ${processDrainTimeoutMs}ms`,
            { pending: drain.pending }
          );
        }
      }

      // 8. Publish final state & ledger for engines that stopped cleanly,
      // capturing writes that settled during the post-stop drain.
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === 'fulfilled') {
          const [fundKey, engine] = engineEntries[i];
          try {
            engine?.flushForBackup?.();
          } catch (err) {
            shutdownLogger?.error?.(`❌ Post-drain engine flush failed for ${fundKey}: ${err.message}`, {
              fundKey,
              error: err.message,
            });
          }
        }
      }

      // 9. Flush chart data buffers
      if (shutdownAllBuffers) {
        try {
          shutdownAllBuffers();
        } catch (err) {
          shutdownLogger?.error?.(`❌ Buffer shutdown failed: ${err.message}`, { error: err.message });
        }
      }

      // 10. Flush pending outbound IPC frames
      if (ipcServer?.flush) {
        try {
          await ipcServer.flush();
        } catch (err) {
          shutdownLogger?.error?.(`❌ IPC server flush failed: ${err.message}`, { error: err.message });
        }
      }

      // 11. Stop IPC server
      if (ipcServer?.stop) {
        try {
          ipcServer.stop();
        } catch (err) {
          shutdownLogger?.error?.(`❌ IPC server stop failed: ${err.message}`, { error: err.message });
        }
      }

      shutdownLogger?.info?.('ℹ️ Shutdown complete');
      complete(0);
    }).catch((err) => {
      shutdownLogger?.error?.(`❌ Shutdown failed: ${err.message}`, { error: err.message });
      complete(1);
    });

    return shutdownPromise;
  };

  return {
    shutdown,
    isStopping: () => stopping,
  };
};

module.exports = {
  createEngineShutdown,
  DEFAULT_SHUTDOWN_WATCHDOG_MS,
  DEFAULT_IPC_DRAIN_TIMEOUT_MS,
  DEFAULT_PROCESS_DRAIN_TIMEOUT_MS,
  DEFAULT_START_JOIN_TIMEOUT_MS,
};
