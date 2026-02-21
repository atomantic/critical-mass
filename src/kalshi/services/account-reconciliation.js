// @ts-check
/**
 * Account Reconciliation Service
 *
 * Fetches all fills from the Kalshi API (ground truth), compares with local
 * state, and computes corrected P&L for every ticker.  Addresses the problem
 * where adopted positions use estimated cost basis, inflating/deflating P&L.
 */

const { log } = require('../../logger');
const { ts } = require('../../time-utils');

// ---------------------------------------------------------------------------
// API helpers (paginated fetchers)
// ---------------------------------------------------------------------------

/**
 * Fetch ALL fills from the Kalshi API using cursor-based pagination.
 * @param {import('../adapters/api')} api
 * @param {import('../types/kalshi').KalshiKeys} keys
 * @param {Object} [opts]
 * @param {number} [opts.min_ts] - Minimum timestamp (epoch seconds)
 * @returns {Promise<import('../types/kalshi').KalshiFill[]>}
 */
const fetchAllFills = async (api, keys, opts = {}) => {
  const all = [];
  let cursor = null;
  let page = 0;
  do {
    const params = { limit: 100 };
    if (cursor) params.cursor = cursor;
    if (opts.min_ts) params.min_ts = opts.min_ts;
    const res = await api.getFills(keys, params);
    const fills = res?.fills || [];
    all.push(...fills);
    cursor = res?.cursor || null;
    page++;
    log('INFO', `[${ts()}] 🔍 Fetched fills page ${page}: ${fills.length} fills (total ${all.length})`);
  } while (cursor);
  return all;
};

/**
 * Fetch ALL positions from the Kalshi API for a given settlement status.
 * @param {import('../adapters/api')} api
 * @param {import('../types/kalshi').KalshiKeys} keys
 * @param {string} settlementStatus - 'settled', 'unsettled', or 'all'
 * @returns {Promise<import('../types/kalshi').KalshiPosition[]>}
 */
const fetchAllPositions = async (api, keys, settlementStatus) => {
  const all = [];
  let cursor = null;
  let page = 0;
  do {
    const params = { limit: 100, settlement_status: settlementStatus };
    if (cursor) params.cursor = cursor;
    const res = await api.getPositions(keys, params);
    const positions = res?.market_positions || [];
    all.push(...positions);
    cursor = res?.cursor || null;
    page++;
  } while (cursor);
  return all;
};

// ---------------------------------------------------------------------------
// Core reconciliation
// ---------------------------------------------------------------------------

/**
 * Group fills by ticker and compute true cost / proceeds per ticker.
 * @param {import('../types/kalshi').KalshiFill[]} fills
 * @returns {Map<string, {
 *   side: 'yes'|'no',
 *   buys: import('../types/kalshi').KalshiFill[],
 *   sells: import('../types/kalshi').KalshiFill[],
 *   buyCountTotal: number,
 *   sellCountTotal: number,
 *   trueBuyCostCents: number,
 *   trueSellProceedsCents: number,
 *   netContracts: number
 * }>}
 */
const groupFillsByTicker = (fills) => {
  /** @type {Map<string, any>} */
  const map = new Map();

  for (const fill of fills) {
    const ticker = fill.ticker;
    if (!map.has(ticker)) {
      map.set(ticker, {
        side: fill.side,
        buys: [],
        sells: [],
        buyCountTotal: 0,
        sellCountTotal: 0,
        trueBuyCostCents: 0,
        trueSellProceedsCents: 0,
        netContracts: 0,
      });
    }
    const group = map.get(ticker);
    const priceCents = fill.side === 'yes'
      ? (fill.yes_price ?? 0)
      : (fill.no_price ?? 0);

    if (fill.action === 'buy') {
      group.buys.push(fill);
      group.buyCountTotal += fill.count;
      group.trueBuyCostCents += fill.count * priceCents;
    } else if (fill.action === 'sell') {
      group.sells.push(fill);
      group.sellCountTotal += fill.count;
      group.trueSellProceedsCents += fill.count * priceCents;
    }
  }

  // Compute net contracts
  for (const group of map.values()) {
    group.netContracts = group.buyCountTotal - group.sellCountTotal;
  }

  return map;
};

/**
 * Compute the true P&L for a ticker given its fill group and settlement info.
 * @param {Object} group - From groupFillsByTicker
 * @param {Object} [settlement] - { result: 'yes'|'no', realized_pnl?: number }
 * @returns {{ truePnlCents: number, settlementProceedsCents: number, totalProceedsCents: number }}
 */
const computeTickerPnl = (group, settlement) => {
  let settlementProceedsCents = 0;

  if (settlement?.result) {
    // Market settled — did our side win?
    const sideWon = group.side === settlement.result;
    settlementProceedsCents = sideWon ? group.netContracts * 100 : 0;
  }

  const totalProceedsCents = group.trueSellProceedsCents + settlementProceedsCents;
  const truePnlCents = totalProceedsCents - group.trueBuyCostCents;

  return { truePnlCents, settlementProceedsCents, totalProceedsCents };
};

/**
 * Run full account reconciliation.
 * @param {import('../adapters/api')} api
 * @param {import('../types/kalshi').KalshiKeys} keys
 * @param {Object} localState - Current state.json contents
 * @returns {Promise<Object>} Reconciliation report
 */
const reconcile = async (api, keys, localState) => {
  log('INFO', `[${ts()}] 🔄 Starting account reconciliation...`);

  // 1. Fetch current balance (ground truth)
  const balanceRes = await api.getBalance(keys);
  const apiBalanceDollars = (balanceRes?.balance ?? 0) / 100;
  log('INFO', `[${ts()}] 💰 API balance: $${apiBalanceDollars.toFixed(2)}`);

  // 2. Fetch ALL fills
  const allFills = await fetchAllFills(api, keys);
  log('INFO', `[${ts()}] 📋 Total fills from API: ${allFills.length}`);

  // 3. Fetch settled + unsettled positions from API
  const [settledPositions, unsettledPositions] = await Promise.all([
    fetchAllPositions(api, keys, 'settled'),
    fetchAllPositions(api, keys, 'unsettled'),
  ]);
  log('INFO', `[${ts()}] 📋 Settled positions: ${settledPositions.length}, unsettled: ${unsettledPositions.length}`);

  // Build maps of ticker -> position data
  const settledMap = new Map();
  for (const pos of settledPositions) {
    settledMap.set(pos.ticker, pos);
  }
  const unsettledMap = new Map();
  for (const pos of unsettledPositions) {
    unsettledMap.set(pos.ticker, pos);
  }

  // Determine which tickers to reconcile:
  // Only tickers that appear in local state OR have API positions (settled/unsettled).
  // Skip historical fills for tickers we have no local record of and no API position for.
  const localTrades = localState.trades || [];
  const localTickers = new Set(localTrades.map(t => t.ticker));
  const relevantTickers = new Set([
    ...localTickers,
    ...settledMap.keys(),
    ...unsettledMap.keys(),
  ]);

  // Group ALL fills by ticker
  const allFillGroups = groupFillsByTicker(allFills);

  // Filter to only relevant tickers
  const fillGroups = new Map();
  for (const [ticker, group] of allFillGroups) {
    if (relevantTickers.has(ticker)) {
      fillGroups.set(ticker, group);
    }
  }
  log('INFO', `[${ts()}] 🎯 Reconciling ${fillGroups.size} relevant tickers (of ${allFillGroups.size} total)`);

  // 4. Fetch market data for each relevant ticker to get settlement `result`
  const marketResults = new Map();
  for (const ticker of fillGroups.keys()) {
    // Fetch market if it has a settled position, or if local state has a settlement trade for it
    const hasSettledPos = settledMap.has(ticker);
    const hasLocalSettlement = localTrades.some(t => t.ticker === ticker && t.action === 'settlement');
    if (hasSettledPos || hasLocalSettlement) {
      const marketRes = await api.getMarket(keys, ticker);
      const market = marketRes?.market ?? marketRes;
      if (market?.result) {
        marketResults.set(ticker, market.result);
      }
    }
  }

  // 5. Build per-ticker report
  const tickerReports = [];
  let totalLocalPnl = 0;
  let totalCorrectedPnl = 0;
  let tickersCorrected = 0;
  let tickersMatched = 0;
  let externalTrades = 0;

  for (const [ticker, group] of fillGroups) {
    const settledPos = settledMap.get(ticker);
    const marketResult = marketResults.get(ticker);

    // Determine if this ticker is settled:
    // - It's in the settled positions API response, OR
    // - The market result is available (yes/no), OR
    // - We have a local settlement trade for it
    const hasLocalSettlement = localTrades.some(t => t.ticker === ticker && t.action === 'settlement');
    const isSettled = !!settledPos || !!marketResult || hasLocalSettlement;

    // For settled tickers without a market result, try to infer from local settlement
    let effectiveResult = marketResult;
    if (!effectiveResult && hasLocalSettlement) {
      const localSettlement = localTrades.find(t => t.ticker === ticker && t.action === 'settlement');
      if (localSettlement) {
        // If proceeds > 0, the side won; if 0, it lost
        effectiveResult = (localSettlement.proceeds > 0) ? localSettlement.side : (localSettlement.side === 'yes' ? 'no' : 'yes');
      }
    }

    const settlement = isSettled
      ? { result: effectiveResult, realized_pnl: settledPos?.realized_pnl }
      : null;

    const { truePnlCents, settlementProceedsCents } = computeTickerPnl(group, settlement);
    const truePnlDollars = truePnlCents / 100;

    // Find local trades for this ticker
    const localBuys = localTrades.filter(t => t.ticker === ticker && t.action === 'buy');
    const localSettlements = localTrades.filter(t => t.ticker === ticker && t.action === 'settlement');
    const localSells = localTrades.filter(t => t.ticker === ticker && t.action === 'sell');

    const localBuyCount = localBuys.reduce((sum, t) => sum + (t.count || 0), 0);
    const localBuyCostDollars = localBuys.reduce((sum, t) => sum + (t.cost || 0), 0);
    const localPnlDollars = [...localSettlements, ...localSells].reduce((sum, t) => sum + (t.pnl || 0), 0);

    totalLocalPnl += localPnlDollars;
    totalCorrectedPnl += truePnlDollars;

    const correction = truePnlDollars - localPnlDollars;
    const avgBuyPrice = group.buyCountTotal > 0
      ? group.trueBuyCostCents / group.buyCountTotal
      : 0;

    // Determine source: if we have local buys that roughly match, it's 'app'
    const hasLocalBuys = localBuyCount > 0;
    const source = hasLocalBuys ? 'app' : 'external';
    if (!hasLocalBuys && !hasLocalSettlement) externalTrades++;

    const isDiscrepancy = Math.abs(correction) > 0.01;
    if (isDiscrepancy) tickersCorrected++;
    else tickersMatched++;

    tickerReports.push({
      ticker,
      side: group.side,
      apiFills: {
        buyCount: group.buyCountTotal,
        buyCost: parseFloat((group.trueBuyCostCents / 100).toFixed(2)),
        sellCount: group.sellCountTotal,
        sellProceeds: parseFloat((group.trueSellProceedsCents / 100).toFixed(2)),
        avgBuyPrice: parseFloat(avgBuyPrice.toFixed(1)),
      },
      localTrades: {
        buyCount: localBuyCount,
        buyCost: parseFloat(localBuyCostDollars.toFixed(2)),
      },
      isSettled,
      settlementResult: effectiveResult || null,
      settlementProceeds: parseFloat((settlementProceedsCents / 100).toFixed(2)),
      truePnl: parseFloat(truePnlDollars.toFixed(2)),
      localPnl: parseFloat(localPnlDollars.toFixed(2)),
      correction: parseFloat(correction.toFixed(2)),
      apiRealizedPnl: settledPos ? parseFloat((settledPos.realized_pnl / 100).toFixed(2)) : null,
      source,
      fills: group.buys.concat(group.sells).map(f => ({
        trade_id: f.trade_id,
        action: f.action,
        side: f.side,
        count: f.count,
        yes_price: f.yes_price,
        no_price: f.no_price,
        created_time: f.created_time,
      })),
    });
  }

  const totalAdjustment = totalCorrectedPnl - totalLocalPnl;

  const report = {
    timestamp: new Date().toISOString(),
    apiBalance: { available: parseFloat(apiBalanceDollars.toFixed(2)) },
    localBalance: {
      available: localState.balance?.available ?? 0,
      inPositions: localState.balance?.inPositions ?? 0,
    },
    fillsFromApi: allFills.length,
    settledPositions: settledPositions.length,
    tickers: tickerReports,
    summary: {
      totalLocalPnl: parseFloat(totalLocalPnl.toFixed(2)),
      totalCorrectedPnl: parseFloat(totalCorrectedPnl.toFixed(2)),
      totalAdjustment: parseFloat(totalAdjustment.toFixed(2)),
      tickersCorrected,
      tickersMatched,
      externalTrades,
    },
  };

  log('INFO', `[${ts()}] ✅ Reconciliation complete: ${tickersCorrected} corrected, ${tickersMatched} matched, adjustment=$${totalAdjustment.toFixed(2)}`);
  return report;
};

// ---------------------------------------------------------------------------
// Apply corrections
// ---------------------------------------------------------------------------

/**
 * Apply reconciliation corrections to local state.
 * @param {Object} state - Current state.json (will be mutated)
 * @param {Object} report - Report from reconcile()
 * @returns {Object} The corrected state
 */
const applyCorrections = (state, report) => {
  log('INFO', `[${ts()}] 🔧 Applying ${report.summary.tickersCorrected} corrections to state...`);

  const now = new Date().toISOString();
  const newTrades = [];

  // Identify which tickers exist in local state (only correct those)
  const localTickerSet = new Set((state.trades || []).map(t => t.ticker));

  // Only apply corrections for tickers that are in local state
  // External tickers (from API settled positions not in local state) are report-only
  const tickersToCorrect = report.tickers.filter(t => localTickerSet.has(t.ticker));
  const correctedTickerSet = new Set(tickersToCorrect.map(t => t.ticker));

  const skippedExternal = report.tickers.length - tickersToCorrect.length;
  if (skippedExternal > 0) {
    log('INFO', `[${ts()}] ⏭️ Skipping ${skippedExternal} external tickers not in local state`);
  }

  // Keep trades for tickers NOT being corrected (unaffected)
  const unaffectedTrades = (state.trades || []).filter(t => !correctedTickerSet.has(t.ticker));
  newTrades.push(...unaffectedTrades);

  // Build a map of ticker -> original settlement timestamp from local state
  const localSettlementTimestamps = new Map();
  for (const t of (state.trades || [])) {
    if (t.action === 'settlement' && t.ticker && t.timestamp) {
      localSettlementTimestamps.set(t.ticker, t.timestamp);
    }
  }

  // For each local ticker in the report, rebuild trades from API fills
  for (const tickerReport of tickersToCorrect) {
    const { ticker, side, apiFills, isSettled, settlementResult, truePnl, fills } = tickerReport;

    // Create buy trades from actual fills
    for (const fill of fills.filter(f => f.action === 'buy')) {
      const priceCents = side === 'yes' ? (fill.yes_price ?? 0) : (fill.no_price ?? 0);
      newTrades.push({
        id: `reconciled-buy-${fill.trade_id}`,
        ticker,
        side,
        action: 'buy',
        count: fill.count,
        price: priceCents,
        cost: parseFloat(((fill.count * priceCents) / 100).toFixed(2)),
        fee: 0, // Fee data not available per-fill from API
        costBasis: null,
        proceeds: null,
        pnl: null,
        strategy: 'reconciled',
        timestamp: fill.created_time,
        source: 'api-reconciliation',
      });
    }

    // Create sell trades from actual fills
    for (const fill of fills.filter(f => f.action === 'sell')) {
      const priceCents = side === 'yes' ? (fill.yes_price ?? 0) : (fill.no_price ?? 0);
      const sellProceeds = parseFloat(((fill.count * priceCents) / 100).toFixed(2));
      newTrades.push({
        id: `reconciled-sell-${fill.trade_id}`,
        ticker,
        side,
        action: 'sell',
        count: fill.count,
        price: priceCents,
        cost: 0,
        fee: 0,
        costBasis: null,
        proceeds: sellProceeds,
        pnl: null, // P&L attributed at settlement level
        strategy: 'reconciled',
        timestamp: fill.created_time,
        source: 'api-reconciliation',
      });
    }

    // Create settlement record if settled
    if (isSettled) {
      const totalBuyCostDollars = apiFills.buyCost;
      const totalSellProceedsDollars = apiFills.sellProceeds ?? 0;
      const netContracts = apiFills.buyCount - apiFills.sellCount;
      const sideWon = side === settlementResult;
      const settlementProceedsDollars = sideWon ? netContracts : 0;
      const totalProceedsDollars = totalSellProceedsDollars + settlementProceedsDollars;

      // Derive settlement timestamp from the last fill time (most accurate),
      // falling back to local state, then now
      const lastFillTime = fills.length > 0
        ? fills.reduce((latest, f) =>
          f.created_time > latest ? f.created_time : latest, fills[0].created_time)
        : null;
      const settlementTs = lastFillTime || localSettlementTimestamps.get(ticker) || now;

      newTrades.push({
        id: `reconciled-settlement-${ticker}`,
        ticker,
        side,
        action: 'settlement',
        count: netContracts,
        price: sideWon ? 100 : 0,
        cost: totalBuyCostDollars,
        fee: 0,
        costBasis: totalBuyCostDollars,
        proceeds: totalProceedsDollars,
        pnl: truePnl,
        strategy: 'reconciled',
        timestamp: settlementTs,
        source: 'api-reconciliation',
      });
    }
  }

  // Sort trades by timestamp
  newTrades.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  // Recalculate todayStats from scratch
  const todayStr = new Date().toISOString().slice(0, 10);
  const todaySettlementsAndSells = newTrades.filter(t =>
    (t.action === 'settlement' || t.action === 'sell') &&
    t.pnl != null &&
    t.timestamp?.slice(0, 10) === todayStr
  );

  const todayPnl = todaySettlementsAndSells.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const todayWins = todaySettlementsAndSells.filter(t => (t.pnl || 0) > 0).length;
  const todayTrades = todaySettlementsAndSells.length;

  state.trades = newTrades;
  state.todayStats = {
    trades: todayTrades,
    wins: todayWins,
    pnl: parseFloat(todayPnl.toFixed(2)),
    fees: 0, // Fee totals not available from fill data
  };
  state.balance = {
    available: report.apiBalance.available,
    inPositions: 0, // Will be recalculated by engine from live positions
  };
  state.lastUpdated = now;

  log('INFO', `[${ts()}] ✅ State corrected: ${newTrades.length} trades, P&L=$${todayPnl.toFixed(2)}, balance=$${report.apiBalance.available.toFixed(2)}`);
  return state;
};

module.exports = {
  fetchAllFills,
  fetchAllPositions,
  groupFillsByTicker,
  computeTickerPnl,
  reconcile,
  applyCorrections,
};
