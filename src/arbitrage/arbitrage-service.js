// @ts-check
/**
 * Cross-pair Arbitrage Monitor service.
 *
 * Polls public order books on each enabled venue, analyzes same-venue BTC
 * cross-pair loops (cross-pair-analyzer.js), and keeps an alert history of
 * opportunity "episodes": opened once a condition holds for `confirmPolls`
 * polls, updated with the current and peak edge while it lasts, and closed
 * after it fails for `closeAfterPolls` polls.
 *
 * MONITORING ONLY. This service has no access to exchange keys or order
 * paths and never places, cancels or sizes an order.
 */

const path = require('path');
const crypto = require('crypto');
const { planVenue, analyzeVenue } = require('./cross-pair-analyzer');
const { createVenueSources, fetchReferenceFx: defaultFetchReferenceFx, VENUE_IDS } = require('./venue-sources');
const { createContextLogger } = require('../logger');
const { quarantineIfUnreadable } = require('../state-file-quarantine');
const { tradeEvents } = require('../trade-events');

const arbitrageLogger = createContextLogger({ module: 'arbitrage-service' });

const STATE_FILE = 'arbitrage-state.json';
const MARKETS_TTL_MS = 60 * 60 * 1000;
const ROOM = 'arbitrage';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Telegram Markdown (legacy) treats these as formatting.
 * @param {unknown} value
 * @returns {string}
 */
const tg = (value) => String(value ?? '').replace(/[*_`[\]]/g, '');

const fmtUsd = (value) => Number.isFinite(value) ? `$${Math.round(value).toLocaleString('en-US')}` : 'n/a';
const fmtBps = (value) => Number.isFinite(value) ? `${value > 0 ? '+' : ''}${Math.round(value).toLocaleString('en-US')} bps` : 'n/a';

/**
 * @param {Object} io - realtime bus (src/realtime-bus.js)
 * @param {Object} deps
 * @param {Function} deps.readJSON
 * @param {Function} deps.writeJSON
 * @param {string} deps.DATA_DIR
 * @param {Function} deps.getArbitrageConfig
 * @param {Record<string, any>} [deps.sources] - venue sources override for tests
 * @param {Function} [deps.fetchReferenceFx] - reference FX override for tests
 * @param {(ms: number) => Promise<void>} [deps.sleep] - request spacing override for tests
 * @param {() => number} [deps.now]
 * @returns {Object}
 */
const createArbitrageService = (io, deps) => {
  const {
    readJSON, writeJSON, DATA_DIR, getArbitrageConfig,
    fetchReferenceFx = defaultFetchReferenceFx,
    sleep = defaultSleep,
    now = Date.now,
  } = deps;
  const stateFilePath = path.join(DATA_DIR, STATE_FILE);

  /** @type {Record<string, any>|null} */
  let sources = deps.sources || null;
  const getSources = () => {
    if (!sources) sources = createVenueSources({ knownCurrencies: getArbitrageConfig().quoteCurrencies });
    return sources;
  };

  /** @type {NodeJS.Timeout|null} */
  let pollTimer = null;
  /** @type {NodeJS.Timeout|null} */
  let initialPollTimeout = null;
  let running = false;
  let lifecycleGeneration = 0;
  /** @type {Promise<void>|null} */
  let activePoll = null;

  /** @type {Array<Object>} */
  let alerts = [];
  let pollCount = 0;
  let errorCount = 0;
  let lastPollAt = null;
  let lastPollDurationMs = null;

  /** @type {Map<string, { markets: any[], fetchedAt: number }>} */
  const marketCache = new Map();
  /** @type {{ rates: Record<string, number>, fetchedAt: number|null, error: string|null }} */
  let referenceFx = { rates: {}, fetchedAt: null, error: null };
  /** @type {{ at: string|null, venues: Record<string, any> }} */
  let snapshot = { at: null, venues: {} };
  /** @type {Map<string, { hits: number, misses: number }>} */
  const conditions = new Map();

  const loadState = () => {
    quarantineIfUnreadable(stateFilePath, arbitrageLogger);
    const saved = readJSON(stateFilePath, null);
    alerts = Array.isArray(saved?.alerts) ? saved.alerts : [];
    pollCount = Number(saved?.pollCount) || 0;
    lastPollAt = saved?.lastPollAt || null;
    // Streaks are not persisted: after a restart an open episode must be seen
    // again, or it closes after closeAfterPolls misses.
    conditions.clear();
  };
  loadState();

  const persistState = () => {
    const { maxAlerts } = getArbitrageConfig();
    if (alerts.length > maxAlerts) {
      // Trim oldest closed episodes first; an open episode is never dropped.
      const open = alerts.filter((a) => a.status === 'open');
      const closed = alerts.filter((a) => a.status !== 'open');
      alerts = [...closed.slice(Math.max(0, closed.length - Math.max(0, maxAlerts - open.length))), ...open]
        .sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt));
    }
    writeJSON(stateFilePath, { alerts, pollCount, lastPollAt });
  };

  const emit = (event, payload) => io.to(ROOM).emit(event, payload);

  /** @returns {Promise<void>} */
  const refreshReferenceFx = async (config) => {
    if (!config.referenceFx.enabled) { referenceFx = { rates: {}, fetchedAt: null, error: null }; return; }
    if (referenceFx.fetchedAt && now() - referenceFx.fetchedAt < config.referenceFx.refreshMs) return;
    try {
      referenceFx = { rates: await fetchReferenceFx(config.homeCurrency), fetchedAt: now(), error: null };
    } catch (err) {
      // Keep the last good rates; they are only indicative.
      referenceFx = { ...referenceFx, error: err.message };
    }
  };

  /**
   * Read one venue: markets (cached), the books its plan needs, and the analysis.
   * @returns {Promise<Object>}
   */
  const pollVenue = async (id, config, isCurrent) => {
    const source = getSources()[id];
    const venueConfig = config.venues[id];
    const startedAt = now();
    const result = { id, label: source?.label || id, ok: false, error: null, at: null, failedBooks: [], analysis: null, durationMs: null };
    if (!source) { result.error = 'No public data source for this venue'; return result; }
    try {
      let cached = marketCache.get(id);
      if (!cached || now() - cached.fetchedAt > MARKETS_TTL_MS) {
        cached = { markets: await source.listMarkets(), fetchedAt: now() };
        marketCache.set(id, cached);
      }
      const plan = planVenue({
        markets: cached.markets,
        home: config.homeCurrency,
        quoteCurrencies: config.quoteCurrencies,
        parity: source.parity || [],
      });
      /** @type {Record<string, any>} */
      const books = {};
      let first = true;
      for (const symbol of plan.requiredSymbols) {
        if (!isCurrent()) return result;
        if (!first && source.minRequestSpacingMs) await sleep(source.minRequestSpacingMs);
        first = false;
        try {
          books[symbol] = await source.fetchBook(symbol, config.bookDepth);
        } catch (err) {
          result.failedBooks.push({ symbol, error: err.message });
        }
      }
      result.analysis = analyzeVenue({
        venue: id,
        plan,
        books,
        feeBps: venueConfig.takerFeeBps,
        externalHomePerUnit: referenceFx.rates,
        notionalUsd: config.notionalUsd,
        minEdgeBps: config.alertMinNetBps,
      });
      // A venue whose BTC books all failed has nothing to say this poll.
      result.ok = plan.assetMarkets.length > 0 && plan.assetMarkets.some((m) => books[m.symbol]);
      if (!result.ok) result.error = plan.assetMarkets.length ? 'Every BTC order book failed to load' : 'No BTC markets in the configured quote currencies';
    } catch (err) {
      result.error = err.message;
    }
    result.at = new Date(now()).toISOString();
    result.durationMs = now() - startedAt;
    return result;
  };

  /** The pair farther from the venue median is the anomalous one. */
  const anomalousPair = (analysis, route) => {
    // Spread-aware edge, not mid deviation: a wide book's mid can sit far
    // from the reference while neither side of it is tradeable at a profit.
    const edge = (symbol) => analysis.pairs.find((p) => p.symbol === symbol)?.edgeBps ?? -Infinity;
    return edge(route.buy) >= edge(route.sell) ? route.buy : route.sell;
  };

  /**
   * Conditions that hold in this venue snapshot, keyed for episode tracking.
   * One opportunity per anomalous pair (its best route) so a single slipped
   * pair does not raise an alert for every other pair it loops against.
   */
  const conditionsFor = (venueResult, config) => {
    const { analysis } = venueResult;
    const found = [];
    const bestByAnomaly = new Map();
    for (const route of analysis.routes) {
      const best = route.best;
      if (!best || best.netBps < config.alertMinNetBps || best.notionalUsd < config.minAlertNotionalUsd) continue;
      const anomaly = anomalousPair(analysis, route);
      const existing = bestByAnomaly.get(anomaly);
      if (!existing || best.profitUsd > existing.best.profitUsd) bestByAnomaly.set(anomaly, route);
    }
    for (const [anomaly, route] of bestByAnomaly) {
      const pair = analysis.pairs.find((p) => p.symbol === anomaly);
      found.push({
        key: `opportunity:${venueResult.id}:${anomaly}`,
        type: 'opportunity',
        severity: 'critical',
        venue: venueResult.id,
        venueLabel: venueResult.label,
        pair: pair?.pair || anomaly,
        measure: {
          routeId: route.id,
          buyPair: route.buyPair,
          sellPair: route.sellPair,
          legs: route.legs,
          netBps: route.best.netBps,
          grossBps: route.grossBps,
          notionalUsd: route.best.notionalUsd,
          profitUsd: route.best.profitUsd,
          largestProfitableUsd: route.largestProfitableUsd,
          deviationBps: pair?.deviationBps ?? null,
          impliedMid: pair?.impliedMid ?? null,
          medianImplied: analysis.medianImplied,
        },
      });
    }
    // Executable pairs alert only as opportunities (net of fees, real depth).
    // A dislocation is the watch-only case: a pair that cannot complete a
    // round trip on the venue (no on-venue conversion, e.g. EUR on Gemini)
    // whose top-of-book edge at reference FX is large. It is never actionable.
    for (const pair of analysis.pairs) {
      if (pair.priceBasis !== 'indicative' || !Number.isFinite(pair.edgeBps) || pair.edgeBps < config.dislocationAlertBps) continue;
      found.push({
        key: `dislocation:${venueResult.id}:${pair.symbol}`,
        type: 'dislocation',
        severity: 'info',
        venue: venueResult.id,
        venueLabel: venueResult.label,
        pair: pair.pair,
        measure: {
          deviationBps: pair.deviationBps,
          externalDeviationBps: pair.externalDeviationBps,
          impliedMid: pair.impliedMid,
          medianImplied: analysis.medianImplied,
          conversionSource: pair.conversionSource,
          conversionPath: pair.conversionPath,
          executable: false,
          spreadBps: pair.spreadBps,
          edgeBps: pair.edgeBps,
          edgeSide: pair.edgeSide,
          buyPrice: pair.buyPrice,
          sellPrice: pair.sellPrice,
          topBidHome: pair.topBidHome,
          topAskHome: pair.topAskHome,
        },
      });
    }
    return found;
  };

  /** Rank used for "peak": profit for opportunities, |deviation| for dislocations. */
  const magnitude = (type, measure) => type === 'opportunity' ? (measure.profitUsd ?? 0) : (measure.edgeBps ?? Math.abs(measure.deviationBps ?? 0));

  const notifyOpened = (alert) => {
    const m = alert.current;
    if (alert.type === 'opportunity') {
      tradeEvents.emit('trade', {
        type: 'arbitrage_opportunity',
        exchange: 'arbitrage',
        message: [
          `*ARBITRAGE* ${tg(alert.venueLabel)}: buy BTC via ${tg(m.buyPair)}, sell via ${tg(m.sellPair)}`,
          `Net ${fmtBps(m.netBps)} after taker fees at ${fmtUsd(m.notionalUsd)} (est. profit ${fmtUsd(m.profitUsd)})`,
          `${tg(alert.pair)} implied ${fmtUsd(m.impliedMid)} vs venue median ${fmtUsd(m.medianImplied)} (${fmtBps(m.deviationBps)})`,
          'Monitoring only: no orders placed.',
        ].join('\n'),
      });
    } else if (!m.executable) {
      // Dislocations are watch-only: the pair cannot round-trip on the venue.
      tradeEvents.emit('trade', {
        type: 'arbitrage_dislocation',
        exchange: 'arbitrage',
        message: `*Price dislocation (watch only)* ${tg(alert.venueLabel)} ${tg(alert.pair)}: ${fmtBps(m.edgeBps)} top-of-book edge at reference FX. Not executable on venue: no ${tg(alert.pair.split('/')[1])} conversion market there.`,
      });
    }
  };

  const notifyClosed = (alert) => {
    const minutes = Math.max(1, Math.round((Date.parse(alert.lastSeenAt) - Date.parse(alert.openedAt)) / 60_000));
    tradeEvents.emit('trade', {
      type: 'arbitrage_closed',
      exchange: 'arbitrage',
      message: `Arbitrage ${alert.type} closed: ${tg(alert.venueLabel)} ${tg(alert.pair)} after ${minutes} min (peak ${alert.type === 'opportunity' ? `${fmtBps(alert.peak.netBps)}, ${fmtUsd(alert.peak.profitUsd)}` : fmtBps(alert.peak.edgeBps ?? alert.peak.deviationBps)})`,
    });
  };

  /**
   * Advance episode state from this poll's conditions.
   * @param {Array<Object>} found - conditions present this poll
   * @param {Set<string>} observedVenues - venues read successfully this poll
   * @param {Object} config
   * @returns {boolean} whether alerts changed
   */
  const applyConditions = (found, observedVenues, config) => {
    const at = new Date(now()).toISOString();
    let changed = false;
    const present = new Set();
    for (const condition of found) {
      present.add(condition.key);
      const streak = conditions.get(condition.key) || { hits: 0, misses: 0 };
      streak.hits++;
      streak.misses = 0;
      conditions.set(condition.key, streak);
      const open = alerts.find((a) => a.key === condition.key && a.status === 'open');
      if (open) {
        open.current = condition.measure;
        open.severity = condition.severity;
        open.lastSeenAt = at;
        open.polls++;
        if (magnitude(open.type, condition.measure) > magnitude(open.type, open.peak)) open.peak = condition.measure;
        changed = true;
      } else if (streak.hits >= config.confirmPolls) {
        const alert = {
          id: crypto.randomUUID(),
          key: condition.key,
          type: condition.type,
          severity: condition.severity,
          venue: condition.venue,
          venueLabel: condition.venueLabel,
          pair: condition.pair,
          status: 'open',
          openedAt: at,
          lastSeenAt: at,
          closedAt: null,
          polls: streak.hits,
          current: condition.measure,
          peak: condition.measure,
          dismissed: false,
        };
        alerts.push(alert);
        changed = true;
        emit('arbitrage:alert', alert);
        notifyOpened(alert);
        arbitrageLogger.info(`ℹ️ Arbitrage ${alert.type} opened: ${alert.venueLabel} ${alert.pair}`, {
          action: 'alert-open', venue: alert.venue, pair: alert.pair, type: alert.type,
        });
      }
    }
    for (const [key, streak] of conditions) {
      if (present.has(key)) continue;
      const venue = key.split(':')[1];
      // A venue that failed to load this poll tells us nothing about its conditions.
      if (!observedVenues.has(venue)) continue;
      streak.hits = 0;
      streak.misses++;
      const open = alerts.find((a) => a.key === key && a.status === 'open');
      if (open && streak.misses >= config.closeAfterPolls) {
        open.status = 'closed';
        open.closedAt = at;
        changed = true;
        notifyClosed(open);
        emit('arbitrage:alert', open);
      }
      if (!open || open.status === 'closed') conditions.delete(key);
    }
    // Episodes left open by a restart, with no streak entry, close the same way.
    for (const open of alerts.filter((a) => a.status === 'open' && !conditions.has(a.key) && observedVenues.has(a.venue))) {
      conditions.set(open.key, { hits: 0, misses: 1 });
    }
    return changed;
  };

  const runPoll = async (generation, allowStopped) => {
    const config = getArbitrageConfig();
    const isCurrent = () => generation === lifecycleGeneration && (running || allowStopped);
    if (!config.enabled || !isCurrent()) return;
    const startedAt = now();
    try {
      await refreshReferenceFx(config);
      const venueIds = VENUE_IDS.filter((id) => config.venues[id]?.enabled);
      const results = await Promise.all(venueIds.map((id) => pollVenue(id, config, isCurrent)));
      if (!isCurrent()) return;

      const venues = {};
      const observed = new Set();
      const found = [];
      for (const result of results) {
        venues[result.id] = result;
        if (!result.ok || !result.analysis) continue;
        observed.add(result.id);
        found.push(...conditionsFor(result, config));
      }
      snapshot = { at: new Date(now()).toISOString(), venues };
      const changed = applyConditions(found, observed, config);
      pollCount++;
      lastPollAt = snapshot.at;
      lastPollDurationMs = now() - startedAt;
      const failed = results.filter((r) => !r.ok);
      if (failed.length) {
        arbitrageLogger.warn(`⚠️ Arbitrage poll: ${failed.length}/${results.length} venues unavailable`, {
          action: 'poll', failed: failed.map((r) => `${r.id}: ${r.error}`),
        });
      }
      if (changed || alerts.some((a) => a.status === 'open') || pollCount % 30 === 1) persistState();
      emit('arbitrage:status', getStatus());
    } catch (err) {
      if (!isCurrent()) return;
      errorCount++;
      arbitrageLogger.error(`❌ Arbitrage poll error: ${err.message}`, { action: 'poll', errorCount, error: err.message });
    }
  };

  /** Coalesce overlapping polls (a slow Kraken read can outlast the interval). */
  const poll = ({ allowStopped = false } = {}) => {
    if (!running && !allowStopped) return activePoll || Promise.resolve();
    if (activePoll) return activePoll;
    const generation = lifecycleGeneration;
    const tracked = runPoll(generation, allowStopped).finally(() => {
      if (activePoll === tracked) activePoll = null;
    });
    activePoll = tracked;
    return tracked;
  };

  const start = () => {
    const config = getArbitrageConfig();
    if (!config.enabled) {
      arbitrageLogger.info('ℹ️ Arbitrage monitor disabled', { action: 'start', enabled: false });
      return;
    }
    if (running) return;
    running = true;
    lifecycleGeneration++;
    pollTimer = setInterval(() => { poll(); }, config.pollIntervalMs);
    initialPollTimeout = setTimeout(() => { poll(); }, 5000);
    arbitrageLogger.info(`ℹ️ Arbitrage monitor started, polling every ${config.pollIntervalMs / 1000}s`, {
      action: 'start', pollIntervalMs: config.pollIntervalMs,
    });
  };

  const stop = () => {
    const wasRunning = running;
    running = false;
    lifecycleGeneration++;
    activePoll = null;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (initialPollTimeout) { clearTimeout(initialPollTimeout); initialPollTimeout = null; }
    persistState();
    if (wasRunning) arbitrageLogger.info('ℹ️ Arbitrage monitor stopped', { action: 'stop' });
  };

  const getStatus = () => {
    const config = getArbitrageConfig();
    return {
      running,
      enabled: config.enabled,
      lastPollAt,
      lastPollDurationMs,
      pollCount,
      errorCount,
      referenceFx: {
        enabled: config.referenceFx.enabled,
        fetchedAt: referenceFx.fetchedAt ? new Date(referenceFx.fetchedAt).toISOString() : null,
        error: referenceFx.error,
        currencies: Object.keys(referenceFx.rates).length,
      },
      venues: VENUE_IDS.map((id) => {
        const v = snapshot.venues[id];
        return {
          id,
          label: v?.label || getSources()[id]?.label || id,
          enabled: Boolean(config.venues[id]?.enabled),
          takerFeeBps: config.venues[id]?.takerFeeBps,
          ok: v ? v.ok : null,
          error: v?.error || null,
          at: v?.at || null,
          durationMs: v?.durationMs ?? null,
          pairs: v?.analysis?.pairs?.length ?? 0,
          failedBooks: v?.failedBooks?.length ?? 0,
        };
      }),
      totalAlerts: alerts.length,
      openAlerts: alerts.filter((a) => a.status === 'open').length,
      openOpportunities: alerts.filter((a) => a.status === 'open' && a.type === 'opportunity').length,
    };
  };

  /** Latest per-venue analysis (pairs + top routes) for the dashboard. */
  const getSnapshot = ({ routesPerVenue = 10 } = {}) => ({
    at: snapshot.at,
    venues: Object.fromEntries(Object.entries(snapshot.venues).map(([id, v]) => [id, {
      id: v.id,
      label: v.label,
      ok: v.ok,
      error: v.error,
      at: v.at,
      failedBooks: v.failedBooks,
      analysis: v.analysis && { ...v.analysis, routes: v.analysis.routes.slice(0, routesPerVenue) },
    }])),
  });

  /**
   * Alerts: open first, then newest-opened first.
   * @param {{ status?: string, type?: string }} [filter]
   */
  const getAlerts = (filter = {}) => alerts
    .filter((a) => (!filter.status || a.status === filter.status) && (!filter.type || a.type === filter.type))
    .sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || Date.parse(b.openedAt) - Date.parse(a.openedAt));

  const dismissAlert = (alertId) => {
    const alert = alerts.find((a) => a.id === alertId);
    if (!alert) return false;
    alert.dismissed = true;
    persistState();
    emit('arbitrage:status', getStatus());
    return true;
  };

  /** Clear closed episodes; open ones keep tracking. */
  const clearAlerts = () => {
    alerts = alerts.filter((a) => a.status === 'open');
    persistState();
    emit('arbitrage:status', getStatus());
  };

  return {
    start,
    stop,
    reloadState: loadState,
    getStatus,
    getSnapshot,
    getAlerts,
    forcePoll: () => poll({ allowStopped: true }),
    dismissAlert,
    clearAlerts,
  };
};

module.exports = { createArbitrageService, STATE_FILE };
