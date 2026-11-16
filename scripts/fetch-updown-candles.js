#!/usr/bin/env node
// @ts-check
/**
 * Fetch BTC-USD 1m candles for UpDown research from Coinbase's PUBLIC market
 * endpoint (no API key, so it never shares rate limits with live trading keys)
 * and merge them into a local cache. Read-only against the exchange.
 *
 * Usage: node scripts/fetch-updown-candles.js [--from 2026-01-15] [--to now] [--out FILE]
 * Default cache: data/updown/backtest/btc-usd-1m.json (array of {timestamp,open,high,low,close,volume}).
 */
const fs = require('fs')
const path = require('path')
const { DATA_DIR } = require('../src/paths')

const MINUTE_MS = 60_000
const BATCH = 300
const DEFAULT_OUT = path.join(DATA_DIR, 'updown', 'backtest', 'btc-usd-1m.json')
const URL_BASE = 'https://api.coinbase.com/api/v3/brokerage/market/products/BTC-USD/candles'

const readCache = (file) => {
  if (!fs.existsSync(file)) return []
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'))
  return Array.isArray(rows) ? rows : []
}

const writeCache = (file, rows) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(rows))
  fs.renameSync(tmp, file)
}

async function fetchBatch(startMs, endMs) {
  const url = `${URL_BASE}?start=${Math.floor(startMs / 1000)}&end=${Math.floor(endMs / 1000)}&granularity=ONE_MINUTE&limit=${BATCH}`
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url)
      if (res.status === 429) throw new Error('rate limited')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      return (data.candles || []).map(c => ({
        timestamp: Number(c.start) * 1000,
        open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close),
        volume: Number(c.volume),
      }))
    } catch (err) {
      if (attempt === 4) throw err
      await new Promise(r => setTimeout(r, 1000 * 2 ** attempt))
    }
  }
  return []
}

/** Minute-aligned ranges [start, end) inside [fromMs, toMs) not covered by `have`. */
function missingRanges(have, fromMs, toMs) {
  const ranges = []
  let start = null
  for (let t = fromMs; t < toMs; t += MINUTE_MS) {
    if (!have.has(t)) { if (start == null) start = t }
    else if (start != null) { ranges.push([start, t]); start = null }
  }
  if (start != null) ranges.push([start, toMs])
  return ranges
}

async function main(argv) {
  const arg = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def }
  const fromMs = Date.parse(arg('from', '2026-01-15T00:00:00Z'))
  const toArg = arg('to', 'now')
  const toMs = Math.floor((toArg === 'now' ? Date.now() : Date.parse(toArg)) / MINUTE_MS) * MINUTE_MS
  const out = arg('out', DEFAULT_OUT)
  const byTs = new Map(readCache(out).map(c => [c.timestamp, c]))
  // Exchange gaps (no trades in a minute) stay missing; a re-run only re-asks those.
  const ranges = missingRanges(new Set(byTs.keys()), fromMs, toMs)
  let requests = 0
  for (const [rs, re] of ranges) {
    for (let cursor = rs; cursor < re; cursor += BATCH * MINUTE_MS) {
      const end = Math.min(cursor + BATCH * MINUTE_MS, re)
      for (const c of await fetchBatch(cursor, end - MINUTE_MS)) byTs.set(c.timestamp, c)
      if (++requests % 100 === 0) {
        writeCache(out, [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp))
        console.log(`${requests} requests, ${byTs.size} candles, at ${new Date(cursor).toISOString().slice(0, 16)}`)
      }
      await new Promise(r => setTimeout(r, 120))
    }
  }
  const rows = [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp)
  writeCache(out, rows)
  console.log(`done: ${requests} requests, ${rows.length} candles ${rows.length ? new Date(rows[0].timestamp).toISOString() : ''} → ${rows.length ? new Date(rows.at(-1).timestamp).toISOString() : ''} in ${out}`)
}

if (require.main === module) main(process.argv.slice(2)).catch(err => { console.error(err.message); process.exitCode = 1 })
module.exports = { missingRanges }
