/**
 * Decision Journal Writer
 *
 * Appends structured JSONL records to data/kalshi/journals/YYYY-MM-DD.jsonl
 * capturing every decision point: entries, exits, settlements, skips,
 * rejections, and session summaries. Optimized for post-session AI review.
 */

const { appendFile, mkdir, readFile } = require('fs/promises')
const { existsSync } = require('fs')
const path = require('path')
const { ts } = require('../../time-utils')
const { KALSHI_DATA_DIR } = require('../../paths')

const JOURNAL_DIR = path.join(KALSHI_DATA_DIR, 'journals')

/** @type {Map<string, number>} ticker:strategy -> last skip write timestamp */
const skipThrottles = new Map()
const SKIP_THROTTLE_MS = 15000

/** @type {Map<string, number>} reason+ticker -> last reject write timestamp */
const rejectThrottles = new Map()
const REJECT_THROTTLE_MS = 30000

/**
 * Resolve the journal file path for a given date
 * @param {string} [date] - ISO date string (YYYY-MM-DD), defaults to today
 * @returns {string}
 */
const getJournalPath = (date) => {
  const dateStr = date || new Date().toISOString().slice(0, 10)
  return path.join(JOURNAL_DIR, `${dateStr}.jsonl`)
}

/**
 * Append a single JSONL record (fire-and-forget)
 * @param {Object} record
 */
const appendRecord = async (record) => {
  if (!existsSync(JOURNAL_DIR)) {
    await mkdir(JOURNAL_DIR, { recursive: true })
  }
  const line = JSON.stringify(record) + '\n'
  await appendFile(getJournalPath(), line)
}

/**
 * Record a successful entry (buy)
 * @param {Object} trade - Trade record from engine
 * @param {Object} signal - Original signal with metadata
 */
const writeEntry = (trade, signal) => {
  const meta = signal.metadata || {}
  appendRecord({
    type: 'entry',
    ts: new Date().toISOString(),
    ticker: trade.ticker,
    side: trade.side,
    contracts: trade.count,
    price: trade.price,
    cost: trade.cost,
    fee: trade.fee,
    strategy: trade.strategy,
    reason: trade.reason || signal.reason,
    edge: meta.edge ?? null,
    fairProb: meta.fairProb ?? null,
    marketProb: meta.marketProb ?? null,
    vol: meta.vol ?? null,
    sigma: meta.sigma ?? null,
    ttl: meta.ttl ?? null,
    btcSpot: meta.btcSpot ?? null,
    momentum: meta.momentum ?? null,
    confidence: signal.confidence ?? null,
    bookImbalance: meta.bookImbalance ?? null,
    mispricing: meta.mispricing ?? null,
    updownType: meta.updownType ?? null,
    updownScore: meta.updownScore ?? null,
    updownConfidence: meta.updownConfidence ?? null,
    updownTrendBias: meta.updownTrendBias ?? null
  }).catch(() => {})
}

/**
 * Record a successful exit (sell)
 * @param {Object} trade - Trade record from engine
 * @param {Object} signal - Original signal with metadata
 * @param {Object} position - Position being exited
 */
const writeExit = (trade, signal, position) => {
  const meta = signal.metadata || {}
  appendRecord({
    type: 'exit',
    ts: new Date().toISOString(),
    ticker: trade.ticker,
    side: trade.side,
    contracts: trade.count,
    price: trade.price,
    proceeds: trade.proceeds,
    costBasis: trade.costBasis,
    pnl: trade.pnl,
    fee: trade.fee,
    strategy: trade.strategy,
    exitReason: signal.reason || trade.reason,
    btcSpot: meta.btcSpot ?? null,
    avgCost: position?.avgCost ?? null,
    exitFairProb: meta.exitFairProb ?? null,
    exitMarketProb: meta.exitMarketProb ?? null,
    exitEdge: meta.exitEdge ?? null,
    holdDuration: meta.holdDuration ?? null
  }).catch(() => {})
}

/**
 * Record a settlement outcome
 * @param {Object} trade - Settlement trade record
 * @param {number} btcSpot - BTC spot price at settlement
 * @param {string} winningSide - 'yes' or 'no'
 */
const writeSettlement = (trade, btcSpot, winningSide) => {
  appendRecord({
    type: 'settlement',
    ts: new Date().toISOString(),
    ticker: trade.ticker,
    side: trade.side,
    contracts: trade.count,
    costBasis: trade.costBasis,
    proceeds: trade.proceeds,
    pnl: trade.pnl,
    won: trade.pnl > 0,
    winningSide,
    btcSpot,
    strategy: trade.strategy,
    entryEdge: trade.entryEdge ?? null,
    entrySigma: trade.entrySigma ?? null,
    entryFairProb: trade.entryFairProb ?? null,
    entryMarketProb: trade.entryMarketProb ?? null,
    entryBtcSpot: trade.entryBtcSpot ?? null
  }).catch(() => {})
}

/**
 * Record skipped opportunities from strategy diagnostics.
 * Throttled: max once per ticker:strategy pair per 15s.
 * @param {Array<Object>} diagnostics - Strategy diagnostics array
 * @param {string} strategyName
 * @param {number} btcSpot
 */
const writeSkips = (diagnostics, strategyName, btcSpot) => {
  if (!diagnostics?.length) return
  const now = Date.now()

  for (const d of diagnostics) {
    const throttleKey = `${d.ticker}:${strategyName}`
    const lastWrite = skipThrottles.get(throttleKey)
    if (lastWrite && now - lastWrite < SKIP_THROTTLE_MS) continue
    skipThrottles.set(throttleKey, now)

    appendRecord({
      type: 'skip',
      ts: new Date().toISOString(),
      ticker: d.ticker,
      strategy: strategyName,
      status: d.status || null,
      edge: d.edge ?? null,
      fairProb: d.fairProb ?? null,
      marketProb: d.marketProb ?? null,
      vol: d.vol ?? null,
      ttl: d.ttl ?? null,
      window: d.window ?? null,
      btcSpot: btcSpot ?? null,
      strike: d.strike ?? null,
      sigmaSource: d.sigmaSource ?? null
    }).catch(() => {})
  }
}

/**
 * Record a signal rejected by engine limits.
 * Throttled: same reason+ticker max once per 30s.
 * @param {Object} signal
 * @param {string} reason
 * @param {Object} engineState - Partial engine state for context
 */
const writeReject = (signal, reason, engineState) => {
  const key = `${signal.ticker}:${reason}`
  const now = Date.now()
  const lastWrite = rejectThrottles.get(key)
  if (lastWrite && now - lastWrite < REJECT_THROTTLE_MS) return
  rejectThrottles.set(key, now)

  appendRecord({
    type: 'reject',
    ts: new Date().toISOString(),
    ticker: signal.ticker,
    side: signal.side,
    action: signal.action,
    contracts: signal.count,
    confidence: signal.confidence ?? null,
    reason,
    strategy: signal.metadata?.strategy || engineState?.strategy || null,
    positions: engineState?.positionCount ?? null,
    maxPositions: engineState?.maxPositions ?? null
  }).catch(() => {})
}

/**
 * Record a session summary on engine stop
 * @param {Object} state - Engine state
 */
const writeSessionSummary = (state) => {
  if (!state) return

  const trades = state.trades || []
  const wins = trades.filter(t => t.pnl > 0).length
  const losses = trades.filter(t => t.pnl < 0).length
  const totalPnl = trades.reduce((sum, t) => sum + (t.pnl || 0), 0)
  const totalFees = trades.reduce((sum, t) => sum + (t.fee || 0), 0)

  const byStrategy = {}
  for (const trade of trades) {
    const key = trade.strategy || 'unknown'
    if (!byStrategy[key]) byStrategy[key] = { trades: 0, wins: 0, losses: 0, pnl: 0, fees: 0 }
    byStrategy[key].trades++
    if (trade.pnl > 0) byStrategy[key].wins++
    if (trade.pnl < 0) byStrategy[key].losses++
    byStrategy[key].pnl += trade.pnl || 0
    byStrategy[key].fees += trade.fee || 0
  }

  appendRecord({
    type: 'session',
    ts: new Date().toISOString(),
    trades: trades.length,
    wins,
    losses,
    pnl: Math.round(totalPnl * 100) / 100,
    fees: Math.round(totalFees * 100) / 100,
    winRate: trades.length > 0 ? Math.round((wins / trades.length) * 1000) / 10 : 0,
    balance: state.balance?.available ?? null,
    positions: state.positions?.length ?? 0,
    byStrategy
  }).catch(() => {})
}

/**
 * Record a shadow entry (paper-trade buy from disabled strategy)
 * @param {Object} trade - Trade record from shadow engine
 * @param {Object} signal - Original signal with metadata
 */
const writeShadowEntry = (trade, signal) => {
  const meta = signal.metadata || {}
  appendRecord({
    type: 'shadow-entry',
    ts: new Date().toISOString(),
    ticker: trade.ticker,
    side: trade.side,
    contracts: trade.count,
    price: trade.price,
    cost: trade.cost,
    fee: trade.fee,
    strategy: trade.strategy,
    reason: trade.reason || signal.reason,
    confidence: signal.confidence ?? null,
    btcSpot: meta.btcSpot ?? null,
    momentum: meta.momentum ?? null,
    spotDeltaPct: meta.spotDeltaPct ?? null
  }).catch(() => {})
}

/**
 * Record a shadow exit (paper-trade sell before settlement)
 * @param {Object} trade - Trade record from shadow engine
 * @param {Object} signal - Original signal with metadata
 * @param {Object} position - Shadow position being exited
 */
const writeShadowExit = (trade, signal, position) => {
  appendRecord({
    type: 'shadow-exit',
    ts: new Date().toISOString(),
    ticker: trade.ticker,
    side: trade.side,
    contracts: trade.count,
    price: trade.price,
    proceeds: trade.proceeds,
    costBasis: trade.costBasis,
    pnl: trade.pnl,
    fee: trade.fee,
    strategy: trade.strategy,
    exitReason: signal.reason || trade.reason,
    btcSpot: signal.metadata?.btcSpot ?? null,
    avgCost: position?.avgCost ?? null
  }).catch(() => {})
}

/**
 * Record a shadow settlement outcome
 * @param {Object} trade - Settlement trade record
 * @param {number} btcSpot - BTC spot price at settlement
 * @param {string} winningSide - 'yes' or 'no'
 */
const writeShadowSettlement = (trade, btcSpot, winningSide) => {
  appendRecord({
    type: 'shadow-settlement',
    ts: new Date().toISOString(),
    ticker: trade.ticker,
    side: trade.side,
    contracts: trade.count,
    costBasis: trade.costBasis,
    proceeds: trade.proceeds,
    pnl: trade.pnl,
    won: trade.pnl > 0,
    winningSide,
    btcSpot,
    strategy: trade.strategy
  }).catch(() => {})
}

/**
 * Record a window summary for a completed settlement window
 * @param {Object} summary - Window summary object
 */
const writeWindowSummary = (summary) => {
  // Include per-bracket details for post-session analysis
  const brackets = summary.brackets?.map(b => ({
    ticker: b.ticker,
    strike: b.strike ?? b.lower ?? null,
    lastYes: b.lastYes ?? b.marketPrice ?? null,
    won: b.won ?? null
  })) ?? null

  appendRecord({
    type: 'window-summary',
    ts: new Date().toISOString(),
    closeTime: summary.closeTime,
    btcSpot: summary.btcSpot,
    winningBracket: summary.winningBracket,
    bestEdge: summary.bestEdge,
    ourAction: summary.ourAction,
    noActionReason: summary.noActionReason ?? null,
    marketsEvaluated: summary.marketsEvaluated,
    marketsWithPrices: summary.marketsWithPrices,
    bracketCount: summary.brackets?.length ?? 0,
    brackets,
    sigmaCalibration: summary.sigmaCalibration ?? null
  }).catch(() => {})
}

/**
 * Read and parse a day's journal into categorized arrays
 * @param {string} [date] - ISO date string (YYYY-MM-DD), defaults to today
 * @returns {Promise<{entries: Array, exits: Array, settlements: Array, skips: Array, rejects: Array, sessions: Array, shadowEntries: Array, shadowSettlements: Array}>}
 */
const readJournal = async (date) => {
  const filePath = getJournalPath(date)
  const result = { entries: [], exits: [], settlements: [], skips: [], rejects: [], sessions: [], shadowEntries: [], shadowExits: [], shadowSettlements: [], windowSummaries: [] }

  if (!existsSync(filePath)) return result

  const content = await readFile(filePath, 'utf-8')
  const lines = content.trim().split('\n').filter(Boolean)

  for (const line of lines) {
    const record = JSON.parse(line)
    switch (record.type) {
      case 'entry': result.entries.push(record); break
      case 'exit': result.exits.push(record); break
      case 'settlement': result.settlements.push(record); break
      case 'skip': result.skips.push(record); break
      case 'reject': result.rejects.push(record); break
      case 'session': result.sessions.push(record); break
      case 'shadow-entry': result.shadowEntries.push(record); break
      case 'shadow-exit': result.shadowExits.push(record); break
      case 'shadow-settlement': result.shadowSettlements.push(record); break
      case 'window-summary': result.windowSummaries.push(record); break
    }
  }

  return result
}

module.exports = {
  writeEntry,
  writeExit,
  writeSettlement,
  writeSkips,
  writeReject,
  writeSessionSummary,
  writeShadowEntry,
  writeShadowExit,
  writeShadowSettlement,
  writeWindowSummary,
  readJournal,
  getJournalPath
}
