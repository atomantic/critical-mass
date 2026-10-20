// @ts-check
const MIN_DELAY_MS = 60_000;
const FAILURE_RETRY_MS = 5 * 60_000;
const MAINTENANCE_RETRY_MS = 60_000;

/**
 * Disk-anchored scheduler for the recurring backup kinds. The next due time
 * derives from the newest artifact on disk (or the last in-process run), so
 * gateway restarts and settings saves never push a due backup later.
 *
 * @param {Object} deps
 * @param {() => {enabled: boolean} & Record<string, any>} deps.getConfig
 * @param {Record<string, {label: string, failLabel: string, intervalKey: string, startupOffsetMs?: number, newest: () => number | null, run: (config: any) => Promise<{success: boolean, code?: string, error?: string}>}>} deps.kinds
 * @param {() => number} [deps.now]
 * @param {(fn: () => void, ms: number) => any} [deps.setTimer]
 * @param {(handle: any) => void} [deps.clearTimer]
 * @param {() => boolean} [deps.isStopping]
 * @param {(promise: Promise<any>) => Promise<any>} [deps.track]
 * @param {(level: string, message: string) => void} deps.log
 */
const createBackupScheduler = ({
  getConfig, kinds, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  isStopping = () => false, track = (promise) => promise, log,
}) => {
  const timers = new Map();
  const inFlight = new Set();
  const lastRunAt = new Map();
  let firstArm = true;

  const disarm = (name) => {
    if (timers.has(name)) clearTimer(timers.get(name));
    timers.delete(name);
  };

  const delayFor = (name, config) => {
    const kind = kinds[name];
    const last = Math.max(kind.newest() ?? -Infinity, lastRunAt.get(name) ?? -Infinity);
    if (last === -Infinity) return MIN_DELAY_MS;
    return Math.max(MIN_DELAY_MS, last + config[kind.intervalKey] - now());
  };

  const arm = (name, delayOverride) => {
    disarm(name);
    if (isStopping() || inFlight.has(name)) return;
    const config = getConfig();
    if (!config.enabled) return;
    const kind = kinds[name];
    const delay = delayOverride ?? delayFor(name, config) + (firstArm ? (kind.startupOffsetMs ?? 0) : 0);
    timers.set(name, setTimer(() => {
      timers.delete(name);
      fire(name);
    }, delay));
  };

  const fire = (name) => {
    if (isStopping() || inFlight.has(name)) return;
    const kind = kinds[name];
    inFlight.add(name);
    let retryMs;
    track((async () => {
      const config = getConfig();
      if (!config.enabled) return;
      const result = await kind.run(config);
      if (result.success) {
        lastRunAt.set(name, now());
      } else if (result.code === 'maintenance-in-progress') {
        retryMs = MAINTENANCE_RETRY_MS;
      } else {
        retryMs = Math.min(FAILURE_RETRY_MS, config[kind.intervalKey]);
        log('ERROR', `💾 ${kind.failLabel} failed: ${result.error}`);
      }
    })()).catch((err) => {
      retryMs = FAILURE_RETRY_MS;
      log('ERROR', `💾 ${kind.failLabel} failed: ${err.message}`);
    }).finally(() => {
      inFlight.delete(name);
      arm(name, retryMs);
    });
  };

  /** (Re)arm every kind from disk state; disabled config just clears the timers. */
  const reschedule = () => {
    Object.keys(kinds).forEach(disarm);
    if (isStopping()) return;
    const config = getConfig();
    if (!config.enabled) {
      log('INFO', '💾 Backup scheduler disabled');
      return;
    }
    Object.keys(kinds).forEach((name) => arm(name));
    firstArm = false;
    const parts = Object.values(kinds).map((kind) => `${kind.label} every ${(config[kind.intervalKey] / 3600000).toFixed(1)}h`);
    log('INFO', `💾 Backup scheduler started: ${parts.join('; ')}`);
  };

  const stop = () => Object.keys(kinds).forEach(disarm);

  return { reschedule, stop };
};

module.exports = { createBackupScheduler, MIN_DELAY_MS, FAILURE_RETRY_MS, MAINTENANCE_RETRY_MS };
