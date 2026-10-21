// @ts-check
const MIN_DELAY_MS = 60_000;
const FAILURE_RETRY_MS = 5 * 60_000;
const MAINTENANCE_RETRY_MS = 60_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

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
 * @param {(message: string, data: object) => void} [deps.alert]
 */
const createBackupScheduler = ({
  getConfig, kinds, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  isStopping = () => false, track = (promise) => promise, log, alert = () => {},
}) => {
  const timers = new Map();
  const inFlight = new Set();
  const lastRunAt = new Map();
  let firstArm = true;
  const failures = new Map(); // name -> { count, at, error, capAlerted }

  /** Record a failed run; returns the exponential retry delay (5, 10, 20 min... capped at the interval). */
  const recordFailure = (name, config, error) => {
    const kind = kinds[name];
    const prev = failures.get(name);
    const count = (prev?.count ?? 0) + 1;
    const interval = config[kind.intervalKey];
    const retryMs = Math.min(FAILURE_RETRY_MS * 2 ** Math.min(count - 1, 30), interval);
    const atCap = retryMs >= interval;
    const entry = { count, at: now(), error, capAlerted: prev?.capAlerted ?? false };
    failures.set(name, entry);
    log('ERROR', `💾 ${kind.failLabel} failed (${count} consecutive): ${error}`);
    if (count === 1 || (atCap && !entry.capAlerted)) {
      if (atCap) entry.capAlerted = true;
      try {
        alert(`${kind.failLabel} failed ${count} time(s): ${error}. Next retry in ${Math.round(retryMs / 60000)} min.`, { kind: name, failures: count, error });
      } catch (err) {
        log('ERROR', `💾 ${kind.failLabel} alert failed: ${err.message}`);
      }
    }
    return retryMs;
  };

  const disarm = (name) => {
    if (timers.has(name)) clearTimer(timers.get(name));
    timers.delete(name);
  };

  // Absolute due times survive repeated arms, so an overdue run's grace and the
  // startup offset are applied once rather than re-granted on every settings save.
  const deadlines = new Map();

  const dueFor = (name, config) => {
    const kind = kinds[name];
    const last = Math.max(kind.newest() ?? -Infinity, lastRunAt.get(name) ?? -Infinity);
    return last === -Infinity ? -Infinity : last + config[kind.intervalKey];
  };

  const startTimer = (name, deadline) => {
    const remaining = Math.max(0, deadline - now());
    const delay = Math.min(remaining, MAX_TIMER_MS);
    timers.set(name, setTimer(() => {
      timers.delete(name);
      if (remaining > MAX_TIMER_MS) startTimer(name, deadline);
      else fire(name);
    }, delay));
  };

  const arm = (name, retryMs) => {
    disarm(name);
    if (isStopping() || inFlight.has(name)) return;
    const config = getConfig();
    if (!config.enabled) return;
    let deadline;
    if (retryMs !== undefined) {
      deadline = now() + retryMs;
    } else {
      try {
        const due = dueFor(name, config);
        const offset = kinds[name].startupOffsetMs ?? 0;
        const pending = deadlines.get(name);
        // A pending deadline stays valid only while it is still the grace for the same overdue state.
        const keep = pending !== undefined && due <= pending && pending <= Math.max(due, now() + MIN_DELAY_MS + offset);
        deadline = keep ? pending : Math.max(due, now() + MIN_DELAY_MS + (firstArm ? offset : 0));
      } catch (err) {
        log('ERROR', `💾 ${kinds[name].failLabel} schedule lookup failed: ${err.message}`);
        deadline = now() + FAILURE_RETRY_MS;
      }
    }
    deadlines.set(name, deadline);
    startTimer(name, deadline);
  };

  const fire = (name) => {
    if (isStopping() || inFlight.has(name)) return;
    const kind = kinds[name];
    inFlight.add(name);
    deadlines.delete(name);
    let retryMs;
    track((async () => {
      const config = getConfig();
      if (!config.enabled) return;
      const result = await kind.run(config);
      if (result.success) {
        lastRunAt.set(name, now());
        failures.delete(name);
      } else if (result.code === 'maintenance-in-progress') {
        retryMs = MAINTENANCE_RETRY_MS;
      } else {
        retryMs = recordFailure(name, config, result.error);
      }
    })()).catch((err) => {
      retryMs = recordFailure(name, getConfig(), err.message);
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
      deadlines.clear();
      log('INFO', '💾 Backup scheduler disabled');
      return;
    }
    Object.keys(kinds).forEach((name) => arm(name));
    firstArm = false;
    const parts = Object.values(kinds).map((kind) => `${kind.label} every ${(config[kind.intervalKey] / 3600000).toFixed(1)}h`);
    log('INFO', `💾 Backup scheduler started: ${parts.join('; ')}`);
  };

  const stop = () => Object.keys(kinds).forEach(disarm);

  /** Per-kind last failure, or null when the latest run succeeded. */
  const getStatus = () => Object.fromEntries(Object.keys(kinds).map((name) => {
    const f = failures.get(name);
    return [name, f ? { lastFailure: { at: f.at, error: f.error }, consecutiveFailures: f.count } : { lastFailure: null, consecutiveFailures: 0 }];
  }));

  return { reschedule, stop, getStatus };
};

module.exports = { createBackupScheduler, MIN_DELAY_MS, FAILURE_RETRY_MS, MAINTENANCE_RETRY_MS };
