#!/usr/bin/env node
// Read-only offline replay of the UpDown flush-reversal setup; output goes only to stdout.
// Input: a JSON array (or {candles: [...]}) of 1m {timestamp, open, high, low, close} rows,
// oldest first, timestamps in ms at minute starts. Exchange gaps are allowed.
const fs = require('node:fs')
const crypto = require('node:crypto')
const { replayFlushSetup, FLUSH_SETUP_PARAMS } = require('../src/updown/flush-setup')

function main(args) {
  const [file, ...overrides] = args
  if (!file) throw new Error('Usage: node scripts/backtest-flush-setup.js CANDLES.json [param=value ...]')
  const params = { ...FLUSH_SETUP_PARAMS }
  for (const pair of overrides) {
    const [key, value] = pair.split('=')
    if (!(key in params) || !Number.isFinite(Number(value))) throw new Error(`Unknown or non-numeric override: ${pair}`)
    params[key] = Number(value)
  }
  const bytes = fs.readFileSync(file)
  const input = JSON.parse(bytes.toString())
  const candles = Array.isArray(input) ? input : input.candles
  const { entries, summary } = replayFlushSetup(candles, params)
  console.log(JSON.stringify({
    inputSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    from: candles[0] ? new Date(candles[0].timestamp).toISOString() : null,
    to: candles.length ? new Date(candles[candles.length - 1].timestamp).toISOString() : null,
    params,
    summary,
    entries: entries.map(e => ({
      enteredAt: new Date(e.enteredAt).toISOString(),
      entryPrice: e.entryPrice,
      flushLow: e.flushLow,
      ...e.armedMetrics,
      exit: e.exit && { ...e.exit, at: new Date(e.exit.at).toISOString() },
    })),
  }, null, 2))
}
if (require.main === module) {
  try { main(process.argv.slice(2)) } catch (err) { console.error(err.message); process.exitCode = 1 }
}
module.exports = { main }
