// @ts-check
/**
 * Telegram Notification Module
 *
 * Subscribes to trade events and routes them to Telegram.
 * Factory function pattern (like createHealthMonitor).
 */

const axios = require('axios');
const { tradeEvents } = require('./trade-events');
const { getNotificationConfig, getConfiguredExchanges, getRegimeConfig } = require('./config-utils');
const { loadRegimeState } = require('./state-tracker');
const { log } = require('./logger');

const TELEGRAM_API = 'https://api.telegram.org/bot';
const MAX_MESSAGE_LENGTH = 4000;

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
};

/**
 * Critical events that bypass quiet hours
 */
const CRITICAL_EVENTS = new Set([
  'safe_mode', 'error', 'flash_move', 'cap_reached',
]);

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
   * Check if currently in quiet hours
   * @returns {boolean}
   */
  const isQuietHours = () => {
    if (!config.quietHours.enabled) return false;
    const hour = new Date().getHours();
    const { start, end } = config.quietHours;
    // Handle overnight ranges (e.g., 23-7)
    if (start > end) {
      return hour >= start || hour < end;
    }
    return hour >= start && hour < end;
  };

  /**
   * Check if an event should be sent
   * @param {string} eventType
   * @returns {boolean}
   */
  const shouldSendEvent = (eventType) => {
    if (!config.enabled) return false;
    if (!config.telegram.botToken || !config.telegram.chatId) return false;

    // Check event toggle
    if (config.events[eventType] === false) return false;

    // Quiet hours check - critical events bypass
    if (isQuietHours() && !CRITICAL_EVENTS.has(eventType)) return false;

    return true;
  };

  /**
   * Format a trade event into a Telegram message
   * @param {Object} event - Trade event
   * @returns {string}
   */
  const formatEvent = (event) => {
    const emoji = EVENT_EMOJI[event.type] || 'ℹ️';
    const exchange = event.exchange ? `*${event.exchange}*` : '';
    const lines = [`${emoji} ${exchange}`];
    lines.push(event.message);
    return lines.join('\n');
  };

  /**
   * Send a message to Telegram
   * @param {string} text - Message text
   * @returns {Promise<boolean>}
   */
  const sendTelegram = (text) => {
    const url = `${TELEGRAM_API}${config.telegram.botToken}/sendMessage`;
    return axios.post(url, {
      chat_id: config.telegram.chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    })
      .then(() => {
        stats.sent++;
        stats.dailySent++;
        stats.lastSentAt = new Date().toISOString();
        return true;
      })
      .catch((err) => {
        stats.errors++;
        stats.dailyErrors++;
        const status = err.response?.status || 'unknown';
        const desc = err.response?.data?.description || err.message;
        log('ERROR', `📨 Telegram send failed (${status}): ${desc}`);
        return false;
      });
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
    batches.reduce(
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
    if (!shouldSendEvent(event.type)) return;
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

    const now = new Date();
    const target = new Date();
    target.setHours(config.dailySummaryHour, 0, 0, 0);
    if (target <= now) {
      target.setDate(target.getDate() + 1);
    }

    const delay = target.getTime() - now.getTime();
    dailySummaryTimer = setTimeout(() => {
      sendDailySummary();
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

    const exchanges = getConfiguredExchanges();
    for (const exchange of exchanges) {
      const state = loadRegimeState(exchange);
      const regime = state.regime?.mode || 'N/A';
      const pos = state.position || {};
      const assetQty = pos.totalAsset || 0;
      const pnl = pos.realizedPnL || 0;
      const cycles = pos.cyclesCompleted || 0;
      const buys = pos.cycleBuys || 0;
      const regimeConfig = getRegimeConfig(exchange);
      const asset = (regimeConfig.productId || 'BTC-USDC').replace('_', '-').split('-')[0];

      lines.push(`*${exchange}* (${regime})`);
      lines.push(`  Position: ${assetQty.toFixed(8)} ${asset}`);
      lines.push(`  Realized P&L: $${pnl.toFixed(2)}`);
      lines.push(`  Cycles: ${cycles}, Current buys: ${buys}`);
      lines.push('');
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
      log('INFO', '📨 Notifications disabled');
      return;
    }

    if (!config.telegram.botToken || !config.telegram.chatId) {
      log('INFO', '📨 Notifications enabled but Telegram not configured');
      return;
    }

    // Subscribe to trade events
    tradeHandler = handleTradeEvent;
    tradeEvents.on('trade', tradeHandler);

    // Schedule daily summary
    scheduleDailySummary();

    log('INFO', '📨 Notifier started');
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

    log('INFO', '📨 Notifier stopped');
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
    }
  };

  /**
   * Send a test notification
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  const sendTest = () => {
    config = getNotificationConfig();

    if (!config.telegram.botToken || !config.telegram.chatId) {
      return Promise.resolve({ success: false, error: 'Bot token and chat ID are required' });
    }

    const url = `${TELEGRAM_API}${config.telegram.botToken}/sendMessage`;
    return axios.post(url, {
      chat_id: config.telegram.chatId,
      text: '🧪 *Critical Mass* - Test notification\nTelegram integration is working!',
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    })
      .then(() => ({ success: true }))
      .catch((err) => {
        const desc = err.response?.data?.description || err.message;
        return { success: false, error: desc };
      });
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

module.exports = { createNotifier };
