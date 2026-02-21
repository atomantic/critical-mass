/**
 * Snapshot Writer
 *
 * Appends one JSONL line per eval cycle to data/kalshi/snapshots/YYYY-MM-DD.jsonl
 * for future backtesting. ~8MB/day uncompressed at 5s intervals.
 */

const { appendFile, mkdir } = require('fs/promises')
const { existsSync } = require('fs')
const path = require('path')

const ts = () => new Date().toISOString().slice(11, 23)

/** Resolve snapshot directory relative to project root */
const SNAPSHOT_DIR = path.join(__dirname, '..', '..', '..', 'data', 'kalshi', 'snapshots')

/** Track last write to avoid hammering disk on rapid eval cycles */
let lastWriteTs = 0
const MIN_WRITE_INTERVAL_MS = 4000

/**
 * Write a snapshot line for the current eval cycle.
 * Called from simulation-engine after building context.
 *
 * @param {Object} context - Strategy evaluation context
 * @param {Object} bracketAnalytics - Cross-market bracket analytics
 * @param {Array<Object>} signals - Signals generated this cycle
 */
const writeSnapshot = async (context, bracketAnalytics, signals) => {
  const now = Date.now()
  if (now - lastWriteTs < MIN_WRITE_INTERVAL_MS) return
  lastWriteTs = now

  const btcSpot = context.compositePrices?.get('BTC-USD')?.price
    ?? context.coinbasePrices?.get('BTC-USD')
  if (!btcSpot) return // No spot price, nothing useful to record

  // Build compact snapshot
  const kalshiPrices = {}
  for (const [ticker, pd] of context.prices) {
    kalshiPrices[ticker] = {
      yb: pd.yesBid ?? 0,
      ya: pd.yesAsk ?? 0,
      lp: pd.lastPrice ?? 0
    }
  }

  // Coinbase/composite bid/ask spread
  const composite = context.compositePrices?.get('BTC-USD')
  const cbSpread = composite?.bid && composite?.ask ? { b: composite.bid, a: composite.ask } : null

  // Kalshi orderbook depth for tickers with data
  const book = {}
  if (context.kalshiBookMetrics?.size) {
    for (const [ticker, m] of context.kalshiBookMetrics) {
      book[ticker] = { yd: m.yesDepth5 ?? 0, nd: m.noDepth5 ?? 0, sp: m.yesSpread ?? 0 }
    }
  }

  const snapshot = {
    ts: new Date().toISOString(),
    btcSpot,
    kalshiPrices,
    bracketAnalytics: serializeBracketAnalytics(bracketAnalytics),
    book: Object.keys(book).length > 0 ? book : undefined,
    cbSpread: cbSpread || undefined,
    signals: signals.map(s => ({
      t: s.ticker,
      a: s.action,
      s: s.side,
      p: s.price,
      c: s.confidence,
      st: s.metadata?.strategy
    }))
  }

  const dateStr = new Date().toISOString().slice(0, 10)
  const filePath = path.join(SNAPSHOT_DIR, `${dateStr}.jsonl`)

  if (!existsSync(SNAPSHOT_DIR)) {
    await mkdir(SNAPSHOT_DIR, { recursive: true })
  }

  const line = JSON.stringify(snapshot) + '\n'
  await appendFile(filePath, line).catch(err =>
    console.log(`[${ts()}] ⚠️ Snapshot write failed: ${err.message}`)
  )
}

/**
 * Compact serialization of bracket analytics for snapshots
 */
const serializeBracketAnalytics = (analytics) => {
  if (!analytics?.groups?.size) return null

  const groups = []
  for (const [closeTime, group] of analytics.groups) {
    if (!group.bracketSum?.pricedCount) continue
    const entry = {
      ct: closeTime,
      sum: group.bracketSum.mid,
      iv: group.impliedVol?.sigma ?? null,
      ivR: group.impliedVol?.reliable ?? false,
      ttl: Math.round(group.secondsToSettlement ?? 0)
    }

    // Add per-bracket fair value data from byTicker
    if (analytics.byTicker?.size && group.brackets?.length) {
      const bk = []
      for (const b of group.brackets) {
        const td = analytics.byTicker.get(b.ticker)
        if (!td) continue
        bk.push({
          t: b.ticker,
          mp: td.modelProb != null ? Math.round(td.modelProb * 10000) / 10000 : null,
          kp: b.marketProb != null ? Math.round(b.marketProb * 10000) / 10000 : null,
          si: td.spotInBracket ? 1 : 0
        })
      }
      if (bk.length > 0) entry.bk = bk
    }

    groups.push(entry)
  }
  return groups.length > 0 ? groups : null
}

module.exports = { writeSnapshot }
