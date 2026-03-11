// @ts-check
/**
 * Sentinel Service
 *
 * Core service for monitoring RSS feeds for market-moving events.
 * Follows the createUpDownService factory pattern.
 */

const path = require('path');
const crypto = require('crypto');
const { fetchAllFeeds } = require('./feed-poller');
const { classifyByKeywords, classifyByAI } = require('./classifier');
const { log } = require('../logger');
const { tradeEvents } = require('../trade-events');

const STATE_FILE = 'sentinel-state.json';
const MAX_SEEN_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Create the Sentinel service
 * @param {Object} io - Socket.IO server instance
 * @param {Object} deps
 * @param {Function} deps.readJSON - Read JSON file
 * @param {Function} deps.writeJSON - Write JSON file
 * @param {string} deps.DATA_DIR - Data directory path
 * @param {Function} deps.getSentinelConfig - Get sentinel config
 * @returns {Object}
 */
const createSentinelService = (io, deps) => {
  const { readJSON, writeJSON, DATA_DIR, getSentinelConfig } = deps;
  const stateFilePath = path.join(DATA_DIR, STATE_FILE);

  /** @type {NodeJS.Timeout | null} */
  let pollInterval = null;
  /** @type {NodeJS.Timeout | null} */
  let initialPollTimeout = null;
  let running = false;

  /** @type {Array<Object>} */
  let alerts = [];

  /** @type {Map<string, number>} guid -> timestamp */
  let seenGuids = new Map();

  let lastPollAt = null;
  let pollCount = 0;
  let errorCount = 0;

  /**
   * Load persisted state from disk
   */
  const loadState = () => {
    const saved = readJSON(stateFilePath, null);
    if (!saved) return;
    if (saved.alerts) alerts = saved.alerts;
    if (saved.seenGuids) {
      seenGuids = new Map(Object.entries(saved.seenGuids));
    }
    if (saved.lastPollAt) lastPollAt = saved.lastPollAt;
    if (saved.pollCount) pollCount = saved.pollCount;
    log('INFO', `Sentinel state loaded: ${alerts.length} alerts, ${seenGuids.size} seen items`);
  };

  // Load state eagerly
  loadState();

  /**
   * Persist current state to disk
   */
  const persistState = () => {
    const config = getSentinelConfig();
    // Prune old seen GUIDs
    const cutoff = Date.now() - MAX_SEEN_AGE_MS;
    for (const [guid, ts] of seenGuids) {
      if (ts < cutoff) seenGuids.delete(guid);
    }
    // Trim alerts
    const maxAlerts = config.maxAlerts || 200;
    if (alerts.length > maxAlerts) {
      alerts = alerts.slice(-maxAlerts);
    }
    writeJSON(stateFilePath, {
      alerts,
      seenGuids: Object.fromEntries(seenGuids),
      lastPollAt,
      pollCount,
    });
  };

  /**
   * Process a single feed item: classify and create alert
   * @param {Object} item - Normalized feed item
   * @param {Object} config - Sentinel config
   * @returns {Promise<Object|null>} Alert or null
   */
  const processItem = async (item, config) => {
    // Keyword classification
    const keywordResult = classifyByKeywords(item, config.keywords);
    if (!keywordResult) return null; // No match

    // Optional AI classification for items that pass keyword filter
    const aiResult = await classifyByAI(item, config.aiClassification);

    const id = crypto.randomUUID();
    return {
      id,
      title: item.title,
      source: item.source,
      sourceUrl: item.link,
      category: aiResult?.category || 'unknown',
      severity: aiResult?.severity || keywordResult.severity,
      summary: aiResult?.summary || item.description.slice(0, 200),
      suggestedAction: aiResult?.suggestedAction || null,
      matchedKeywords: keywordResult.matchedKeywords,
      publishedAt: item.pubDate,
      detectedAt: new Date().toISOString(),
      dismissed: false,
    };
  };

  /**
   * Run a poll cycle
   */
  const poll = async () => {
    const config = getSentinelConfig();
    if (!config.enabled) return;

    try {
      const items = await fetchAllFeeds(config.feeds || []);
      let newAlerts = 0;

      for (const item of items) {
        const guid = item.guid;
        if (seenGuids.has(guid)) continue;
        seenGuids.set(guid, Date.now());

        const alert = await processItem(item, config);
        if (!alert) continue;

        alerts.push(alert);
        newAlerts++;

        // Emit via Socket.IO
        io.to('sentinel').emit('sentinel:alert', alert);

        // Emit critical/warning alerts via tradeEvents for Telegram
        if (alert.severity === 'critical') {
          tradeEvents.emit('trade', {
            type: 'sentinel_critical',
            exchange: 'sentinel',
            message: `*NEWS ALERT*\n${alert.title}\n${alert.summary || ''}\n${alert.suggestedAction ? `Action: ${alert.suggestedAction}` : ''}`,
          });
        } else if (alert.severity === 'warning') {
          tradeEvents.emit('trade', {
            type: 'sentinel_warning',
            exchange: 'sentinel',
            message: `*News Warning*\n${alert.title}\n${alert.summary || ''}`,
          });
        }
      }

      lastPollAt = new Date().toISOString();
      pollCount++;

      if (newAlerts > 0) {
        log('INFO', `Sentinel poll: ${newAlerts} new alerts from ${items.length} items`);
        persistState();
      }

      // Emit status update
      io.to('sentinel').emit('sentinel:status', getStatus());
    } catch (err) {
      errorCount++;
      log('ERROR', `Sentinel poll error: ${err.message}`);
    }
  };

  /**
   * Start the service
   */
  const start = () => {
    const config = getSentinelConfig();
    if (!config.enabled) {
      log('INFO', 'Sentinel service disabled');
      return;
    }
    if (running) return;

    running = true;
    const interval = config.pollIntervalMs || 300000;
    pollInterval = setInterval(poll, interval);

    // Initial poll after short delay
    initialPollTimeout = setTimeout(poll, 5000);

    log('INFO', `Sentinel service started, polling every ${interval / 1000}s`);
  };

  /**
   * Stop the service
   */
  const stop = () => {
    running = false;
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    if (initialPollTimeout) {
      clearTimeout(initialPollTimeout);
      initialPollTimeout = null;
    }
    persistState();
    log('INFO', 'Sentinel service stopped');
  };

  /**
   * Get current status
   */
  const getStatus = () => ({
    running,
    lastPollAt,
    pollCount,
    errorCount,
    totalAlerts: alerts.length,
    activeAlerts: alerts.filter(a => !a.dismissed).length,
    criticalAlerts: alerts.filter(a => !a.dismissed && a.severity === 'critical').length,
    warningAlerts: alerts.filter(a => !a.dismissed && a.severity === 'warning').length,
    seenItems: seenGuids.size,
  });

  /**
   * Get alerts, optionally filtered by severity
   * @param {{ severity?: string }} [filter]
   * @returns {Object[]}
   */
  const getAlerts = (filter = {}) => {
    let result = [...alerts].reverse(); // newest first
    if (filter.severity) {
      result = result.filter(a => a.severity === filter.severity);
    }
    return result;
  };

  /**
   * Force an immediate poll
   */
  const forcePoll = async () => {
    await poll();
  };

  /**
   * Dismiss an alert by ID
   * @param {string} alertId
   * @returns {boolean}
   */
  const dismissAlert = (alertId) => {
    const alert = alerts.find(a => a.id === alertId);
    if (!alert) return false;
    alert.dismissed = true;
    persistState();
    io.to('sentinel').emit('sentinel:status', getStatus());
    return true;
  };

  /**
   * Clear all alerts
   */
  const clearAlerts = () => {
    alerts = [];
    persistState();
    io.to('sentinel').emit('sentinel:status', getStatus());
  };

  return {
    start,
    stop,
    getStatus,
    getAlerts,
    forcePoll,
    dismissAlert,
    clearAlerts,
  };
};

module.exports = { createSentinelService };
