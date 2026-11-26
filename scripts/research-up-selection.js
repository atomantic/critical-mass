#!/usr/bin/env node
// @ts-check
/**
 * Research: when does the operator choose to trade, and which rule entries end
 * in floor knock-outs? Read-only; prints a JSON report (optionally --out FILE).
 *
 *   node scripts/research-up-selection.js --candles btc-usd-1m.json --orders order-history.jsonl
 *
 * 1. Extended per-minute features (MA distance/slope on 1m..1d, drawdowns,
 *    realized vol, RSI, calendar, days to expiry, floor distance in 24h-vol units).
 * 2. Groups: the operator's 51 entries; stateless rule ENTER signals (first per
 *    hour), each traded standalone to a win / floor knock-out / other loss; random minutes.
 * 3. AUC per feature for (a) operator vs rule and (b) rule winners vs knock-outs,
 *    computed on train (Feb 15 – Apr 30) and test (May 1 – Nov 16) separately.
 * 4. A small threshold filter fit on train only, evaluated on test with the
 *    sequential simulator; floor-offset and momentum-fade exit variants; threshold sensitivity.
 */
const fs = require('fs')
const { UP_DIP_PARAMS, decideUpDip, markPosition, pickContract, nextExpiryMs } = require('../src/updown/up-dip-setup')
const { settlementProceeds, parseOrderHistory, deriveCycles } = require('../src/updown/app-order-history')
const { entryCost, exitProceeds } = require('../src/updown/app-pricing')
const { buildFeatures, simulate, summarize, parseSpread } = require('./backtest-up-dip')

const MIN = 60_000
const DAY = 86_400_000
const TFS = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '1d': 1440 }
const MAS = [20, 50, 200]
const SLOPE_BARS = 5
const r3 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 1000) / 1000)

/** Column-store of extended features, causal at each 1m close. */
function buildExtended(candles) {
  const n = candles.length
  const cols = {}
  const col = (name) => (cols[name] ??= new Float64Array(n).fill(NaN))
  // MA distance and slope per timeframe.
  for (const [tf, mins] of Object.entries(TFS)) {
    const closes = []
    const smaHist = Object.fromEntries(MAS.map(p => [p, []]))
    const sums = Object.fromEntries(MAS.map(p => [p, 0]))
    let cur = null
    let gains = 0, losses = 0, rsiN = 0, prevClose = null, rsi = NaN
    const dist = MAS.map(p => col(`d${p}_${tf}`)), slope = MAS.map(p => col(`s${p}_${tf}`))
    const rsiCol = ['5m', '15m', '1h'].includes(tf) ? col(`rsi_${tf}`) : null
    for (let i = 0; i < n; i++) {
      const c = candles[i]
      const bucket = Math.floor(c.timestamp / (mins * MIN))
      cur = cur && cur.b === bucket ? { b: bucket, close: c.close } : { b: bucket, close: c.close }
      // Completed when the next minute starts a new bucket (or the series gap jumps).
      const next = candles[i + 1]
      const completed = !next || Math.floor(next.timestamp / (mins * MIN)) !== bucket
      if (completed) {
        closes.push(cur.close)
        for (const p of MAS) {
          sums[p] += cur.close
          if (closes.length > p) sums[p] -= closes[closes.length - 1 - p]
          smaHist[p].push(closes.length >= p ? sums[p] / p : NaN)
          if (smaHist[p].length > SLOPE_BARS + 1) smaHist[p].shift()
        }
        if (prevClose != null) {
          const d = cur.close - prevClose
          if (rsiN < 14) { gains += Math.max(d, 0); losses += Math.max(-d, 0); rsiN++; if (rsiN === 14) { gains /= 14; losses /= 14 } }
          else { gains = (gains * 13 + Math.max(d, 0)) / 14; losses = (losses * 13 + Math.max(-d, 0)) / 14 }
          if (rsiN >= 14) rsi = losses === 0 ? 100 : 100 - 100 / (1 + gains / losses)
        }
        prevClose = cur.close
        if (closes.length > 400) closes.splice(0, closes.length - 400)
      }
      MAS.forEach((p, k) => {
        const h = smaHist[p]
        const last = h[h.length - 1]
        if (Number.isFinite(last)) dist[k][i] = (c.close - last) / last * 100
        if (h.length > SLOPE_BARS && Number.isFinite(h[0]) && Number.isFinite(last)) slope[k][i] = (last - h[0]) / h[0] * 100
      })
      if (rsiCol) rsiCol[i] = rsi
    }
  }
  // Drawdown from rolling highs (monotonic deque) and realized volatility.
  for (const [name, w] of [['dd1h', 60], ['dd4h', 240], ['dd24h', 1440]]) {
    const out = col(name), dq = []
    for (let i = 0; i < n; i++) {
      while (dq.length && candles[dq[dq.length - 1]].high <= candles[i].high) dq.pop()
      dq.push(i)
      while (dq[0] <= i - w) dq.shift()
      const hi = candles[dq[0]].high
      out[i] = (hi - candles[i].close) / hi * 100
    }
  }
  for (const [name, w] of [['vol1h', 60], ['vol24h', 1440]]) {
    const out = col(name)
    let s = 0, s2 = 0
    const r = new Float64Array(n)
    for (let i = 1; i < n; i++) {
      r[i] = Math.log(candles[i].close / candles[i - 1].close) * 100
      s += r[i]; s2 += r[i] * r[i]
      if (i > w) { s -= r[i - w]; s2 -= r[i - w] * r[i - w] }
      if (i >= w) out[i] = Math.sqrt(Math.max(0, s2 / w - (s / w) ** 2))
    }
  }
  const dow = col('dow'), hour = col('hourUtc'), dte = col('daysToExpiry')
  for (let i = 0; i < n; i++) {
    const now = candles[i].timestamp + MIN
    const d = new Date(now)
    dow[i] = d.getUTCDay(); hour[i] = d.getUTCHours()
    dte[i] = (nextExpiryMs(now) - now) / DAY
  }
  return cols
}

/** Row of features at index i for a given floor. */
function rowAt(cols, candles, i, floor, range = 2000) {
  const row = {}
  for (const [k, v] of Object.entries(cols)) row[k] = v[i]
  const price = candles[i].close
  const daySigmaUsd = price * (row.vol24h / 100) * Math.sqrt(1440)
  row.posInRange = (price - floor) / range
  row.floorDistVol = daySigmaUsd > 0 ? (price - floor) / daySigmaUsd : NaN
  return row
}

/** P(a > b) over all pairs (Mann-Whitney AUC), NaNs dropped. */
function auc(a, b) {
  const A = a.filter(Number.isFinite), B = b.filter(Number.isFinite)
  if (!A.length || !B.length) return null
  const all = [...A.map(v => [v, 0]), ...B.map(v => [v, 1])].sort((x, y) => x[0] - y[0])
  let rankSumA = 0
  for (let i = 0; i < all.length;) {
    let j = i
    while (j < all.length && all[j][0] === all[i][0]) j++
    const avg = (i + j + 1) / 2
    for (let k = i; k < j; k++) if (all[k][1] === 0) rankSumA += avg
    i = j
  }
  return (rankSumA - A.length * (A.length + 1) / 2) / (A.length * B.length)
}
const median = (arr) => { const s = arr.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null }

/** Trade one contract from a signal at bar i (fill i+1 open) to its exit, KO or expiry. */
function standalone(candles, features, i, params, halfSpread) {
  const fillBar = candles[i + 1]
  if (!fillBar) return null
  const contract = pickContract(candles[i].close, candles[i].timestamp + MIN, params)
  const px = fillBar.open
  if (px <= contract.floor || px + halfSpread >= contract.ceiling) return null
  const pos = { contract, contracts: 1, cost: entryCost(px, contract, halfSpread), lastFillPrice: px, openedAt: fillBar.timestamp }
  for (let j = i + 1; j < candles.length; j++) {
    const c = candles[j], now = c.timestamp + MIN
    if (c.low <= contract.floor) return { outcome: 'ko', pnl: -pos.cost, closedAt: now }
    if (c.high >= contract.ceiling) return { outcome: 'win', pnl: settlementProceeds(contract.ceiling, contract) - pos.cost, closedAt: now }
    if (now >= contract.expiry) { const pnl = settlementProceeds(c.close, contract) - pos.cost; return { outcome: pnl > 0 ? 'win' : 'loss', pnl, closedAt: now } }
    const d = decideUpDip({ features: features[j], position: pos, now, halfSpread, params })
    if (d.action === 'EXIT' && candles[j + 1]) {
      const pnl = exitProceeds(candles[j + 1].open, contract, halfSpread) - pos.cost
      return { outcome: pnl > 0 ? 'win' : 'loss', pnl, closedAt: candles[j + 1].timestamp }
    }
  }
  return null
}

/** Decision wrapper: entry filter, optional momentum-fade exit. */
const makeDecide = ({ filter = null, cols = null, fadeExit = false } = {}) => (input, i) => {
  const d = decideUpDip(input)
  if (d.action === 'ENTER' && filter && !filter.every(([k, op, t]) => {
    // Rule floors sit floorOffset below price, so floor distance in 24h-vol units follows from vol24h.
    const v = k === 'floorDistVol' ? input.params.floorOffset / (input.features.price * cols.vol24h[i] / 100 * Math.sqrt(1440)) : cols[k][i]
    return Number.isFinite(v) && (op === '<=' ? v <= t : v >= t)
  })) return { action: 'STAND_ASIDE', reasons: ['filtered'] }
  if (fadeExit && input.position && input.features) {
    const m = markPosition(input.position, input.features.price, input.halfSpread)
    if (m.pnlPct >= input.params.minGainPct) return input.features.green1m ? { action: 'HOLD', reasons: ['riding 1m momentum'] } : { action: 'EXIT', reasons: ['1m momentum faded'] }
    if (d.action === 'EXIT') return { action: 'HOLD', reasons: ['below target'] }
  }
  return d
}

function main(argv) {
  const arg = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def }
  const candles = JSON.parse(fs.readFileSync(arg('candles'), 'utf8'))
  const cycles = deriveCycles(parseOrderHistory(fs.readFileSync(arg('orders'), 'utf8')))
  const params = UP_DIP_PARAMS
  const halfSpread = parseSpread(arg('spread'))
  const features = buildFeatures(candles, params)
  const cols = buildExtended(candles)
  const idxAt = (ms) => { let lo = 0, hi = candles.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (candles[m].timestamp + MIN <= ms) lo = m; else hi = m - 1 } return lo }
  const firstAt = (ms) => candles.findIndex(c => c.timestamp >= ms)
  const iFrom = firstAt(Date.parse('2026-02-15T00:00:00Z')), iSplit = firstAt(Date.parse('2026-05-01T00:00:00Z')), iTo = candles.length
  const isTrain = (i) => i < iSplit
  const featureNames = [...Object.keys(cols), 'posInRange', 'floorDistVol']

  // Operator entries with their real floors.
  const adam = cycles.map(c => { const i = idxAt(Date.parse(c.entryTime)); return { i, ...rowAt(cols, candles, i, c.contract.floor, c.contract.range) } })

  // Stateless rule ENTER signals, first per hour, traded standalone.
  const signals = []
  let lastHour = -1
  for (let i = iFrom; i < iTo - 1; i++) {
    const hourKey = Math.floor(candles[i].timestamp / 3_600_000)
    if (hourKey === lastHour) continue
    if (decideUpDip({ features: features[i], position: null, now: candles[i].timestamp + MIN, halfSpread, params }).action !== 'ENTER') continue
    lastHour = hourKey
    const res = standalone(candles, features, i, params, halfSpread)
    if (!res) continue
    const contract = pickContract(candles[i].close, candles[i].timestamp + MIN, params)
    signals.push({ i, outcome: res.outcome, pnl: res.pnl, ...rowAt(cols, candles, i, contract.floor) })
  }
  // Random non-entry minutes (seeded).
  let seed = 42
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const random = []
  while (random.length < 3000) {
    const i = iFrom + Math.floor(rand() * (iTo - iFrom))
    random.push({ i, ...rowAt(cols, candles, i, pickContract(candles[i].close, candles[i].timestamp + MIN, params).floor) })
  }

  const sepTable = (A, B) => featureNames.map(f => {
    const tr = auc(A.filter(r => isTrain(r.i)).map(r => r[f]), B.filter(r => isTrain(r.i)).map(r => r[f]))
    const te = auc(A.filter(r => !isTrain(r.i)).map(r => r[f]), B.filter(r => !isTrain(r.i)).map(r => r[f]))
    return { feature: f, aucTrain: r3(tr), aucTest: r3(te), medA: r3(median(A.map(r => r[f]))), medB: r3(median(B.map(r => r[f]))) }
  }).sort((x, y) => Math.abs((y.aucTrain ?? 0.5) - 0.5) - Math.abs((x.aucTrain ?? 0.5) - 0.5))

  const wins = signals.filter(s => s.outcome === 'win'), kos = signals.filter(s => s.outcome === 'ko')
  const report = {
    spread: halfSpread,
    counts: { adam: adam.length, signals: signals.length, signalsTrain: signals.filter(s => isTrain(s.i)).length,
      wins: wins.length, kos: kos.length, otherLosses: signals.filter(s => s.outcome === 'loss').length,
      kosTrain: kos.filter(s => isTrain(s.i)).length, random: random.length },
    adamVsRule: sepTable(adam, signals).slice(0, 15),
    adamVsRandom: sepTable(adam, random).slice(0, 10),
    winVsKo: sepTable(wins, kos).slice(0, 15),
  }

  // Filter fit on TRAIN ONLY: one or two thresholds on the top train win-vs-KO features.
  const candidates = report.winVsKo.filter(r => r.aucTrain != null && r.feature !== 'posInRange').slice(0, 6)
  const quantile = (f, q) => { const s = signals.filter(r => isTrain(r.i)).map(r => r[f]).filter(Number.isFinite).sort((a, b) => a - b); return s[Math.floor(q * (s.length - 1))] }
  const clauses = []
  for (const c of candidates) {
    const op = c.aucTrain > 0.5 ? '>=' : '<=' // winners higher → keep high values
    for (const q of [0.1, 0.2, 0.3, 0.4, 0.5]) clauses.push([c.feature, op, quantile(c.feature, op === '>=' ? q : 1 - q)])
  }
  const evalFilter = (filter, p = params, opts = {}) => {
    const decide = makeDecide({ filter, cols, ...opts })
    const adamTrain = cycles.map(c => Date.parse(c.entryTime)).filter(t => t < candles[iSplit].timestamp)
    const adamTest = cycles.map(c => Date.parse(c.entryTime)).filter(t => t >= candles[iSplit].timestamp)
    return {
      train: summarize(simulate(candles, features, iFrom, iSplit, p, { decide, halfSpread }), adamTrain),
      test: summarize(simulate(candles, features, iSplit, iTo, p, { decide, halfSpread }), adamTest),
    }
  }
  const score = (s) => s.pnl / Math.max(500, s.maxDrawdown)
  const fits = []
  for (const a of clauses) fits.push({ filter: [a], ...evalFilter([a]) })
  fits.sort((x, y) => score(y.train) - score(x.train))
  const topSingles = fits.slice(0, 5)
  const pairs = []
  for (const a of topSingles) for (const b of clauses) if (b[0] !== a.filter[0][0]) pairs.push({ filter: [a.filter[0], b], ...evalFilter([a.filter[0], b]) })
  const all = [...fits, ...pairs].sort((x, y) => score(y.train) - score(x.train))
  const best = all[0]
  const brief = (r) => ({ filter: r.filter.map(([k, op, t]) => `${k} ${op} ${r3(t)}`).join(' AND '),
    train: pick(r.train), test: pick(r.test) })
  const pick = (s) => ({ cycles: s.cycles, winRate: s.winRate, pnl: s.pnl, maxDrawdown: s.maxDrawdown, worst: s.worst,
    kos: s.exits.knock_out_floor || 0, adamEntries: s.adamEntries, adamTaken: s.adamEntriesCaught })
  report.baseline = { filter: 'none', ...Object.fromEntries(Object.entries(evalFilter(null)).map(([k, v]) => [k, pick(v)])) }
  report.filterTop = all.slice(0, 8).map(brief)
  report.selected = brief(best)
  // Sensitivity: nudge each selected threshold by ±1 train decile.
  report.sensitivity = []
  best.filter.forEach(([k, op, t], idx) => {
    const s = signals.filter(r => isTrain(r.i)).map(r => r[k]).filter(Number.isFinite).sort((a, b) => a - b)
    const pos = s.findIndex(v => v >= t)
    for (const shift of [-0.1, 0.1]) {
      const nt = s[Math.max(0, Math.min(s.length - 1, pos + Math.round(shift * s.length)))]
      const f = best.filter.map((c, j) => (j === idx ? [k, op, nt] : c))
      report.sensitivity.push(brief({ filter: f, ...evalFilter(f) }))
    }
  })
  // Operator entries the filtered rule would take: an ENTER signal within ±30 min that passes the filter.
  const takes = (filter) => cycles.filter(c => {
    const a = idxAt(Date.parse(c.entryTime))
    for (let i = Math.max(0, a - 30); i <= Math.min(candles.length - 2, a + 30); i++) {
      const d = makeDecide({ filter, cols })({ features: features[i], position: null, now: candles[i].timestamp + MIN, halfSpread, params }, i)
      if (d.action === 'ENTER') return true
    }
    return false
  }).length
  report.adamEntriesWithSignal = { unfiltered: takes(null), selected: takes(best.filter) }
  // Floor and exit variants, unfiltered and with the selected filter.
  report.variants = []
  for (const floorOffset of [1000, 1440, 1850]) for (const fadeExit of [false, true]) for (const filter of [null, best.filter]) {
    const r = evalFilter(filter, { ...params, floorOffset }, { fadeExit })
    report.variants.push({ floorOffset, exit: fadeExit ? 'momentum-fade' : 'ema-recover', filtered: !!filter, train: pick(r.train), test: pick(r.test) })
  }
  const text = JSON.stringify(report, null, 2)
  if (arg('out')) fs.writeFileSync(arg('out'), text)
  console.log(text)
}

if (require.main === module) {
  try { main(process.argv.slice(2)) } catch (err) { console.error(err.stack); process.exitCode = 1 }
}
module.exports = { buildExtended, auc, standalone, makeDecide }
