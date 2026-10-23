// @ts-check
/**
 * Telegram Notification Module
 *
 * Subscribes to trade events and routes them to Telegram.
 * Factory function pattern (like createHealthMonitor).
 */

const { tradeEvents } = require('./trade-events');
const { getNotificationConfig, getConfiguredFunds, getFundConfig, getBaseCurrency } = require('./config-utils');
const { loadFundRegimeState } = require('./state-tracker');
const { createContextLogger } = require('./logger');
const { NOTIFIER_REQUEST_TIMEOUT_MS } = require('./timing-constants');

/**
 * Module-level context logger. The notifier is exchange-agnostic (it fans out
 * events from every fund), so `module` is the only stable context; per-call
 * data carries the channel/transport detail.
 */
const notifierLogger = createContextLogger({ module: 'notifier' });

const TELEGRAM_API = 'https://api.telegram.org/bot';
const MAX_MESSAGE_LENGTH = 4000;
// Cap on messages waiting for the next flush. During a Telegram outage the
// oldest are dropped (and summarised in one notice) so stale alerts cannot
// pile up ahead of new critical ones.
const MAX_QUEUED_MESSAGES = 200;
const TELEGRAM_MAX_RETRIES = 3;
const TELEGRAM_RETRY_MAX_DELAY_MS = 30_000;
// The gateway gives the whole shutdown 30s (SHUTDOWN_TIMEOUT_MS) and awaits
// stop() first, so the notifier's drain must finish well inside that.
const STOP_DRAIN_DEADLINE_MS = 10_000;

const defaultSleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

/**
 * Characters reserved by Telegram's legacy Markdown parse_mode. Trade event
 * messages built by regime-engine/risk-manager are plain text, not intentional
 * markdown, so an unescaped `[`, `]`, `_`, `*`, or `` ` `` (e.g. "[DRY-RUN]",
 * "usdc_cap_exceeded") makes Telegram's parser reject the whole sendMessage
 * call with a 400 "can't parse entities" error, silently dropping delivery.
 */
const TELEGRAM_MARKDOWN_RESERVED_RE = /[_*`[\]]/g;

/**
 * Escape Telegram Markdown v1 reserved characters by prepending a backslash,
 * so plain-text event messages render literally instead of breaking the
 * parser or being interpreted as (possibly unbalanced) formatting.
 * @param {unknown} text
 * @returns {string}
 */
const escapeTelegramMarkdown = (text) => {
  if (typeof text !== 'string') return '';
  return text.replace(TELEGRAM_MARKDOWN_RESERVED_RE, '\\$&');
};

/**
 * Event emoji map
 */
const EVENT_EMOJI = {
  buy_filled: '🛒',
  buy_placed: '🛒',
  buy_placing: '🛒',
  entry_filled: '📥',
  entry_placed: '📥',
  entry_triggered: '📥',
  tp_filled: '💰',
  tp_placed: '📤',
  tp_updated: '📤',
  sell_placed: '📤',
  order_filled: '💰',
  regime_change: '🔄',
  flash_move: '⚡',
  safe_mode: '🛑',
  active_mode: '✅',
  cap_reached: '🚫',
  cycle_reset: '♻️',
  error: '❌',
  spread_pause: '⏸️',
  depth_pause: '⏸️',
  regime_hourly: '📊',
  aggressiveness_suggestion: '💡',
  orders_consolidated: '🔗',
  starting: 'ℹ️',
  complete: 'ℹ️',
  skipped: 'ℹ️',
  disabled: 'ℹ️',
  checking_orders: 'ℹ️',
  price_check: 'ℹ️',
  balance_check: 'ℹ️',
  sentinel_critical: '🚨',
  sentinel_warning: '⚠️',
  sentinel_info: 'ℹ️',
};

/**
 * Critical events that bypass quiet hours
 */
const CRITICAL_EVENTS = new Set([
  'safe_mode', 'error', 'flash_move', 'cap_reached', 'sentinel_critical',
]);

/**
 * Celestial-body TP events notify under the same operator switches as the
 * core TP events (the UI only offers TP Filled / TP Placed). Emitted event
 * names stay unchanged so other consumers keep their detail; only the
 * settings lookup is canonicalized. Mirrors the vocabulary in trade-events.js.
 */
const NOTIFICATION_EVENT_KEY_ALIASES = Object.freeze({
  body_tp_filled: 'tp_filled',
  body_tp_placed: 'tp_placed',
});

/**
 * Resolve the `config.events` key that governs an emitted event type.
 * Unknown types resolve to themselves.
 * @param {string} eventType
 * @returns {string}
 */
const resolveNotificationEventKey = (eventType) =>
  Object.hasOwn(NOTIFICATION_EVENT_KEY_ALIASES, eventType)
    ? NOTIFICATION_EVENT_KEY_ALIASES[eventType]
    : eventType;

/**
 * Build the daily-summary lines for one fund. Pure with respect to its
 * inputs (no disk/network access) so the multi-fund formatting logic is
 * unit-testable without mocking the whole config/state layer.
 * @param {string} exchange
 * @param {string} pair
 * @param {Object} state - `loadFundRegimeState(exchange, pair)` result
 * @param {Object} fundConfig - `getFundConfig(exchange, pair)` result
 * @returns {string[]}
 */
const formatFundSummaryLines = (exchange, pair, state, fundConfig) => {
  const regime = state.regime?.mode || 'N/A';
  const pos = state.position || {};
  const assetQty = pos.totalAsset || 0;
  const pnl = pos.realizedPnL || 0;
  const cycles = pos.cyclesCompleted || 0;
  const buys = pos.cycleBuys || 0;
  const asset = getBaseCurrency(fundConfig?.productId);

  return [
    `*${exchange}* ${escapeTelegramMarkdown(pair)} (${escapeTelegramMarkdown(regime)})`,
    `  Position: ${assetQty.toFixed(8)} ${asset}`,
    `  Realized P&L: $${pnl.toFixed(2)}`,
    `  Cycles: ${cycles}, Current buys: ${buys}`,
    '',
  ];
};

/**
 * Check whether `now` falls inside the configured quiet-hours window.
 * Pure function of config + a Date (defaulting to the real clock at call
 * time) so the overnight-range branch (`start > end`, e.g. 23-7) is
 * independently testable without real timers.
 * @param {{enabled: boolean, start: number, end: number}} quietHours
 * @param {Date} [now]
 * @returns {boolean}
 */
const isQuietHours = (quietHours, now = new Date()) => {
  if (!quietHours.enabled) return false;
  const hour = now.getHours();
  const { start, end } = quietHours;
  // Handle overnight ranges (e.g., 23-7)
  if (start > end) {
    return hour >= start || hour < end;
  }
  return hour >= start && hour < end;
};

/**
 * Decide whether an event type should be delivered right now. Pure function
 * of the full notification config + event type, so the gating order
 * (operator event-toggle checked *before* the quiet-hours/critical-bypass
 * check) is independently testable and pinned against regression.
 * @param {Object} config - Full notification config (`getNotificationConfig()` shape)
 * @param {string} eventType
 * @param {Date} [now]
 * @returns {boolean}
 */
const shouldSendEvent = (config, eventType, now = new Date()) => {
  if (!config.enabled) return false;
  if (!config.telegram.botToken || !config.telegram.chatId) return false;

  // Advisory alerts require an explicit opt-in, even for partial configs.
  if (eventType === 'aggressiveness_suggestion' && config.events.aggressiveness_suggestion !== true) return false;

  // Check event toggle
  if (config.events[resolveNotificationEventKey(eventType)] === false) return false;

  // Quiet hours check - critical events bypass
  if (isQuietHours(config.quietHours, now) && !CRITICAL_EVENTS.has(eventType)) return false;

  return true;
};

/**
 * Compute the delay (ms) until the next occurrence of `hour:00` local time,
 * rolling to tomorrow when that time has already passed today. Pure
 * function of hour + now so scheduleDailySummary's two branches
 * ("target already passed" vs "target still ahead") are independently
 * testable without real timers.
 * @param {number} hour - Target hour in [0, 23]
 * @param {Date} [now]
 * @returns {number} Non-negative delay in milliseconds
 */
const computeDailySummaryDelay = (hour, now = new Date()) => {
  const target = new Date(now);
  target.setHours(hour, 0, 0, 0);
  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now.getTime();
};

/**
 * Create a notifier instance
 * @param {Object} [options]
 * @param {(ms: number) => Promise<void>} [options.sleep] - Retry-delay wait; injectable so tests need not really sleep
 * @returns {Object} Notifier instance
 */
const createNotifier = ({ sleep = defaultSleep } = {}) => {
  let config = getNotificationConfig();
  let queue = [];
  // Messages evicted from `queue` by the cap since the last flush
  let droppedCount = 0;
  // Messages already handed to a send (in flight) and not yet settled
  let inFlightMessages = 0;
  // At most one non-urgent flush may occupy the send tail at a time
  let flushInFlight = false;
  let flushTimer = null;
  let dailySummaryTimer = null;
  let tradeHandler = null;
  let getEngines = null;
  const pendingSends = new Set();
  let stopPromise = null;
  // Set by stop(): retries are abandoned so a Telegram outage cannot hold shutdown.
  let stopping = false;
  const retryWakers = new Set();
  // Sends are serialized through one tail so batches (and retries of an earlier
  // batch) are delivered in enqueue order.
  let sendTail = Promise.resolve();

  const trackSend = (promise) => {
    pendingSends.add(promise);
    promise.then(() => pendingSends.delete(promise), () => pendingSends.delete(promise));
    return promise;
  };

  // Stats
  let stats = {
    sent: 0,
    errors: 0,
    queueDepth: 0,
    lastSentAt: null,
    dailySent: 0,
    dailyErrors: 0,
    dailyResetAt: Date.now(),
  };

  /**
   * Format a trade event into a Telegram message
   * @param {Object} event - Trade event
   * @returns {string}
   */
  const formatEvent = (event) => {
    const emoji = EVENT_EMOJI[event.type] || 'ℹ️';
    // event.exchange is an internal identifier (e.g. "coinbase"), not
    // user/feed-derived text, so it's safe to wrap in bold unescaped.
    const exchange = event.exchange ? `*${event.exchange}*` : '';
    // Regime events carry their fund pair so a multi-fund exchange's alert
    // names the fund it is about (issue #1030).
    const pair = typeof event.data?.pair === 'string' ? ` ${escapeTelegramMarkdown(event.data.pair)}` : '';
    const lines = [`${emoji} ${exchange}${pair}`];
    lines.push(escapeTelegramMarkdown(event.message));
    return lines.join('\n');
  };

  /**
   * One Telegram sendMessage attempt. Never throws.
   * @param {string} text - Message text
   * @param {boolean} markdown - Send with parse_mode Markdown
   * @returns {Promise<{ok: boolean, retryable?: boolean, retryAfterMs?: number, plainTextRetry?: boolean, status?: number|string, desc?: string}>}
   */
  const attemptTelegramSend = async (text, markdown) => {
    const url = `${TELEGRAM_API}${config.telegram.botToken}/sendMessage`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), NOTIFIER_REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.telegram.chatId,
          text,
          ...(markdown && { parse_mode: 'Markdown' }),
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      });
      const data = await resp.json().catch(() => ({}));
      clearTimeout(timeout);
      if (resp.ok) return { ok: true };
      const desc = data.description || resp.statusText;
      const retryAfterSec = Number(data.parameters?.retry_after);
      return {
        ok: false,
        status: resp.status,
        desc,
        // 429 and 5xx are transient; other 4xx (bad token, chat not found) never succeed on retry
        retryable: resp.status === 429 || resp.status >= 500,
        retryAfterMs: Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 0,
        // A Markdown entity-parse 400 can still be delivered as plain text
        plainTextRetry: markdown && resp.status === 400 && /can't parse entities/i.test(String(desc)),
      };
    } catch (err) {
      clearTimeout(timeout);
      return { ok: false, status: err.status || 'unknown', desc: err.message || String(err), retryable: true, retryAfterMs: 0 };
    }
  };

  /**
   * Send a message to Telegram. Transient failures (network error, timeout,
   * 5xx, 429) are retried with capped backoff inside the tracked promise so
   * flush() still waits for them; a Markdown parse rejection gets one
   * plain-text retry; other failures are final.
   * @param {string} text - Message text
   * @returns {Promise<boolean>}
   */
  const sendTelegram = (text, { urgent = false } = {}) => {
    // Urgent sends (the last-resort process guards) must not queue behind an
    // earlier batch that is in retry backoff or a slow attempt: the process
    // is about to exit and the drain window is only seconds.
    if (urgent) return trackSend(deliverTelegram(text));
    const run = sendTail.then(() => deliverTelegram(text));
    sendTail = run.catch(() => {});
    return trackSend(run);
  };

  const deliverTelegram = async (text) => {
    let markdown = true;
    let outgoing = text;
    for (let attempt = 0; ; attempt++) {
      const result = await attemptTelegramSend(outgoing, markdown);
      if (result.ok) {
        stats.sent++;
        stats.dailySent++;
        stats.lastSentAt = new Date().toISOString();
        return true;
      }

      if (result.plainTextRetry) {
        markdown = false;
        outgoing = text.replace(/\\([_*`[\]])/g, '$1'); // drop the Markdown escapes: they would show literally
        notifierLogger.warn(`⚠️ 📨 Telegram rejected Markdown (${result.desc}) — resending as plain text`, {
          transport: 'telegram',
          status: result.status,
          error: result.desc,
        });
        continue;
      }

      if (result.retryable && attempt < TELEGRAM_MAX_RETRIES && !stopping) {
        const delayMs = Math.min(TELEGRAM_RETRY_MAX_DELAY_MS, Math.max(result.retryAfterMs, 1000 * 2 ** attempt));
        notifierLogger.warn(`⚠️ 📨 Telegram send failed (${result.status}): ${result.desc} — retry ${attempt + 1}/${TELEGRAM_MAX_RETRIES} in ${delayMs}ms`, {
          transport: 'telegram',
          status: result.status,
          error: result.desc,
          attempt: attempt + 1,
          delayMs,
        });
        let wake;
        const woken = new Promise((resolve) => { wake = resolve; });
        retryWakers.add(wake);
        await Promise.race([sleep(delayMs), woken]);
        retryWakers.delete(wake);
        if (stopping) return recordSendFailure(result);
        continue;
      }

      return recordSendFailure(result);
    }
  };

  const recordSendFailure = (result) => {
    stats.errors++;
    stats.dailyErrors++;
    notifierLogger.error(`❌ 📨 Telegram send failed (${result.status}): ${result.desc}`, {
      transport: 'telegram',
      status: result.status,
      error: result.desc,
    });
    return false;
  };

  /**
   * Flush queued messages
   */
  const flushQueue = ({ urgent = false } = {}) => {
    if (queue.length === 0) return;
    // A previous non-urgent flush is still delivering (or retrying): leave
    // these messages queued so they join the next batch instead of stacking
    // more work on the send tail.
    if (!urgent && flushInFlight) return;

    const messages = queue.splice(0);
    if (droppedCount > 0) {
      messages.unshift(`⚠️ ${droppedCount} older notification${droppedCount === 1 ? ' was' : 's were'} dropped while Telegram was unreachable`);
      droppedCount = 0;
    }
    inFlightMessages += messages.length;
    stats.queueDepth = queue.length + inFlightMessages;
    const settled = () => {
      inFlightMessages -= messages.length;
      stats.queueDepth = queue.length + inFlightMessages;
    };

    // Combine into batches respecting max length
    let batch = '';
    const batches = [];

    for (const msg of messages) {
      const separator = batch ? '\n---\n' : '';
      if ((batch + separator + msg).length > MAX_MESSAGE_LENGTH) {
        if (batch) batches.push(batch);
        batch = msg;
      } else {
        batch += separator + msg;
      }
    }
    if (batch) batches.push(batch);

    if (urgent) {
      // Bypass the serialized tail but keep this flush's own batches in order
      const run = batches.reduce(
        (chain, b) => chain.then(async (sent) => (await sendTelegram(b, { urgent })) && sent),
        Promise.resolve(true)
      );
      run.then(settled, settled);
      return trackSend(run);
    }

    // Queue every batch on the serialized send tail; a failed batch does not
    // stop the later ones
    flushInFlight = true;
    const run = Promise.all(batches.map((b) => sendTelegram(b))).then((results) => results.every(Boolean));
    const done = () => {
      flushInFlight = false;
      settled();
    };
    run.then(done, done);
    return trackSend(run);
  };

  const armFlushTimer = () => {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushQueue();
      // Messages left queued because a send is still in flight: look again next interval
      if (queue.length > 0) armFlushTimer();
    }, config.rateLimitMs);
  };

  /**
   * Enqueue a message for sending
   * @param {string} text
   */
  const enqueue = (text) => {
    queue.push(text);
    if (queue.length > MAX_QUEUED_MESSAGES) {
      droppedCount += queue.length - MAX_QUEUED_MESSAGES;
      queue.splice(0, queue.length - MAX_QUEUED_MESSAGES);
    }
    stats.queueDepth = queue.length + inFlightMessages;

    if (!flushTimer) armFlushTimer();
  };

  /**
   * Flush the pending queue immediately, cancelling the rate-limit timer.
   * Used by shutdown and by the last-resort process guards (issue #532), where
   * waiting out `config.rateLimitMs` would mean the operator never hears about
   * the fault that is killing the process. The queued batches are sent
   * urgently: they do not wait behind earlier batches that are retrying.
   * @returns {Promise<boolean>}
   */
  const flush = async () => drainQueue({ urgent: true });

  const drainQueue = async ({ urgent }) => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    let successful = true;
    // Loop: a non-urgent flush skipped behind an in-flight one leaves messages
    // queued, so keep going until the queue is empty and nothing is pending.
    // The caller (stop) bounds this with its drain deadline.
    do {
      flushQueue({ urgent });
      while (pendingSends.size) {
        const results = await Promise.allSettled([...pendingSends]);
        successful = results.every((result) => result.status === 'fulfilled' && result.value !== false) && successful;
      }
    } while (queue.length > 0);
    return successful;
  };

  /**
   * Handle incoming trade event
   * @param {Object} event
   */
  const handleTradeEvent = (event) => {
    if (!shouldSendEvent(config, event.type)) return;
    const text = formatEvent(event);
    enqueue(text);
  };

  /**
   * Schedule daily summary
   */
  const scheduleDailySummary = () => {
    if (dailySummaryTimer) {
      clearTimeout(dailySummaryTimer);
      dailySummaryTimer = null;
    }

    const delay = computeDailySummaryDelay(config.dailySummaryHour);
    dailySummaryTimer = setTimeout(() => {
      // setTimeout callback: a throw in sendDailySummary would crash the
      // process and skip the reschedule, silently killing all future
      // summaries. Guard so the daily cadence always continues.
      try {
        sendDailySummary();
      } catch (err) {
        notifierLogger.error(`❌ 📨 Daily summary failed: ${err.message}`, {
          action: 'daily-summary',
          error: err.message,
        });
      }
      // Reschedule for next day
      scheduleDailySummary();
    }, delay);
  };

  /**
   * Build and send daily summary
   */
  const sendDailySummary = () => {
    if (!config.enabled || !config.telegram.botToken || !config.telegram.chatId) return;

    const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const lines = [`📊 *Daily Summary* (${date})\n`];

    // Iterate configured FUNDS (exchange+pair), not just exchanges — an
    // exchange can carry multiple funds (e.g. BTC-USDC and ETH-USDC), and
    // productId lives on the fund config block, not the regime config.
    const funds = getConfiguredFunds();
    for (const { exchange, pair } of funds) {
      const state = loadFundRegimeState(exchange, pair);
      const fundConfig = getFundConfig(exchange, pair);
      lines.push(...formatFundSummaryLines(exchange, pair, state, fundConfig));
    }

    // Add notification stats
    lines.push(`_Messages today: ${stats.dailySent}, Errors: ${stats.dailyErrors}_`);

    // Reset daily counters
    stats.dailySent = 0;
    stats.dailyErrors = 0;
    stats.dailyResetAt = Date.now();

    sendTelegram(lines.join('\n'));
  };

  /**
   * Start the notifier
   * @param {Function} [engineGetter] - Callback to access regime engines
   */
  const start = (engineGetter) => {
    stopPromise = null;
    stopping = false;
    config = getNotificationConfig();
    getEngines = engineGetter || null;

    if (!config.enabled) {
      notifierLogger.info('ℹ️ 📨 Notifications disabled', { action: 'start', enabled: false });
      return;
    }

    if (!config.telegram.botToken || !config.telegram.chatId) {
      notifierLogger.info('ℹ️ 📨 Notifications enabled but Telegram not configured', {
        action: 'start',
        transport: 'telegram',
        configured: false,
      });
      return;
    }

    // Subscribe to trade events
    tradeHandler = handleTradeEvent;
    tradeEvents.on('trade', tradeHandler);

    // Schedule daily summary
    scheduleDailySummary();

    notifierLogger.info('ℹ️ 📨 Notifier started', { action: 'start' });
  };

  /**
   * Stop the notifier
   */
  const stop = () => {
    if (stopPromise) return stopPromise;
    if (tradeHandler) {
      tradeEvents.removeListener('trade', tradeHandler);
      tradeHandler = null;
    }

    if (dailySummaryTimer) {
      clearTimeout(dailySummaryTimer);
      dailySummaryTimer = null;
    }

    // Abandon retry backoff: wake any sleeping retry and refuse further retries.
    stopping = true;
    for (const wake of retryWakers) wake();
    retryWakers.clear();

    // Own queued batches and sends that already left the queue (including
    // daily summaries and test notifications), sharing one drain on repeats.
    // Bounded: attempts already in flight may take up to their own 10s abort
    // each, so cap the whole drain well under the gateway's shutdown deadline.
    let deadlineTimer;
    const deadline = new Promise((resolve) => {
      deadlineTimer = setTimeout(() => {
        notifierLogger.warn('⚠️ 📨 Notifier drain deadline reached on stop — abandoning unsent messages', {
          action: 'stop',
          deadlineMs: STOP_DRAIN_DEADLINE_MS,
        });
        resolve(false);
      }, STOP_DRAIN_DEADLINE_MS);
      deadlineTimer.unref?.();
    });
    const drain = Promise.race([drainQueue({ urgent: false }), deadline]).finally(() => clearTimeout(deadlineTimer)).catch((err) => {
      notifierLogger.error(`❌ 📨 Flush on stop failed: ${err.message}`, { action: 'stop', error: err.message });
      return false;
    }).then((sent) => {
      notifierLogger.info('ℹ️ 📨 Notifier stopped', { action: 'stop' });
      return sent;
    }).finally(() => {
      // A disabled notifier can later send a test message without start().
      // A subsequent stop must drain that new work, not reuse a stale result.
      if (stopPromise === drain) stopPromise = null;
    });
    stopPromise = drain;
    return drain;
  };

  /**
   * Hot-reload configuration
   * @param {Object} updates - Config updates
   */
  const updateConfig = (updates) => {
    config = getNotificationConfig();
    const wasRunning = !!tradeHandler;

    if (config.enabled && !wasRunning) {
      start(getEngines);
    } else if (!config.enabled && wasRunning) {
      stop();
    } else if (wasRunning) {
      // Already running: `start()` only re-subscribes/reschedules on an
      // enabled-transition, so a live dailySummaryHour change would
      // otherwise sit unused until the process restarts (issue #426).
      scheduleDailySummary();
    }
  };

  /**
   * Send a test notification
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  const sendTest = () => trackSend((async () => {
    config = getNotificationConfig();

    if (!config.telegram.botToken || !config.telegram.chatId) {
      return { success: false, error: 'Bot token and chat ID are required' };
    }

    const url = `${TELEGRAM_API}${config.telegram.botToken}/sendMessage`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), NOTIFIER_REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.telegram.chatId,
          text: '🧪 *Critical Mass* - Test notification\nTelegram integration is working!',
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      });
      const data = await resp.json().catch(() => ({}));
      clearTimeout(timeout);
      if (!resp.ok) {
        return { success: false, error: data.description || resp.statusText };
      }
      return { success: true };
    } catch (err) {
      clearTimeout(timeout);
      return { success: false, error: err.message };
    }
  })());

  /**
   * Get notifier stats
   * @returns {Object}
   */
  const getStats = () => ({
    ...stats,
    queueDepth: queue.length + inFlightMessages,
    isRunning: !!tradeHandler,
    config: {
      enabled: config.enabled,
      hasToken: !!config.telegram.botToken,
      hasChatId: !!config.telegram.chatId,
    },
  });

  return {
    start,
    stop,
    flush,
    updateConfig,
    sendTest,
    getStats,
  };
};

module.exports = {
  resolveNotificationEventKey,
  createNotifier,
  escapeTelegramMarkdown,
  formatFundSummaryLines,
  isQuietHours,
  shouldSendEvent,
  computeDailySummaryDelay,
  CRITICAL_EVENTS,
};
