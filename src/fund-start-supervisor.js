// @ts-check
const { refuseDuringMaintenance } = require('./engine-maintenance');

// Fail closed for unknown errors: only recognizable dependency outages retry.
const isTransientStartError = (error) => {
  const message = String(error?.message || error || '');
  if (/credential|unauthori[sz]ed|forbidden|api.?key|invalid|corrupt|permission|EACCES|ENOSPC/i.test(message)) return false;
  const status = Number(error?.status || error?.statusCode || message.match(/API (\d{3})\b/)?.[1]);
  if (status) return status === 408 || status === 429 || status >= 500 && status <= 599;
  return /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT)$/.test(error?.code || error?.cause?.code || '')
    || /fetch failed|network error|socket hang up|timed?\s*out|rate.?limit|temporarily unavailable/i.test(message);
};

/** One owner per fund across boot, manual requests, retry callbacks and stop. */
const createFundStartSupervisor = ({
  startAttempt, fundKey, resolvePair, regimeEngines, saveRegimeRunningFlag, logger,
  isPaused = () => refuseDuringMaintenance('regime:start'), setTimer = setTimeout, clearTimer = clearTimeout,
}) => {
  const entries = new Map();
  const stopping = new Map();
  let shuttingDown = false;
  const cancel = (entry) => {
    entry.desired = false;
    if (entry.timer) clearTimer(entry.timer);
    entry.timer = null;
    entry.state = 'stopped';
  };
  const attempt = (entry, payload) => {
    entry.state = 'starting';
    entry.promise = Promise.resolve().then(async () => {
      if (!entry.desired || shuttingDown) return { success: false, error: 'Engine start cancelled' };
      const current = () => entry.desired && !shuttingDown;
      let result;
      try {
        result = await startAttempt(payload, entry.exchange, entry.pair, current);
      } catch (err) {
        logger(entry.exchange, entry.pair).error(`Fund startup blocked: ${err.message}`, { error: err.message });
        result = { success: false, error: 'Fund startup failed — see engine logs for details', needsOperator: true };
      }
      if (!current()) {
        if (result.needsOperator) { entry.state = 'blocked'; entry.error = result.error; }
        return result;
      }
      if (result.success) {
        entry.state = result.autoClosed ? 'stopped' : 'running';
        entry.desired = !result.autoClosed;
        entry.attempts = 0;
      } else {
        entry.error = result.error;
        if (entry.automatic && !result.needsOperator && (result.retryable || isTransientStartError(result.error))) schedule(entry);
        else entry.state = 'blocked';
      }
      return result;
    }).finally(() => { entry.promise = null; });
    return entry.promise;
  };
  const schedule = (entry) => {
    const delay = Math.min(5_000 * 2 ** Math.min(entry.attempts++, 6), 300_000);
    entry.state = 'retrying';
    entry.nextRetryAt = Date.now() + delay;
    entry.timer = setTimer(() => {
      entry.timer = null;
      if (!entry.desired || shuttingDown) return;
      // Backup/restore maintenance must remain a writer-quiescence boundary.
      if (isPaused()) { schedule(entry); return; }
      void attempt(entry, {});
    }, delay);
    entry.timer?.unref?.();
  };
  const begin = async (payload, exchange, pair, automatic) => {
    pair = resolvePair(exchange, pair);
    const key = fundKey(exchange, pair);
    if (shuttingDown || stopping.has(key) || automatic && isPaused()) return Promise.resolve({ success: false, error: 'Engine lifecycle is stopping or paused' });
    const previous = entries.get(key);
    if (previous?.promise || regimeEngines.has(key)) return Promise.resolve({ success: false, error: 'Regime engine already running for this fund' });
    if (previous) cancel(previous);
    const entry = { exchange, pair, automatic, desired: true, attempts: 0, state: 'starting', promise: null, timer: null, error: null, nextRetryAt: null };
    entries.set(key, entry);
    return attempt(entry, payload);
  };
  const wrapStop = (stopFund) => async (payload, exchange, pair) => {
    pair = resolvePair(exchange, pair);
    const key = fundKey(exchange, pair);
    if (stopping.has(key)) return stopping.get(key);
    const entry = entries.get(key);
    const previousState = entry?.state;
    const pending = entry?.promise;
    const wasPending = !!(pending || entry?.timer || entry?.state === 'blocked');
    if (entry) cancel(entry);
    // Clear pending auto-resume intent even when there is no running object.
    if (wasPending) saveRegimeRunningFlag(exchange, pair, false);
    const stopped = Promise.resolve(pending).then(() => {
      if (wasPending && !regimeEngines.has(key)) return { success: true, exchange, pair, stopped: true };
      return stopFund(payload, exchange, pair);
    }).then(result => {
      if (entry && !result.success) {
        entry.state = previousState === 'running' ? 'running' : 'blocked';
        entry.error = result.error;
      }
      return result;
    }).finally(() => stopping.delete(key));
    stopping.set(key, stopped);
    return stopped;
  };
  const cancelAll = async ({ shutdown = false, clearDesired = false } = {}) => {
    if (shutdown) shuttingDown = true;
    const pending = [];
    for (const entry of entries.values()) {
      const wasRunning = entry.state === 'running';
      cancel(entry);
      if (wasRunning) entry.state = 'running';
      // Running engines keep their flag until stop-all confirms teardown.
      if (clearDesired && !wasRunning) saveRegimeRunningFlag(entry.exchange, entry.pair, false);
      if (entry.promise) pending.push(entry.promise);
    }
    await Promise.allSettled(pending);
  };
  const getStatus = (exchange, pair) => {
    const entry = entries.get(fundKey(exchange, pair));
    if (!entry) return null;
    const state = entry.state === 'running' && !regimeEngines.has(fundKey(exchange, pair)) ? 'stopped' : entry.state;
    return { state, error: entry.state === 'blocked' || entry.state === 'retrying' ? entry.error : null,
      nextRetryAt: entry.state === 'retrying' ? entry.nextRetryAt : null };
  };
  return { startFund: (payload, exchange, pair) => begin(payload, exchange, pair, false),
    autoResumeFund: (exchange, pair) => begin({}, exchange, pair, true), wrapStop, cancelAll, getStatus };
};
module.exports = { createFundStartSupervisor, isTransientStartError };
