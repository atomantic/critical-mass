#!/usr/bin/env node
// @ts-check
/**
 * Archive an Up dip paper book and start it again empty.
 * DRY RUN by default: prints what would be archived, writes nothing.
 *
 *   node scripts/reset-up-dip-paper.js [--book main|shadow] [--apply]
 *
 * The gateway (PM2 `critical-mass`) owns these files: stop it first (UPGRADE.md).
 * --apply refuses while it is online or its state cannot be determined. The whole
 * book, including any open position and its mark, is written to
 * data/updown/archive/ before the book is emptied.
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { DATA_DIR } = require('../src/paths')
const { atomicWriteSync } = require('../src/durable-write')
const { emptyState } = require('../src/updown/up-dip-paper')
const { markPosition } = require('../src/updown/up-dip-setup')

const BOOKS = { main: 'up-dip-paper.json', shadow: 'up-dip-paper-shadow.json' }
const r2 = (n) => Math.round(n * 100) / 100

/** true: running, false: stopped, null: cannot tell. */
const gatewayState = (listProcesses = () => execFileSync('pm2', ['jlist'], { encoding: 'utf8' })) => {
  try {
    const gateway = JSON.parse(listProcesses()).find(p => p.name === 'critical-mass')
    return gateway ? !['stopped', 'errored'].includes(gateway.pm2_env?.status) : null
  } catch { return null }
}

/** The open position as the book itself would have marked it. */
const summarizePosition = (state) => {
  const p = state.position
  if (!p) return null
  const price = state.latest?.features?.price
  const marked = Number.isFinite(price)
  return {
    contract: p.contract, contracts: p.contracts, cost: r2(p.cost),
    markBtc: marked ? price : null,
    pnl: marked ? r2(markPosition(p, price, p.halfSpread ?? 0).pnl) : null,
    markedAt: marked ? state.latest.at : null,
  }
}

const parse = (raw) => {
  try {
    const state = JSON.parse(raw)
    return state && typeof state === 'object' && !Array.isArray(state) ? state : null
  } catch { return null }
}

/**
 * @param {{statePath: string, archiveDir: string, apply: boolean, now: number, gatewayOnline: boolean | null}} options
 */
const resetUpDipPaper = ({ statePath, archiveDir, apply, now, gatewayOnline }) => {
  if (!fs.existsSync(statePath)) throw new Error(`There is no book at ${statePath}`)
  const raw = fs.readFileSync(statePath, 'utf8')
  const state = parse(raw)
  const book = path.basename(statePath, '.json')
  const pnls = (state?.cycles || []).map(c => c.pnl)
  const summary = state
    ? {
        book, archivedAt: now, pricing: state.pricing ?? null,
        closedCycles: state.totals?.cycles ?? pnls.length,
        wins: state.totals?.wins ?? pnls.filter(p => p > 0).length,
        pnl: state.totals?.pnl ?? r2(pnls.reduce((a, b) => a + b, 0)),
        openPosition: summarizePosition(state),
      }
    : { book, archivedAt: now, unreadable: true }
  const archivePath = path.join(archiveDir, `${book}-${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`)
  if (!apply) return { archivePath, summary, applied: false }
  if (gatewayOnline !== false) {
    throw new Error(gatewayOnline ? 'The gateway is online: stop it first (UPGRADE.md)' : 'Cannot tell whether the gateway is stopped, so nothing was changed')
  }
  fs.mkdirSync(archiveDir, { recursive: true })
  atomicWriteSync(archivePath, JSON.stringify(state ? { summary, state } : { summary, raw }, null, 2), { exclusive: true })
  atomicWriteSync(statePath, JSON.stringify(emptyState(), null, 2))
  return { archivePath, summary, applied: true }
}

function main(argv) {
  const i = argv.indexOf('--book')
  const file = BOOKS[i >= 0 ? argv[i + 1] : 'main']
  if (!file) throw new Error('--book must be main or shadow')
  const apply = argv.includes('--apply')
  const result = resetUpDipPaper({
    statePath: path.join(DATA_DIR, 'updown', file), archiveDir: path.join(DATA_DIR, 'updown', 'archive'),
    apply, now: Date.now(), gatewayOnline: apply ? gatewayState() : null,
  })
  console.log(JSON.stringify(result.summary, null, 2))
  console.log(result.applied ? `Archived to ${result.archivePath} and reset.` : `Dry run: would archive to ${result.archivePath}. Re-run with --apply to reset.`)
}

if (require.main === module) {
  try { main(process.argv.slice(2)) } catch (err) { console.error(err.message); process.exitCode = 1 }
}
module.exports = { resetUpDipPaper, gatewayState }
