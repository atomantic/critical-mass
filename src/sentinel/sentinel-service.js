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
const { classifyByKeywords, classifyByAI, resolveSeverity, sanitizeForTelegram } = require('./classifier');
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
 * @param {Function} [deps.fetchAllFeeds] - Feed fetcher override for tests
 * @returns {Object}
 */
const createSentinelService = (io, deps) => {
  const { readJSON, writeJSON, DATA_DIR, getSentinelConfig, fetchAllFeeds: fetchFeeds = fetchAllFeeds } = deps;
  const stateFilePath = path.join(DATA_DIR, STATE_FILE);

  /** @type {NodeJS.Timeout | null} */
  let pollInterval = null;
  /** @type {NodeJS.Timeout | null} */
  let initialPollTimeout = null;
  let running = false;
  let lifecycleGeneration = 0;
  /** @type {Promise<void>|null} */
  let activePoll = null;
  let activePollGeneration = -1;
  /** @type {Promise<void>|null} */
  let queuedPoll = null;

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
      // The AI severity may only upgrade the keyword severity, never downgrade it, and
      // an invalid/out-of-enum AI value is ignored entirely (issue #212F).
      severity: resolveSeverity(keywordResult.severity, aiResult?.severity),
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
  const runPoll = async (generation, allowStopped = false) => {
    const config = getSentinelConfig();
    const isCurrent = () => generation === lifecycleGeneration && (running || allowStopped);
    if (!config.enabled || !isCurrent()) return;

    try {
      const items = await fetchFeeds(config.feeds || []);
      if (!isCurrent()) return;
      let newAlerts = 0;

      for (const item of items) {
        if (!isCurrent()) return;
        const guid = item.guid;
        if (seenGuids.has(guid)) continue;

        const alert = await processItem(item, config);
        if (!isCurrent()) return;

        // Mark the item seen only after its asynchronous classification
        // finishes under the current lifecycle. stop() can then persist safely
        // without recording an item whose alert was never committed.
        seenGuids.set(guid, Date.now());
        if (!alert) continue;

        alerts.push(alert);
        newAlerts++;

        // Emit via Socket.IO
        io.to('sentinel').emit('sentinel:alert', alert);

        // Emit critical/warning alerts via tradeEvents for Telegram. alert.title
        // and (when AI classification is off/failed) alert.summary carry raw,
        // untrusted feed content — sanitizeForTelegram already protects the
        // AI-derived summary/suggestedAction (issue #212F) but title and the
        // raw-description fallback were never run through it, so an unescaped
        // `*`/`_`/`` ` ``/`[`/`]` in a feed item could break Markdown parsing
        // (silently dropping delivery) or inject fake formatting. Sanitize only
        // for the Telegram message — the stored/emitted `alert` object keeps
        // the raw title/summary for the dashboard display.
        const tgTitle = sanitizeForTelegram(alert.title, 200);
        const tgSummary = sanitizeForTelegram(alert.summary, 300);
        if (alert.severity === 'critical') {
          tradeEvents.emit('trade', {
            type: 'sentinel_critical',
            exchange: 'sentinel',
            message: `*NEWS ALERT*\n${tgTitle}\n${tgSummary}\n${alert.suggestedAction ? `Action: ${alert.suggestedAction}` : ''}`,
          });
        } else if (alert.severity === 'warning') {
          tradeEvents.emit('trade', {
            type: 'sentinel_warning',
            exchange: 'sentinel',
            message: `*News Warning*\n${tgTitle}\n${tgSummary}`,
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
      if (!isCurrent()) return;
      errorCount++;
      log('ERROR', `Sentinel poll error: ${err.message}`);
    }
  };

  /**
   * Coalesce polls within one lifecycle. If stop/start supersedes an in-flight
   * poll, queue exactly one current-generation poll behind the fenced old one.
   * @returns {Promise<void>}
   */
  const poll = ({ allowStopped = false } = {}) => {
    const generation = lifecycleGeneration;
    if (!running && !allowStopped) return activePoll || Promise.resolve();
    if (activePoll) {
      if (activePollGeneration === generation) return activePoll;
      if (!queuedPoll) {
        queuedPoll = activePoll.then(() => {
          queuedPoll = null;
          const lifecycleIsCurrent = generation === lifecycleGeneration;
          return lifecycleIsCurrent && (running || allowStopped)
            ? poll({ allowStopped })
            : undefined;
        });
      }
      return queuedPoll;
    }

    activePollGeneration = generation;
    const trackedPoll = runPoll(generation, allowStopped).finally(() => {
      if (activePoll === trackedPoll) {
        activePoll = null;
        activePollGeneration = -1;
      }
    });
    activePoll = trackedPoll;
    return trackedPoll;
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
    lifecycleGeneration++;
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
    lifecycleGeneration++;
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
    await poll({ allowStopped: true });
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
