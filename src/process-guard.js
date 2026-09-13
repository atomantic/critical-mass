// @ts-check
/**
 * Last-resort process guards (issue #532).
 *
 * Node's default for an `uncaughtException` / `unhandledRejection` is to print
 * a stack to stderr and exit — which, for a live trading process, means PM2
 * restarts it while resting buy and take-profit orders sit on the exchange
 * with nothing watching them, and the operator finds out only by looking.
 *
 * These handlers do NOT swallow the fault. The process still dies with a
 * non-zero code (PM2 keeps its restart semantics); they exist so the failure is
 * logged with the process's own context logger and pushed out as a critical
 * Telegram event before the exit, plus a bounded drain window so an in-flight
 * notifier flush can actually leave the box.
 */

const { tradeEvents } = require('./trade-events');

/** How long a notifier flush may hold up the exit before we bail out anyway. */
const DEFAULT_DRAIN_MS = 2000;

/**
 * Build the fault reporter used by the process guards. Split out from
 * registration so tests can drive it directly — `process.emit(...)` would also
 * fire the test runner's own listener and fail the run.
 *
 * @param {Object} options
 * @param {{error: Function}} options.logger - Context logger for this process
 * @param {string} options.source - Process label used in the log line and event
 * @param {Function} [options.flush] - Notifier flush hook; may return a promise
 * @param {number} [options.drainMs] - Max wait for the flush before exiting
 * @param {Function} [options.exit] - Exit hook (injected in tests)
 * @param {Object} [options.emitter] - Trade-event emitter (injected in tests)
 * @returns {{onUncaughtException: Function, onUnhandledRejection: Function}}
 */
const createFaultReporter = ({
  logger,
  source,
  flush = null,
  drainMs = DEFAULT_DRAIN_MS,
  exit = (code) => process.exit(code),
  emitter = tradeEvents,
}) => {
  let exited = false;

  /**
   * Exit once, no matter which of the flush path or the drain watchdog wins.
   * @param {string} via - Which path triggered the exit
   * @param {number} startedAt - Fault timestamp, for the timing log line
   */
  const exitOnce = (via, startedAt) => {
    if (exited) return;
    exited = true;
    logger.error(`💥 [${source}] Exiting (1) via ${via} after ${Date.now() - startedAt}ms of fault handling`, {
      action: 'process-guard-exit', source, via, durationMs: Date.now() - startedAt,
    });
    exit(1);
  };

  /**
   * Log + notify a fatal fault, then exit non-zero.
   * @param {string} kind - 'uncaughtException' | 'unhandledRejection'
   * @param {any} err - Thrown value / rejection reason (not always an Error)
   */
  const report = (kind, err) => {
    const startedAt = Date.now();
    const message = err?.message ?? String(err);

    logger.error(`💥 [${source}] Fatal ${kind}: ${message} — notifying operator, then exiting non-zero`, {
      action: 'process-guard', source, kind, error: message, stack: err?.stack ?? null,
    });
    emitter.emitTradeEvent('sentinel_critical', source, `Fatal ${kind}: ${message}`, {
      action: 'process-guard', source, kind, error: message,
    });

    Promise.resolve()
      .then(() => flush?.())
      .catch((flushErr) => {
        logger.error(`❌ [${source}] Notifier flush failed during ${kind}: ${flushErr?.message ?? flushErr}`, {
          action: 'process-guard-flush', source, kind, error: flushErr?.message ?? String(flushErr),
        });
      })
      .then(() => exitOnce('flush', startedAt));

    // Watchdog: a hung flush (unreachable Telegram, wedged socket) must not
    // leave a broken process alive indefinitely.
    setTimeout(() => exitOnce('drain-timeout', startedAt), drainMs).unref();
  };

  return {
    onUncaughtException: (err) => report('uncaughtException', err),
    onUnhandledRejection: (reason) => report('unhandledRejection', reason),
  };
};

/**
 * Register `uncaughtException` / `unhandledRejection` reporters on the current
 * process. Reporting is best-effort; the exit is not.
 * @param {Object} options - See createFaultReporter
 * @returns {Function} Unregister function (mainly for tests)
 */
const registerProcessGuards = (options) => {
  const { onUncaughtException, onUnhandledRejection } = createFaultReporter(options);

  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);

  return () => {
    process.removeListener('uncaughtException', onUncaughtException);
    process.removeListener('unhandledRejection', onUnhandledRejection);
  };
};

module.exports = { createFaultReporter, registerProcessGuards, DEFAULT_DRAIN_MS };
