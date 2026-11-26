#!/usr/bin/env node
// @ts-check
/**
 * Offline backtest of the Up-only dip setup (src/updown/up-dip-setup.js).
 * Read-only: reads a 1m candle cache and the app order history, prints JSON-ish
 * report to stdout (and optionally writes it with --out). Never trades.
 *
 * Simulation: decide at each 1m close, fill at the next 1m open, price contracts
 * with the verified formula, the app's spread and $1.99/contract/side, knock out at floor (0) or
 * ceiling (max payout − fee) on the bar's low/high (floor assumed first when a bar
 * touches both), settle at the expiry minute's close. Evaluates every dip in the
 * period, not only the operator's trades.
 *
 * Usage:
 *   node scripts/backtest-up-dip.js --candles data/updown/backtest/btc-usd-1m.json
 *     --orders data/updown/import/order-history.jsonl [--split 2026-05-01] [--grid] [--out FILE]
 *     [--spread 35] [--listing legacy|grid]
 *
 * --spread is BTC dollars a side on $2000 ranges (0 reproduces results from before costs).
 * --listing legacy rounds floors to $100; grid uses the $400 grid of the weeks in --orders
 * and takes no entries in any other week.
 */
const fs = require('fs')
const { UP_DIP_PARAMS, computeUpDipFeatures, decideUpDip, markPosition, nextExpiryMs, pickContract } = require('../src/updown/up-dip-setup')
const { settlementProceeds, FEE_PER_CONTRACT, expiryMs, parseOrderHistory, deriveCycles } = require('../src/updown/app-order-history')
const { entryCost, exitProceeds } = require('../src/updown/app-pricing')
const { pickOnGrid, DEFAULT_HALF_SPREAD } = require('../src/updown/app-quotes')

const MINUTE_MS = 60_000
const TF = { '5m': 5, '15m': 15, '1h': 60, '1d': 1440 }
const KEEP = { '1m': 180, '5m': 180, '15m': 180, '1h': 220, '1d': 365 }

/** Per-minute features, causal: index i uses candles up to and including i. */
function buildFeatures(candles, params) {
  const bufs = { '1m': [], '5m': [], '15m': [], '1h': [], '1d': [] }
  const open = {}
  const out = new Array(candles.length)
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    bufs['1m'].push(c)
    if (bufs['1m'].length > KEEP['1m']) bufs['1m'].shift()
    for (const [tf, mins] of Object.entries(TF)) {
      const start = Math.floor(c.timestamp / (mins * MINUTE_MS)) * mins * MINUTE_MS
      const o = open[tf]
      if (!o || o.timestamp !== start) {
        if (o) { bufs[tf].push(o); if (bufs[tf].length > KEEP[tf]) bufs[tf].shift() }
        open[tf] = { timestamp: start, open: c.open, high: c.high, low: c.low, close: c.close }
      } else {
        o.high = Math.max(o.high, c.high); o.low = Math.min(o.low, c.low); o.close = c.close
      }
    }
    out[i] = computeUpDipFeatures(bufs, params)
  }
  return out
}

/** Contract choice limited to the $400 grid of weeks with a $2000 order; null elsewhere. */
const gridPicker = (orders) => {
  const floors = new Map(orders.filter(o => o.range[1] - o.range[0] === 2000).map(o => [expiryMs(o.expiry), o.range[0]]))
  return (price, now, params) => {
    const expiry = nextExpiryMs(now)
    return floors.has(expiry) ? pickOnGrid(price, floors.get(expiry), expiry, params) : null
  }
}

/** Command-line spread in BTC dollars a side. */
const parseSpread = (raw) => {
  const spread = raw === undefined ? DEFAULT_HALF_SPREAD[2000] : Number(raw)
  if (!(Number.isFinite(spread) && spread >= 0)) throw new Error('--spread must be a number of at least 0')
  return spread
}

/**
 * Run the strategy over candles[from..to). `decide` defaults to decideUpDip;
 * research variants wrap it (it also receives the bar index). `halfSpread` is BTC
 * dollars a side; `pick` chooses the contract.
 */
function simulate(candles, features, from, to, params, { decide = decideUpDip, halfSpread = DEFAULT_HALF_SPREAD[params.range], pick = pickContract } = {}) {
  let pos = null, lastExitAt = null, pending = null
  const cycles = [], fills = []
  let realized = 0, peak = 0, maxDd = 0
  const close = (at, proceeds, reason, price) => {
    const pnl = proceeds - pos.cost
    realized += pnl
    cycles.push({ openedAt: pos.openedAt, closedAt: at, contracts: pos.contracts, cost: pos.cost, proceeds, pnl, reason,
      entryPrice: pos.entryPrice, exitPrice: price, floor: pos.contract.floor, expiry: pos.contract.expiry })
    pos = null
    lastExitAt = at
  }
  for (let i = from; i < to; i++) {
    const c = candles[i]
    if (pending) {
      const px = c.open
      if (pending.action === 'EXIT' && pos) close(c.timestamp, exitProceeds(px, pos.contract, halfSpread, pos.contracts), 'exit', px)
      else if (pending.action === 'ENTER' && !pos && px > pending.contract.floor && px + halfSpread < pending.contract.ceiling) {
        const cost = entryCost(px, pending.contract, halfSpread)
        pos = { contract: pending.contract, contracts: 1, cost, lastFillPrice: px, entryPrice: px, openedAt: c.timestamp }
        fills.push({ at: c.timestamp, side: 'enter', price: px })
      } else if (pending.action === 'ADD' && pos && px > pos.contract.floor) {
        pos.cost += entryCost(px, pos.contract, halfSpread)
        pos.contracts++
        pos.lastFillPrice = px
        fills.push({ at: c.timestamp, side: 'add', price: px })
      }
      pending = null
    }
    const now = c.timestamp + MINUTE_MS
    if (pos) {
      if (c.low <= pos.contract.floor) close(now, 0, 'knock_out_floor', pos.contract.floor)
      else if (c.high >= pos.contract.ceiling) close(now, pos.contracts * (pos.contract.maxPayout - FEE_PER_CONTRACT), 'knock_out_ceiling', pos.contract.ceiling)
      else if (now >= pos.contract.expiry) close(now, settlementProceeds(c.close, pos.contract, pos.contracts), 'expiry', c.close)
    }
    const mtm = realized + (pos ? markPosition(pos, c.close, halfSpread).pnl : 0)
    peak = Math.max(peak, mtm)
    maxDd = Math.max(maxDd, peak - mtm)
    const d = decide({ features: features[i], position: pos, now, halfSpread, lastExitAt, params, pick }, i)
    if (d.action === 'ENTER' || d.action === 'ADD' || d.action === 'EXIT') pending = d
  }
  if (pos) { const c = candles[to - 1]; close(c.timestamp + MINUTE_MS, exitProceeds(c.close, pos.contract, halfSpread, pos.contracts), 'end_of_period', c.close) }
  return { cycles, fills, maxDrawdown: maxDd }
}

const r2 = (n) => Math.round(n * 100) / 100
/** Share of operator entries with a flat-book ENTER signal within ±windowMs (position state ignored). */
function signalAgreement(candles, features, adamEntries, params, windowMs = 30 * MINUTE_MS) {
  let hits = 0
  for (const a of adamEntries) {
    let lo = 0, hi = candles.length - 1
    while (lo < hi) { const m = (lo + hi) >> 1; if (candles[m].timestamp < a - windowMs) lo = m + 1; else hi = m }
    for (let i = lo; i < candles.length && candles[i].timestamp <= a + windowMs; i++) {
      if (decideUpDip({ features: features[i], position: null, now: candles[i].timestamp + MINUTE_MS, halfSpread: 0, params }).action === 'ENTER') { hits++; break }
    }
  }
  return hits
}

function summarize({ cycles, fills, maxDrawdown }, adamEntries, windowMs = 30 * MINUTE_MS) {
  const pnls = cycles.map(c => c.pnl)
  const caught = adamEntries.filter(a => fills.some(f => Math.abs(f.at - a) <= windowMs)).length
  const falseEntries = cycles.filter(c => !adamEntries.some(a => Math.abs(c.openedAt - a) <= windowMs)).length
  const byReason = {}
  for (const c of cycles) byReason[c.reason] = (byReason[c.reason] || 0) + 1
  return {
    cycles: cycles.length,
    wins: pnls.filter(p => p > 0).length,
    losses: pnls.filter(p => p <= 0).length,
    winRate: cycles.length ? r2(100 * pnls.filter(p => p > 0).length / cycles.length) : null,
    pnl: r2(pnls.reduce((a, b) => a + b, 0)),
    avgPnl: cycles.length ? r2(pnls.reduce((a, b) => a + b, 0) / cycles.length) : null,
    worst: cycles.length ? r2(Math.min(...pnls)) : null,
    best: cycles.length ? r2(Math.max(...pnls)) : null,
    maxDrawdown: r2(maxDrawdown),
    maxContracts: Math.max(0, ...cycles.map(c => c.contracts)),
    exits: byReason,
    adamEntries: adamEntries.length,
    adamEntriesCaught: caught,
    simEntriesNotNearAdam: falseEntries,
  }
}

/** Features at the operator's fills (the 1m bar completed just before each fill). */
function labelTrades(candles, features, cycles) {
  const idxBefore = (ms) => { let lo = 0, hi = candles.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (candles[m].timestamp + MINUTE_MS <= ms) lo = m; else hi = m - 1 } return lo }
  const rows = []
  for (const cy of cycles) {
    cy.fills.forEach((f, k) => {
      const ms = Date.parse(f.time)
      const ft = features[idxBefore(ms)]
      if (!ft) return
      const kind = f.side === 'sell' ? 'exit' : k === 0 ? 'entry' : 'add'
      rows.push({ kind, time: f.time, btc: f.btcPrice, ...Object.fromEntries(Object.entries(ft).filter(([k2]) => k2 !== 'timestamp' && k2 !== 'price').map(([k2, v]) => [k2, typeof v === 'number' ? r2(v) : v])) })
    })
  }
  const pct = (arr, q) => { const s = arr.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? r2(s[Math.min(s.length - 1, Math.floor(q * s.length))]) : null }
  const stats = {}
  for (const kind of ['entry', 'add', 'exit']) {
    const rs = rows.filter(r => r.kind === kind)
    stats[kind] = { n: rs.length, green1m: rs.filter(r => r.green1m).length }
    for (const key of ['dropPct', 'vs1m', 'vs5m', 'vs15m', 'vs1h', 'vs1d', 'rsi1m']) {
      stats[kind][key] = { p10: pct(rs.map(r => r[key]), 0.1), p25: pct(rs.map(r => r[key]), 0.25), median: pct(rs.map(r => r[key]), 0.5), p75: pct(rs.map(r => r[key]), 0.75), p90: pct(rs.map(r => r[key]), 0.9) }
    }
  }
  return { rows, stats }
}

function parseArgs(argv) {
  const arg = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def }
  const spread = parseSpread(arg('spread'))
  const listing = arg('listing', 'legacy')
  if (!['legacy', 'grid'].includes(listing)) throw new Error('--listing must be legacy or grid')
  return { spread, listing, candlesPath: arg('candles'), ordersPath: arg('orders'), out: arg('out'),
    split: Date.parse(arg('split', '2026-05-01T00:00:00Z')),
    evalFrom: Date.parse(arg('from', '2026-02-15T00:00:00Z')),
    evalTo: Date.parse(arg('to', '2026-11-16T00:00:00Z')), grid: argv.includes('--grid') }
}

function main(argv, log = console.log) {
  const { spread, listing, candlesPath, ordersPath, out, split, evalFrom, evalTo, grid: searchGrid } = parseArgs(argv)
  const candles = JSON.parse(fs.readFileSync(candlesPath, 'utf8'))
  const orders = parseOrderHistory(fs.readFileSync(ordersPath, 'utf8'))
  const cycles = deriveCycles(orders)
  const options = { halfSpread: spread, pick: listing === 'grid' ? gridPicker(orders) : pickContract }
  const features = buildFeatures(candles, UP_DIP_PARAMS)
  const at = (ms) => { const i = candles.findIndex(c => c.timestamp >= ms); return i < 0 ? candles.length : i }
  const [iFrom, iSplit, iTo] = [at(evalFrom), at(split), at(evalTo)]
  const adamFirstBuys = cycles.map(c => Date.parse(c.entryTime))
  const inRange = (a, b) => adamFirstBuys.filter(t => t >= candles[a]?.timestamp && t < (candles[b]?.timestamp ?? Infinity))

  const report = { spread, listing, candles: candles.length, from: new Date(candles[iFrom].timestamp).toISOString(), split: new Date(split).toISOString(),
    to: new Date(candles[iTo - 1].timestamp).toISOString(), labels: labelTrades(candles, features, cycles).stats }

  const run = (params) => ({
    train: { ...summarize(simulate(candles, features, iFrom, iSplit, params, options), inRange(iFrom, iSplit)), adamEntriesWithSignal: signalAgreement(candles, features, inRange(iFrom, iSplit), params) },
    test: { ...summarize(simulate(candles, features, iSplit, iTo, params, options), inRange(iSplit, iTo)), adamEntriesWithSignal: signalAgreement(candles, features, inRange(iSplit, iTo), params) },
  })
  if (searchGrid) {
    // Selection uses TRAIN only; test numbers are reported for the train-selected params.
    const grid = []
    for (const minDropPct of [0.2, 0.4, 0.6]) for (const minGainPct of [4, 7]) for (const minDaysToEnter of [1, 3])
      for (const maxContracts of [1, 3, 5]) for (const maxLossPct of [15, 30, Infinity]) {
        const knobs = { minDropPct, minGainPct, minDaysToEnter, maxContracts, maxLossPct }
        const params = { ...UP_DIP_PARAMS, ...knobs }
        grid.push({ params: knobs, train: summarize(simulate(candles, features, iFrom, iSplit, params, options), inRange(iFrom, iSplit)), full: params })
      }
    // Rank by train P&L per unit of drawdown.
    grid.sort((a, b) => (b.train.pnl / Math.max(1, b.train.maxDrawdown)) - (a.train.pnl / Math.max(1, a.train.maxDrawdown)))
    report.grid = grid.map(g => ({ ...g.params, trainPnl: g.train.pnl, trainDd: g.train.maxDrawdown, trainCycles: g.train.cycles, trainWinRate: g.train.winRate, trainWorst: g.train.worst }))
    const best = grid[0]
    report.selected = { params: best.params, ...run(best.full) }
  }
  report.defaults = { params: UP_DIP_PARAMS, ...run(UP_DIP_PARAMS) }
  // Monthly breakdown with the shipped defaults, all dips.
  const months = []
  for (let m = new Date(evalFrom); m < new Date(evalTo); m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) {
    const a = at(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), 1)), b = at(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))
    if (b - a < 1440) continue
    const s = summarize(simulate(candles, features, a, b, UP_DIP_PARAMS, options), inRange(a, b))
    months.push({ month: m.toISOString().slice(0, 7), cycles: s.cycles, winRate: s.winRate, pnl: s.pnl, worst: s.worst, maxDrawdown: s.maxDrawdown, adamEntries: s.adamEntries, caught: s.adamEntriesCaught })
  }
  report.monthly = months
  const text = JSON.stringify(report, null, 2)
  if (out) fs.writeFileSync(out, text)
  log(text)
}

if (require.main === module) {
  try { main(process.argv.slice(2)) } catch (err) { console.error(err.stack); process.exitCode = 1 }
}
module.exports = { buildFeatures, simulate, summarize, labelTrades, signalAgreement, gridPicker, parseSpread, parseArgs, main }
