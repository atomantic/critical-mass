#!/usr/bin/env node
// Read-only offline validation; output goes only to stdout.
const fs = require('node:fs')
const crypto = require('node:crypto')
const { walkForward } = require('../src/updown/validation')
function main(args) {
  const [file, fee, slippage, warmup = '10080', folds = '3'] = args
  if (args.length < 3 || args.length > 5 || [fee, slippage, warmup, folds].some(v => !v.trim() || !Number.isFinite(Number(v)))) {
    throw new Error('Usage: node scripts/validate-updown.js CANDLES.json FEE_USD_PER_CONTRACT_PER_SIDE SLIPPAGE_BPS [WARMUP_MINUTES=10080] [FOLDS=3]')
  }
  const bytes = fs.readFileSync(file)
  const input = JSON.parse(bytes.toString())
  const result = walkForward(Array.isArray(input) ? input : input.candles, {
    feePerContract: Number(fee), slippageBps: Number(slippage), warmup: Number(warmup), folds: Number(folds),
  })
  console.log(JSON.stringify({ inputSha256: crypto.createHash('sha256').update(bytes).digest('hex'), ...result }, null, 2))
}
if (require.main === module) {
  try { main(process.argv.slice(2)) } catch (err) { console.error(err.message); process.exitCode = 1 }
}
module.exports = { main }
