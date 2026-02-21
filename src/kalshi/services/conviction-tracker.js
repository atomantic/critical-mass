/**
 * Conviction Tracker
 * Tracks when markets hit price thresholds (70¢, 80¢, 90¢) and whether
 * the settlement outcome agreed with the crowd. Used to evaluate a
 * "follow the herd" strategy before committing capital.
 *
 * Records per market:
 *  - First time yes price crossed each threshold
 *  - How many minutes into the market's life it crossed
 *  - How many minutes before settlement it crossed
 *  - Whether YES or NO won at settlement
 */

const { readFile, writeFile, mkdir } = require('fs/promises')
const path = require('path')
const { ts } = require('../../time-utils')
const { KALSHI_DATA_DIR } = require('../../paths')

const DATA_DIR = KALSHI_DATA_DIR
const TRACKER_FILE = path.join(DATA_DIR, 'conviction-tracker.json')

/** Thresholds to track (yes price in cents) */
const THRESHOLDS = [65, 70, 75, 80, 85, 90]

/**
 * @typedef {Object} ThresholdCrossing
 * @property {'yes' | 'no'} side - Which side was favored (yes >= threshold means yes favored)
 * @property {number} price - Exact price when threshold was first crossed
 * @property {number} crossedAt - Timestamp of crossing
 * @property {number} minutesIn - Minutes since market opened (approximated from first seen)
 * @property {number} minutesToSettle - Minutes remaining until settlement
 */

/**
 * @typedef {Object} ConvictionRecord
 * @property {string} ticker
 * @property {string} closeTime - ISO string of market close
 * @property {number} firstSeenAt - Timestamp we first saw this market
 * @property {Record<number, ThresholdCrossing>} thresholds - Keyed by threshold value
 * @property {'yes' | 'no' | null} settledSide - Which side won
 * @property {number | null} btcAtSettle - BTC price at settlement
 * @property {number | null} finalYesPrice - Last yes price before settlement
 * @property {boolean} settled
 */

/** @type {Map<string, ConvictionRecord>} Active markets being tracked */
const activeMarkets = new Map()

/** @type {Array<ConvictionRecord>} Completed (settled) records */
let completedRecords = []

/** @type {boolean} */
let loaded = false

/**
 * Load persisted records from disk
 */
const loadRecords = async () => {
  if (loaded) return
  loaded = true
  const raw = await readFile(TRACKER_FILE, 'utf-8').catch(() => '[]')
  completedRecords = JSON.parse(raw)
  console.log(`[${ts()}] 📊 Conviction tracker loaded: ${completedRecords.length} historical records`)
}

/**
 * Persist completed records to disk
 */
const saveRecords = async () => {
  await mkdir(DATA_DIR, { recursive: true }).catch(() => {})
  await writeFile(TRACKER_FILE, JSON.stringify(completedRecords, null, 2))
}

/**
 * Process a price update — check for threshold crossings
 * @param {string} ticker
 * @param {Object} price - { yesBid, yesAsk, lastPrice }
 * @param {Object} marketInfo - { close_time }
 */
const trackPriceUpdate = (ticker, price, marketInfo) => {
  if (!marketInfo?.close_time) return

  const closeTime = new Date(marketInfo.close_time).getTime()
  const now = Date.now()

  // Skip expired markets
  if (now >= closeTime) return

  // Get or create record
  if (!activeMarkets.has(ticker)) {
    activeMarkets.set(ticker, {
      ticker,
      closeTime: marketInfo.close_time,
      firstSeenAt: now,
      thresholds: {},
      settledSide: null,
      btcAtSettle: null,
      finalYesPrice: null,
      settled: false
    })
  }

  const record = activeMarkets.get(ticker)

  // Use best available yes price
  const yesPrice = price.yesBid > 0 && price.yesAsk > 0
    ? Math.round((price.yesBid + price.yesAsk) / 2)
    : price.lastPrice || 0

  if (yesPrice <= 0) return

  record.finalYesPrice = yesPrice

  // Check each threshold
  for (const threshold of THRESHOLDS) {
    // Already recorded this threshold for this market
    if (record.thresholds[threshold]) continue

    const minutesIn = (now - record.firstSeenAt) / 60000
    const minutesToSettle = (closeTime - now) / 60000

    if (yesPrice >= threshold) {
      // YES side is favored at this threshold
      record.thresholds[threshold] = {
        side: 'yes',
        price: yesPrice,
        crossedAt: now,
        minutesIn: Math.round(minutesIn * 10) / 10,
        minutesToSettle: Math.round(minutesToSettle * 10) / 10
      }
    } else if (yesPrice <= (100 - threshold)) {
      // NO side is favored (yes price <= 30 means no is at 70+)
      record.thresholds[threshold] = {
        side: 'no',
        price: yesPrice,
        crossedAt: now,
        minutesIn: Math.round(minutesIn * 10) / 10,
        minutesToSettle: Math.round(minutesToSettle * 10) / 10
      }
    }
  }
}

/**
 * Record settlement outcome for a market
 * @param {string} ticker
 * @param {'yes' | 'no'} winningSide
 * @param {number} btcSpot
 */
const recordSettlement = async (ticker, winningSide, btcSpot) => {
  await loadRecords()

  const record = activeMarkets.get(ticker)
  if (!record) return // We weren't tracking this market

  // Only record if we have at least one threshold crossing
  if (Object.keys(record.thresholds).length === 0) {
    activeMarkets.delete(ticker)
    return
  }

  record.settled = true
  record.settledSide = winningSide
  record.btcAtSettle = btcSpot

  // Log the outcome
  const crossings = Object.entries(record.thresholds)
    .sort(([a], [b]) => Number(b) - Number(a))
  const highest = crossings[0]
  if (highest) {
    const [thresh, crossing] = highest
    const crowdRight = crossing.side === winningSide
    const emoji = crowdRight ? '✅' : '🔄'
    console.log(`[${ts()}] ${emoji} Conviction: ${ticker} hit ${thresh}¢ ${crossing.side.toUpperCase()} @ ${crossing.minutesToSettle.toFixed(0)}min out → settled ${winningSide.toUpperCase()} (crowd ${crowdRight ? 'RIGHT' : 'WRONG'})`)
  }

  completedRecords.push({ ...record })
  activeMarkets.delete(ticker)
  await saveRecords()
}

/**
 * Settle all expired active markets — called from the engine's eval loop
 * so we capture outcomes even for markets we don't hold positions in.
 * @param {Map<string, Object>} marketInfo - Market info map
 * @param {number | null} btcSpot - Current BTC price
 */
const settleExpiredTrackedMarkets = (marketInfo, btcSpot) => {
  if (!btcSpot) return

  const now = Date.now()

  for (const [ticker, record] of activeMarkets) {
    const closeTime = new Date(record.closeTime).getTime()
    if (now < closeTime) continue

    // Determine winning side from ticker
    const segments = ticker.split('-')
    const bracketSeg = segments[segments.length - 1]
    let winningSide = null

    if (bracketSeg.startsWith('B')) {
      const midpoint = parseInt(bracketSeg.slice(1))
      const lowerBound = midpoint - 125
      const upperBound = midpoint + 125
      winningSide = (btcSpot >= lowerBound && btcSpot < upperBound) ? 'yes' : 'no'
    } else if (bracketSeg.startsWith('T')) {
      const threshold = parseFloat(bracketSeg.slice(1))
      winningSide = btcSpot >= threshold ? 'yes' : 'no'
    }

    if (winningSide) {
      recordSettlement(ticker, winningSide, btcSpot).catch(() => {})
    }
  }
}

/**
 * Compute aggregate stats from completed records
 * @returns {Object} Stats by threshold
 */
const getConvictionStats = async () => {
  await loadRecords()

  const stats = {}

  for (const threshold of THRESHOLDS) {
    const withThreshold = completedRecords.filter(r => r.thresholds[threshold])
    const crowdRight = withThreshold.filter(r => r.thresholds[threshold].side === r.settledSide)
    const crowdWrong = withThreshold.filter(r => r.thresholds[threshold].side !== r.settledSide)

    // Break down by time-to-settle when threshold was hit
    const byTimeWindow = {
      early: { total: 0, right: 0 },    // > 10 min before settle
      mid: { total: 0, right: 0 },      // 5-10 min before settle
      late: { total: 0, right: 0 },     // 2-5 min before settle
      final: { total: 0, right: 0 }     // < 2 min before settle
    }

    for (const record of withThreshold) {
      const crossing = record.thresholds[threshold]
      const right = crossing.side === record.settledSide
      const mts = crossing.minutesToSettle

      let window
      if (mts > 10) window = 'early'
      else if (mts > 5) window = 'mid'
      else if (mts > 2) window = 'late'
      else window = 'final'

      byTimeWindow[window].total++
      if (right) byTimeWindow[window].right++
    }

    // Compute win rates per window
    const windowStats = {}
    for (const [window, data] of Object.entries(byTimeWindow)) {
      windowStats[window] = {
        total: data.total,
        right: data.right,
        winRate: data.total > 0 ? Math.round((data.right / data.total) * 1000) / 10 : null
      }
    }

    stats[threshold] = {
      total: withThreshold.length,
      crowdRight: crowdRight.length,
      crowdWrong: crowdWrong.length,
      crowdWinRate: withThreshold.length > 0
        ? Math.round((crowdRight.length / withThreshold.length) * 1000) / 10
        : null,
      byTimeWindow: windowStats
    }
  }

  return {
    totalRecords: completedRecords.length,
    activeMarkets: activeMarkets.size,
    thresholds: stats
  }
}

/**
 * Get raw completed records (for export/analysis)
 * @returns {Promise<Array<ConvictionRecord>>}
 */
const getCompletedRecords = async () => {
  await loadRecords()
  return completedRecords
}

module.exports = {
  trackPriceUpdate,
  recordSettlement,
  settleExpiredTrackedMarkets,
  getConvictionStats,
  getCompletedRecords
}
