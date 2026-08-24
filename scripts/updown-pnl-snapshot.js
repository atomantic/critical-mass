#!/usr/bin/env node
// @ts-check
/**
 * Snapshot (and optionally hydrate) the UpDown paper-book P&L.
 *
 * Usage:
 *   node scripts/updown-pnl-snapshot.js
 *   node scripts/updown-pnl-snapshot.js --reset-book
 *   node scripts/updown-pnl-snapshot.js --hydrate-state
 *
 * --reset-book     Stop-the-engine first. Zero the paper book (0 lots, 0 P&L)
 *                  so the next BUY is a fresh OPEN. Historical signal labels
 *                  are not a live position.
 * --hydrate-state  Stop-the-engine first. Replays signal history through the
 *                  0.01-BTC-per-contract paper book using scorecard prediction prices, then
 *                  writes perpBook into data/updown-state.json.
 */

const fs = require('fs')
const path = require('path')
const { DATA_DIR, UPDOWN_DATA_DIR } = require('../src/paths')
const { readJSON, writeJSON } = require('../src/shared-utils')
const { createPerpBook } = require('../src/updown/perp-book')
const { replaySignals, priceAt, summarize } = require('../src/updown/pnl-monitor')

const STATE_PATH = path.join(DATA_DIR, 'updown-state.json')
const SCORECARD_DIR = path.join(UPDOWN_DATA_DIR, 'scorecard')
const SNAPSHOT_PATH = path.join(UPDOWN_DATA_DIR, 'pnl-monitor.jsonl')
const hydrate = process.argv.includes('--hydrate-state')
const resetBook = process.argv.includes('--reset-book')
if (hydrate && resetBook) {
  console.error('📊 UpDown pnl-monitor cannot --hydrate-state and --reset-book together')
  process.exit(1)
}

const loadPriceIndex = () => {
  if (!fs.existsSync(SCORECARD_DIR)) return []
  const files = fs.readdirSync(SCORECARD_DIR).filter(f => f.endsWith('.jsonl')).sort()
  /** @type {Array<{t: number, p: number}>} */
  const index = []
  for (const f of files) {
    const content = fs.readFileSync(path.join(SCORECARD_DIR, f), 'utf8')
    for (const line of content.split('\n')) {
      if (!line) continue
      let rec
      try { rec = JSON.parse(line) } catch { continue }
      if (rec?.type !== 'prediction' || !Number.isFinite(rec.price)) continue
      const t = Date.parse(rec.ts)
      if (!Number.isFinite(t)) continue
      index.push({ t, p: rec.price })
    }
  }
  index.sort((a, b) => a.t - b.t)
  return index
}

const state = readJSON(STATE_PATH, null)
if (!state) {
  console.error('📊 UpDown pnl-monitor missing state file=' + STATE_PATH)
  process.exit(1)
}

const priceIndex = loadPriceIndex()
const lastMark = priceIndex.length > 0 ? priceIndex[priceIndex.length - 1].p : null
const latest = Array.isArray(state.signalHistory) && state.signalHistory.length > 0
  ? state.signalHistory[state.signalHistory.length - 1]
  : null

let book = createPerpBook()
if (resetBook) {
  state.perpBook = book.serialize()
  writeJSON(STATE_PATH, state)
  console.error(`📊 UpDown pnl-monitor reset book contracts=0 file=${STATE_PATH}`)
} else if (hydrate) {
  const { book: replayed, fills } = replaySignals(
    state.signalHistory,
    (ts) => priceAt(priceIndex, ts),
  )
  book = replayed
  state.perpBook = book.serialize()
  writeJSON(STATE_PATH, state)
  console.error(`📊 UpDown pnl-monitor hydrated fills=${fills.length} contracts=${book.contracts()} file=${STATE_PATH}`)
} else if (state.perpBook) {
  book.hydrate(state.perpBook)
}

const mark = lastMark
const snap = summarize(book.snapshot(mark), {
  mark,
  lastAction: latest?.action ?? null,
  lastType: latest?.type ?? null,
})

fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true })
fs.appendFileSync(SNAPSHOT_PATH, JSON.stringify(snap) + '\n')
console.log(JSON.stringify(snap))
