// @ts-check
/**
 * Telegram Notification Module
 *
 * Subscribes to trade events and routes them to Telegram.
 * Factory function pattern (like createHealthMonitor).
 */

const { tradeEvents } = require('./trade-events');
const { getNotificationConfig, getConfiguredFunds, getFundConfig, getBaseCurrency } = require('./config-utils');
const { loadRegimeState } = require('./state-tracker');
const { createContextLogger } = require('./logger');

/**
 * Module-level context logger. The notifier is exchange-agnostic (it fans out
 * events from every fund), so `module` is the only stable context; per-call
 * data carries the channel/transport detail.
 */
const notifierLogger = createContextLogger({ module: 'notifier' });

const TELEGRAM_API = 'https://api.telegram.org/bot';
const MAX_MESSAGE_LENGTH = 4000;

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
 * Build the daily-summary lines for one fund. Pure with respect to its
 * inputs (no disk/network access) so the multi-fund formatting logic is
 * unit-testable without mocking the whole config/state layer.
 * @param {string} exchange
 * @param {string} pair
 * @param {Object} state - `loadRegimeState(exchange, pair)` result
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

  // Check event toggle
  if (config.events[eventType] === false) return false;

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
 * @returns {Object} Notifier instance
 */
const createNotifier = () => {
  let config = getNotificationConfig();
  let queue = [];
  let flushTimer = null;
  let dailySummaryTimer = null;
  let tradeHandler = null;
  let getEngines = null;

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
    const lines = [`${emoji} ${exchange}`];
    lines.push(escapeTelegramMarkdown(event.message));
    return lines.join('\n');
  };

  /**
   * Send a message to Telegram
   * @param {string} text - Message text
   * @returns {Promise<boolean>}
   */
  const sendTelegram = async (text) => {
    const url = `${TELEGRAM_API}${config.telegram.botToken}/sendMessage`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.telegram.chatId,
          text,
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      });
      const data = await resp.json().catch(() => ({}));
      clearTimeout(timeout);
      if (!resp.ok) {
        stats.errors++;
        stats.dailyErrors++;
        const desc = data.description || resp.statusText;
        notifierLogger.error(`❌ 📨 Telegram send failed (${resp.status}): ${desc}`, {
          transport: 'telegram',
          status: resp.status,
          error: desc,
        });
        return false;
      }
      stats.sent++;
      stats.dailySent++;
      stats.lastSentAt = new Date().toISOString();
      return true;
    } catch (err) {
      clearTimeout(timeout);
      stats.errors++;
      stats.dailyErrors++;
      const status = err.status || 'unknown';
      const desc = err.message || String(err);
      notifierLogger.error(`❌ 📨 Telegram send failed (${status}): ${desc}`, {
        transport: 'telegram',
        status,
        error: desc,
      });
      return false;
    }
  };

  /**
   * Flush queued messages
   */
  const flushQueue = () => {
    if (queue.length === 0) return;

    const messages = queue.splice(0);
    stats.queueDepth = queue.length;

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

    // Send each batch
    return batches.reduce(
      (chain, b) => chain.then(() => sendTelegram(b)),
      Promise.resolve(true)
    );
  };

  /**
   * Enqueue a message for sending
   * @param {string} text
   */
  const enqueue = (text) => {
    queue.push(text);
    stats.queueDepth = queue.length;

    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushQueue();
      }, config.rateLimitMs);
    }
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
      const state = loadRegimeState(exchange, pair);
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
    if (tradeHandler) {
      tradeEvents.removeListener('trade', tradeHandler);
      tradeHandler = null;
    }

    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    if (dailySummaryTimer) {
      clearTimeout(dailySummaryTimer);
      dailySummaryTimer = null;
    }

    // Flush remaining messages
    flushQueue();

    notifierLogger.info('ℹ️ 📨 Notifier stopped', { action: 'stop' });
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
  const sendTest = async () => {
    config = getNotificationConfig();

    if (!config.telegram.botToken || !config.telegram.chatId) {
      return { success: false, error: 'Bot token and chat ID are required' };
    }

    const url = `${TELEGRAM_API}${config.telegram.botToken}/sendMessage`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
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
  };

  /**
   * Get notifier stats
   * @returns {Object}
   */
  const getStats = () => ({
    ...stats,
    queueDepth: queue.length,
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
    updateConfig,
    sendTest,
    getStats,
  };
};

module.exports = {
  createNotifier,
  escapeTelegramMarkdown,
  formatFundSummaryLines,
  isQuietHours,
  shouldSendEvent,
  computeDailySummaryDelay,
  CRITICAL_EVENTS,
};
