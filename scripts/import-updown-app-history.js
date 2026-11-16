#!/usr/bin/env node
// @ts-check
/**
 * Import Crypto.com app UpDown order history into the UpDown trade log.
 * DRY RUN by default: prints the diff and the resulting totals, writes nothing.
 *
 * Usage:
 *   node scripts/import-updown-app-history.js [--file data/updown/import/order-history.jsonl]
 *     [--ledger data/updown-trades.json] [--apply]
 *
 * --apply backs the ledger up next to itself (updown-trades.json.bak-<ts>) and
 * writes atomically. The gateway (PM2 `critical-mass`) owns this file — stop it
 * first (see CLAUDE.md / UPGRADE.md); --apply refuses while it is online unless
 * --ledger points elsewhere.
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { DATA_DIR } = require('../src/paths')
const { parseOrderHistory, deriveCycles } = require('../src/updown/app-order-history')
const { reconcile, validateLedger } = require('../src/updown/app-history-import')

const DEFAULT_LEDGER = path.join(DATA_DIR, 'updown-trades.json')
const DEFAULT_FILE = path.join(DATA_DIR, 'updown', 'import', 'order-history.jsonl')

const gatewayOnline = () => {
  try {
    const list = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8' }))
    return list.some(p => p.name === 'critical-mass' && p.pm2_env?.status === 'online')
  } catch { return false }
}

const totals = (trades) => ({
  count: trades.length,
  wins: trades.filter(t => t.pnl > 0).length,
  losses: trades.filter(t => t.pnl <= 0).length,
  pnl: Math.round(trades.reduce((s, t) => s + t.pnl, 0) * 100) / 100,
})

function main(argv) {
  const arg = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def }
  const apply = argv.includes('--apply')
  const file = arg('file', DEFAULT_FILE)
  const ledgerPath = arg('ledger', DEFAULT_LEDGER)

  const cycles = deriveCycles(parseOrderHistory(fs.readFileSync(file, 'utf8')))
  const raw = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8') : ''
  const ledger = raw.trim() ? JSON.parse(raw) : { trades: [], nextId: 1 }
  const { ledger: next, diff } = reconcile(ledger, cycles)
  const errors = validateLedger(next)

  const fmt = (r) => `#${r.id} ${r.date} ${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(2)}`
  console.log(`cycles in app history: ${cycles.length} (${totals(cycles).wins}W/${totals(cycles).losses}L, ${totals(cycles).pnl})`)
  console.log(`before: ${JSON.stringify(totals(ledger.trades))}`)
  console.log(`after:  ${JSON.stringify(totals(next.trades))}`)
  console.log(`\nenriched (${diff.enriched.length}): ${diff.enriched.map(r => `${fmt(r)}[${r.match}]`).join(', ') || '-'}`)
  console.log(`\ncorrected amounts (${diff.corrected.length}):`)
  for (const r of diff.corrected) console.log(`  ${fmt(r)} [${r.match}] ${JSON.stringify(r.from)} -> ${JSON.stringify(r.to)}`)
  console.log(`\nadded (${diff.added.length}):`)
  for (const r of diff.added) console.log(`  ${fmt(r)} cost ${r.cost} return ${r.returnAmount} (${r.importKey})`)
  console.log(`\nunchanged (already imported): ${diff.unchanged.length}`)
  console.log(`unmatched manual trades left as-is (${diff.unmatchedManual.length}): ${diff.unmatchedManual.map(fmt).join(', ') || '-'}`)
  if (errors.length) {
    console.error(`\nVALIDATION FAILED:\n  ${errors.join('\n  ')}`)
    process.exitCode = 1
    return
  }
  console.log('\nvalidation: ok')
  if (!apply) { console.log('dry run — nothing written (pass --apply)'); return }
  if (path.resolve(ledgerPath) === path.resolve(DEFAULT_LEDGER) && gatewayOnline()) {
    console.error('refusing --apply: PM2 critical-mass (owner of the trades file) is online; stop it first')
    process.exitCode = 1
    return
  }
  if (!diff.enriched.length && !diff.corrected.length && !diff.added.length) { console.log('nothing to write'); return }
  if (raw) {
    const backup = `${ledgerPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    fs.copyFileSync(ledgerPath, backup)
    console.log(`backup: ${backup}`)
  }
  const tmp = `${ledgerPath}.import-tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, ledgerPath)
  console.log(`wrote ${ledgerPath}`)
}

if (require.main === module) {
  try { main(process.argv.slice(2)) } catch (err) { console.error(err.message); process.exitCode = 1 }
}
module.exports = { main }
