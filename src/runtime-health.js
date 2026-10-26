// @ts-check
/**
 * Gateway runtime-health aggregation (issue #862).
 *
 * Keeps three things distinct:
 *   - connectivity  (is the engine process reachable over IPC?)
 *   - intent        (STOPPED / PAUSED are operator choices, not outages)
 *   - operational health (SAFE, AUTH_DENIED, unreadable state, malformed
 *     reply, unfinished/failed fund startup, timeouts, stale UpDown prices)
 *
 * Fund statuses (per exchange/pair probe):
 *   ok | paused | stopped        -> not a failure
 *   safe | auth_denied | error | timeout | unreachable -> failure (degrades
 *   the roll-up when the fund is enabled; reported but non-degrading when the
 *   fund is disabled, since nothing is expected to be trading there).
 */

const { IPC_CHANNELS } = require('./ipc/ipc-protocol');

const DEFAULT_PROBE_TIMEOUT_MS = 3000;

const FAILURE_STATUSES = new Set(['safe', 'auth_denied', 'error', 'timeout', 'unreachable']);

// Highest priority first when summarising an exchange from its funds.
const EXCHANGE_PRIORITY = ['timeout', 'unreachable', 'error', 'auth_denied', 'safe', 'paused', 'ok', 'stopped'];

const MODE_TO_STATUS = {
  ACTIVE: 'ok',
  SAFE: 'safe',
  AUTH_DENIED: 'auth_denied',
  PAUSED: 'paused',
  STOPPED: 'stopped',
  ENGINE_DOWN: 'unreachable',
};

const { isPlainObject: isObject } = require('./value-guards');

/**
 * Interpret a raw `regime:status` IPC reply (envelope
 * `{ success, running, status, error, startup }`) for one fund.
 * @param {*} reply
 * @returns {{status: string, mode: string|null, reason: string|null, isRunning: boolean, uptime: number|null, startup: object|null}}
 */
const interpretFundReply = (reply) => {
  const bad = (reason, extra = {}) => ({ status: 'error', mode: null, reason, isRunning: false, uptime: null, startup: null, ...extra });
  if (!isObject(reply)) return bad('malformed reply');
  const startup = isObject(reply.startup) ? {
    state: reply.startup.state,
    error: typeof reply.startup.error === 'string' ? reply.startup.error : null,
    nextRetryAt: Number.isFinite(reply.startup.nextRetryAt) ? reply.startup.nextRetryAt : null,
  } : null;
  if (reply.success !== true) {
    return bad(typeof reply.error === 'string' && reply.error ? reply.error : 'engine reported failure', { startup });
  }
  const status = reply.status;
  if (!isObject(status)) return bad('reply missing status');
  const mode = status.health?.mode;
  if (typeof mode !== 'string' || !(mode in MODE_TO_STATUS)) return bad(`unrecognized health mode: ${String(mode)}`);
  const isRunning = typeof reply.running === 'boolean' ? reply.running : status.isRunning === true;
  const reasonRaw = status.health?.reason ?? status.health?.safeModeReason ?? status.health?.lastError ?? null;
  // The engine can synthesize STOPPED while auto-resume retries or remains
  // blocked; during start it can also expose an ACTIVE but not-yet-ready
  // engine object. Neither is an intentional stop or a healthy trading fund.
  const startupPending = ['starting', 'retrying', 'blocked'].includes(startup?.state);
  return {
    status: startupPending ? 'error' : MODE_TO_STATUS[mode],
    mode,
    reason: startupPending ? `Fund startup ${startup.state}${startup.error ? `: ${startup.error}` : ''}`
      : typeof reasonRaw === 'string' ? reasonRaw : null,
    isRunning: startupPending ? false : isRunning,
    uptime: typeof status.uptime === 'number' ? status.uptime : null,
    startup,
  };
};

/**
 * Probe one fund with an explicit pair and bounded timeout.
 */
const probeFund = async (ipc, exchange, pair, timeoutMs) => {
  let reply;
  try {
    reply = await ipc.request(IPC_CHANNELS.REGIME_STATUS, {}, exchange, pair, timeoutMs);
  } catch (err) {
    const msg = err?.message || String(err);
    const isTimeout = /timeout/i.test(msg);
    return {
      exchange, pair,
      status: isTimeout ? 'timeout' : 'error',
      mode: null, reason: msg, isRunning: false, uptime: null,
    };
  }
  return { exchange, pair, ...interpretFundReply(reply) };
};

/**
 * Summarise an exchange from its fund probes (worst/most-notable first).
 */
const summarizeExchange = (fundResults) => {
  for (const status of EXCHANGE_PRIORITY) {
    const match = fundResults.find((f) => f.status === status);
    if (match) return match;
  }
  return null;
};

/**
 * Evaluate UpDown (in-process) health.
 */
const summarizeUpDown = (s) => {
  const running = !!s?.running;
  const priceFresh = s?.priceFresh !== false;
  return {
    status: !running ? 'stopped' : (priceFresh ? 'ok' : 'degraded'),
    running,
    priceFresh: running ? priceFresh : null,
    priceAgeMs: s?.priceAgeMs ?? null,
    lastPrice: s?.lastPrice || null,
    latestSignal: s?.latestSignal?.type || null,
  };
};

/**
 * Evaluate Sentinel (in-process) health.
 */
const summarizeSentinel = (s) => ({
  status: !s.running ? 'stopped'
    : (s.feedState === 'unavailable' || s.feedState === 'degraded') ? 'degraded' : 'ok',
  running: s.running,
  activeAlerts: s.activeAlerts || 0,
  lastPollAt: s.lastPollAt || null,
  feedState: s.feedState,
  enabledFeeds: s.enabledFeeds,
  failedFeeds: s.failedFeeds,
  lastSuccessfulFetchAt: s.lastSuccessfulFetchAt,
});

/**
 * Build the full health payload.
 *
 * @param {Object} deps
 * @param {Record<string, {isConnected: () => boolean, request: Function}>} deps.exchangeIPCMap
 * @param {() => Array<{exchange: string, pair: string}>} deps.getConfiguredFunds
 * @param {() => Array<{exchange: string, pair: string}>} deps.getEnabledFunds
 * @param {() => *} deps.getUpDownStatus
 * @param {() => *} deps.getSentinelStatus
 * @param {number} [deps.timeoutMs]
 */
const buildRuntimeHealth = async ({
  exchangeIPCMap, getConfiguredFunds, getEnabledFunds, getUpDownStatus, getSentinelStatus,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
}) => {
  const configured = getConfiguredFunds().map(({ exchange, pair }) => ({ exchange, pair }));
  const enabledKeys = new Set(getEnabledFunds().map((f) => `${f.exchange}/${f.pair}`));
  const engines = {};
  /** @type {Record<string, Record<string, object>>} */
  const funds = {};
  /** names of services whose failure degrades the roll-up */
  const failures = [];
  /** statuses of every service that is relevant to readiness */
  const relevant = [];

  const exchangeSweeps = await Promise.allSettled(Object.entries(exchangeIPCMap).map(async ([name, ipc]) => {
    const exchangeFunds = configured.filter((f) => f.exchange === name);
    if (exchangeFunds.length === 0) {
      engines[name] = { status: 'unconfigured', connected: ipc.isConnected(), isRunning: false, mode: null, uptime: null, required: false };
      return;
    }
    const required = exchangeFunds.some((f) => enabledKeys.has(`${name}/${f.pair}`));
    const connected = ipc.isConnected();
    let results;
    if (!connected) {
      results = exchangeFunds.map(({ pair }) => ({
        exchange: name, pair, status: 'unreachable', mode: null, reason: 'engine IPC not connected', isRunning: false, uptime: null,
      }));
    } else {
      // Status shares the bounded control lane with stop/maintenance commands.
      // One probe per engine leaves those commands capacity even with many funds.
      results = [];
      for (const { pair } of exchangeFunds) {
        results.push(await probeFund(ipc, name, pair, timeoutMs));
      }
    }

    funds[name] = {};
    let requiredFailure = false;
    for (const r of results) {
      const fundRequired = enabledKeys.has(`${name}/${r.pair}`);
      funds[name][r.pair] = {
        exchange: name, pair: r.pair, status: r.status, mode: r.mode, reason: r.reason,
        isRunning: r.isRunning, uptime: r.uptime, enabled: fundRequired,
        startup: r.startup ?? null,
      };
      if (fundRequired && FAILURE_STATUSES.has(r.status)) requiredFailure = true;
    }

    // Only enabled funds drive the exchange summary when any exist, so a
    // disabled fund's stop/failure cannot mask or fake the exchange state.
    const summaryPool = required ? results.filter((r) => enabledKeys.has(`${name}/${r.pair}`)) : results;
    const summary = summarizeExchange(summaryPool);
    engines[name] = {
      status: summary.status,
      connected,
      isRunning: results.some((r) => r.isRunning),
      mode: summary.mode,
      reason: summary.reason,
      startup: summary.startup ?? null,
      uptime: summary.uptime,
      funds: results.length,
      required,
    };
    if (required) {
      relevant.push(summary.status);
      if (requiredFailure) failures.push(name);
    }
  }));

  // Do not release a failed sweep while another exchange still owns a probe.
  const failedSweep = exchangeSweeps.find((result) => result.status === 'rejected');
  if (failedSweep) throw failedSweep.reason;

  engines.updown = summarizeUpDown(getUpDownStatus());
  if (engines.updown.status === 'degraded') failures.push('updown');
  engines.sentinel = summarizeSentinel(getSentinelStatus());
  if (engines.sentinel.status === 'degraded') failures.push('sentinel');
  relevant.push(engines.updown.status, engines.sentinel.status);

  let status = failures.length > 0 ? 'degraded' : 'ok';
  const downLike = new Set(['unreachable', 'timeout', 'error', 'stopped']);
  if (failures.length > 0 && relevant.every((s) => downLike.has(s))) status = 'critical';

  return { status, engines, funds };
};

/**
 * One gateway-owned monitor shares only the current sweep, never cached health.
 * A subsequent request snapshots current configuration and probes afresh.
 * @param {Parameters<typeof buildRuntimeHealth>[0]} deps
 */
const createRuntimeHealthMonitor = (deps) => {
  let inFlight = null;
  const getHealth = () => {
    if (!inFlight) {
      inFlight = Promise.resolve().then(() => buildRuntimeHealth(deps)).finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
  return { getHealth };
};

module.exports = {
  DEFAULT_PROBE_TIMEOUT_MS,
  interpretFundReply,
  probeFund,
  buildRuntimeHealth,
  createRuntimeHealthMonitor,
};
