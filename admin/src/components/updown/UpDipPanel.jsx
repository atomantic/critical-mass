import { memo } from 'react'
import { TrendingUp } from '../icons'
import UpDipHeld from './UpDipHeld'
import AppQuoteForm from './AppQuoteForm'
import { formatSpread, formatUsd } from '../../utils/format.mjs'
import { signedPrefix } from '../../utils/pnlFormat.mjs'

// Paper-only: shows what the Up dip setup would do and how its paper book is
// doing, plus the SHADOW book (same rule + daily-trend filter) beside it.
// Nothing here (or behind /api/updown/up-dip) places an order.

const ACTION_STYLE = {
  ENTER: 'text-green-400 border-green-700 bg-green-900/30',
  ADD: 'text-emerald-300 border-emerald-700 bg-emerald-900/30',
  EXIT: 'text-amber-300 border-amber-700 bg-amber-900/30',
  HOLD: 'text-blue-300 border-blue-700 bg-blue-900/30',
  STAND_ASIDE: 'text-gray-300 border-gray-600 bg-gray-900',
}
const REASON_LABEL = { exit: 'exit', knock_out_floor: 'KO floor', knock_out_ceiling: 'KO ceiling', expiry: 'expiry' }

const usd = (v) => (v == null ? '---' : formatUsd(v))
const signedUsd = (v) => (v == null ? '---' : `${signedPrefix(v)}${formatUsd(v)}`)
const pnlColor = (v) => (v > 0 ? 'text-green-400' : v < 0 ? 'text-red-400' : 'text-gray-400')
const when = (ms) => (ms ? new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '---')
const k = (v) => `${(v / 1000).toFixed(1)}k`
const FEE_PER_SIDE = 1.99
/** Dollars a $2,000 contract moves per BTC dollar. */
const SLOPE = 0.5
const age = (ms) => (ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))}m` : `${Math.round(ms / 3_600_000)}h`)
const LISTING_LABEL = { legacy: ', any $100 floor', grid: ', listed floors only' }

function SourceGap({ label, gap }) {
  return <span>{label} {gap.median == null ? `not enough yet (${gap.n}/10)` : `${signedUsd(gap.median)}, 90% within ${usd(gap.p90)}`}</span>
}

// What the app charges, whether its listings are known, and how its price compares.
function Costs({ quotes }) {
  const spread = quotes.spread[2000]
  const roundTrip = 2 * (spread.value * SLOPE + FEE_PER_SIDE)
  const { last, comparison: { coinbase, index } } = quotes
  return (
    <div data-testid="up-dip-costs" className="text-2xs text-gray-300 mb-2 space-y-0.5">
      <div>
        Spread {formatSpread(spread.value)} a side ({spread.source === 'quote' ? `your quote, ${age(spread.ageMs)} old` : 'default: no quote in 24h'})
        {' · '}Round trip {usd(roundTrip)} a contract{last && ` (${((100 * roundTrip) / (SLOPE * (last.up - last.floor) + FEE_PER_SIDE)).toFixed(1)}% of cost)`}
      </div>
      {!quotes.listingSeen && <div className="text-amber-300">No contract seen this week: record a quote to paper-trade</div>}
      <div className="text-gray-400">
        App price against: <SourceGap label="Coinbase" gap={coinbase} /> · <SourceGap label="Crypto.com index" gap={index} /> (late uploads are noisy)
      </div>
    </div>
  )
}

function ArchivedBook({ archived }) {
  if (!archived) return null
  if (archived.unreadable) return <div data-testid="up-dip-archived" className="text-2xs text-gray-400 mt-1">Previous book could not be read and was archived as it was</div>
  const { openPosition } = archived
  const open = openPosition ? (openPosition.pnl == null ? ', open position unpriced' : `, open ${signedUsd(openPosition.pnl)} at archive`) : ''
  return (
    <div data-testid="up-dip-archived" className="text-2xs text-gray-400 mt-1">
      {`Previous book${archived.pricing?.spread ? '' : ' (no spread)'}: ${archived.closedCycles} closed, ${signedUsd(archived.pnl)}${open}`}
    </div>
  )
}

function NeedsReset({ command }) {
  return <div role="alert" className="text-xs text-amber-300 border border-amber-700 rounded-sm px-2 py-1 mb-2">Needs reset: run {command}</div>
}

function BacktestLine({ label, s }) {
  if (!s) return null
  return (
    <div className="flex justify-between gap-2">
      <span className="text-gray-400">{label}</span>
      <span className="font-mono">
        {s.cycles} cyc · {s.winRate ?? '---'}% · <span className={pnlColor(s.pnl)}>{signedUsd(s.pnl)}</span> · DD {usd(s.maxDrawdown)}
      </span>
    </div>
  )
}

function CyclesTable({ cycles }) {
  if (!cycles?.length) return null
  return (
    <div className="overflow-x-auto max-h-48 mb-2">
      <table className="w-full text-2xs">
        <thead>
          <tr className="text-gray-400 border-b border-gray-700">
            <th className="text-left py-0.5">Closed</th>
            <th className="text-right">BTC in→out</th>
            <th className="text-right">How</th>
            <th className="text-right">P&L</th>
          </tr>
        </thead>
        <tbody>
          {cycles.map((c) => (
            <tr key={`${c.openedAt}-${c.closedAt}`} className="border-b border-gray-700/50">
              <td className="py-0.5 whitespace-nowrap">{when(c.closedAt)}</td>
              <td className="text-right font-mono">{c.entryBtc?.toLocaleString()}→{c.exitBtc?.toLocaleString()}</td>
              <td className="text-right">{`${REASON_LABEL[c.reason] || c.reason}${c.uncertain ? ' · assumed' : c.coinbaseTouched === false ? ' · index only' : ''}`}</td>
              <td className={`text-right font-mono ${pnlColor(c.pnl)}`}>{signedUsd(c.pnl)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ShadowBook({ book }) {
  const f = book.filter
  const decision = book.latest?.decision
  const pos = book.position
  const s = book.summary
  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-dashed border-purple-700">
      <div className="flex items-center justify-between mb-2 gap-2">
        <h3 className="text-sm font-semibold">Up Dip Setup</h3>
        <span className="text-2xs uppercase tracking-wide text-purple-300 border border-purple-700 rounded-sm px-1.5 py-0.5 text-right">Shadow · paper only · daily-trend filter</span>
      </div>
      <div className="text-2xs text-amber-300/80 mb-2">This filter was found after seeing held-out results and is under live test.</div>
      {book.needsReset && <NeedsReset command="scripts/reset-up-dip-paper.js --book shadow" />}

      {f && (
        <div className={`text-xs rounded-sm px-2 py-1 mb-2 border ${f.blocking ? 'border-amber-700 bg-amber-900/20' : 'border-gray-700 bg-gray-900'}`}>
          {f.sufficient ? (
            <>
              <div className="flex justify-between">
                <span className="text-gray-400">{f.smaPeriod}-day avg</span>
                <span className="font-mono">{f.sma?.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">BTC vs avg</span>
                <span className={`font-mono ${pnlColor(f.distancePct)}`}>{signedPrefix(f.distancePct)}{f.distancePct?.toFixed(2)}%</span>
              </div>
            </>
          ) : (
            <div className="text-amber-300">Insufficient daily history ({f.dailyCandles}/{f.smaPeriod} daily candles)</div>
          )}
          <div className={`font-semibold ${f.blocking ? 'text-amber-300' : 'text-green-400'}`}>
            {f.blocking ? 'Blocking new entries and adds' : 'Not blocking'} <span className="font-normal text-gray-400">(stand aside below −{f.maxBelowSmaPct}%)</span>
          </div>
        </div>
      )}

      {decision && (
        <div className="text-xs mb-2">
          <span className="text-gray-400">Now: </span>
          <span className="font-semibold">{decision.action.replace('_', ' ')}</span>
          {decision.reasons?.[0] && <span className="text-gray-400"> · {decision.reasons[0]}</span>}
        </div>
      )}

      {pos && (
        <div className="bg-gray-900 rounded-sm px-2 py-1.5 mb-2 text-xs flex justify-between">
          <span>Up {k(pos.contract.floor)}–{k(pos.contract.ceiling)} ×{pos.contracts} @ {pos.entryPrice?.toLocaleString()}{book.needsReset && ` · frozen ${when(book.frozenAt)}`}</span>
          <span className={`font-mono ${pnlColor(pos.pnl)}`}>{signedUsd(pos.pnl)}</span>
        </div>
      )}

      {s && (
        <div className="grid grid-cols-4 gap-1.5 mb-2 text-xs">
          <div className="bg-gray-900 rounded-sm px-2 py-1">
            <div className="text-gray-400 text-2xs">Trades</div>
            <div className="font-mono">{s.cycles}</div>
          </div>
          <div className="bg-gray-900 rounded-sm px-2 py-1">
            <div className="text-gray-400 text-2xs">Wins</div>
            <div className="font-mono">{s.wins}</div>
          </div>
          <div className="bg-gray-900 rounded-sm px-2 py-1">
            <div className="text-gray-400 text-2xs">Losses</div>
            <div className="font-mono">{s.losses}</div>
          </div>
          <div className="bg-gray-900 rounded-sm px-2 py-1">
            <div className="text-gray-400 text-2xs">P&L</div>
            <div className={`font-mono font-semibold ${pnlColor(s.pnl)}`}>{signedUsd(s.pnl)}</div>
          </div>
        </div>
      )}

      <CyclesTable cycles={book.cycles} />
      <ArchivedBook archived={book.archived} />
      {book.startedAt && <div className="text-2xs text-gray-400 mt-1">Shadow tracking since {when(book.startedAt)}</div>}
    </div>
  )
}

function UpDipPanel({ data, error, load }) {
  const book = data?.latest?.decision
  // Market signal = the rule as if flat. Gateways without it only report the book's own decision.
  const decision = data?.latest?.signal ?? book
  const hasSignal = !!data?.latest?.signal
  const lastEntry = data?.lastEntrySignal
  const pos = data?.position
  const s = data?.summary

  return (
    <>
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      {error && <div role="alert" className="text-xs text-red-400 mb-2">{error}</div>}
      {!data && !error && <div className="text-xs text-gray-400 py-2">Loading held contract…</div>}
      {data?.quotes && <Costs quotes={data.quotes} />}
      {data?.quotes && <AppQuoteForm last={data.quotes.lastRecorded} onRecorded={load} />}
      {data && data.held !== undefined && <UpDipHeld held={data.held} onChange={load} />}
    </div>
    <details className="bg-gray-800 rounded-lg border border-gray-700">
    <summary className="min-h-10 px-4 py-2.5 cursor-pointer text-sm font-semibold">Up Dip paper books</summary>
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <TrendingUp size={16} className="text-green-400" />
          <h3 className="text-sm font-semibold">Up Dip Setup</h3>
        </div>
        <span className="text-2xs uppercase tracking-wide text-amber-300 border border-amber-700 rounded-sm px-1.5 py-0.5">Paper only</span>
      </div>

      {data?.needsReset && <NeedsReset command="scripts/reset-up-dip-paper.js" />}
      {data?.candles && !data.candles.ready && <div className="text-xs text-amber-300 mb-2">Waiting for candle history</div>}
      {data?.candles?.ready && data.candles.waitingFor && <div className="text-xs text-amber-300 mb-2">Waiting for index data since {when(data.candles.waitingFor)}</div>}

      {decision && (
        <div data-testid="up-dip-signal" className={`border rounded-sm px-2 py-1.5 mb-2 ${ACTION_STYLE[decision.action] || ACTION_STYLE.STAND_ASIDE}`}>
          <div className="flex justify-between items-baseline">
            <span className="font-semibold text-sm">{hasSignal && <span className="text-2xs font-normal text-gray-400">If flat: </span>}{decision.action.replace('_', ' ')}</span>
            <span className="text-2xs text-gray-400">{when(data.latest.at)} · BTC {data.latest.features?.price?.toLocaleString() ?? '---'}</span>
          </div>
          {decision.contract && (
            <div className="text-xs mt-0.5">
              Up {k(decision.contract.floor)}–{k(decision.contract.ceiling)} ×{decision.size ?? 1} · exp {decision.contract.expiryDate}
            </div>
          )}
          {decision.expected && (
            <div className="text-2xs mt-0.5 text-gray-300">
              cost {usd(decision.expected.costUsd)} · target BTC {decision.expected.targetBtc?.toLocaleString()} → {signedUsd(decision.expected.targetPnlUsd)} · floor KO {signedUsd(decision.expected.floorLossUsd)}
            </div>
          )}
          <ul className="text-2xs mt-1 text-gray-300 list-disc pl-4">
            {decision.reasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
          {hasSignal && decision.action === 'ENTER' && pos && !data.needsReset && (
            <div className="text-2xs mt-1 text-amber-300">An earlier paper entry is still open. In the held-out backtest, repeat signals an hour or more into an open trade lost money.</div>
          )}
        </div>
      )}

      {lastEntry && decision?.action !== 'ENTER' && (
        <div data-testid="up-dip-last-entry" className="text-2xs text-gray-400 mb-2">
          Last ENTER signal {when(lastEntry.at)} · BTC {lastEntry.btc?.toLocaleString()} · Up {k(lastEntry.contract.floor)}–{k(lastEntry.contract.ceiling)}{lastEntry.bookHeld && ' · paper book was already holding'}
        </div>
      )}

      {hasSignal && book && (pos || book.action !== decision.action) && (
        <div data-testid="up-dip-book" className="text-2xs mb-2">
          <span className="text-gray-400">Paper book: </span>{book.action.replace('_', ' ')}{book.reasons?.[0] && ` · ${book.reasons[0]}`}
        </div>
      )}

      {pos && (
        <div className="bg-gray-900 rounded-sm px-2 py-1.5 mb-2 text-xs">
          <div className="text-gray-400 text-2xs">Paper position{data.needsReset && ` · frozen ${when(data.frozenAt)}, no longer tracked`}</div>
          <div className="flex justify-between">
            <span>Up {k(pos.contract.floor)}–{k(pos.contract.ceiling)} ×{pos.contracts} @ {pos.entryPrice?.toLocaleString()}</span>
            <span className={`font-mono ${pnlColor(pos.pnl)}`}>{signedUsd(pos.pnl)}</span>
          </div>
          <div className="text-2xs text-gray-400">cost {usd(pos.cost)} · opened {when(pos.openedAt)}</div>
        </div>
      )}

      {s && (
        <div className="grid grid-cols-3 gap-1.5 mb-2 text-xs">
          <div className="bg-gray-900 rounded-sm px-2 py-1">
            <div className="text-gray-400 text-2xs">Paper P&L</div>
            <div className={`font-mono font-semibold ${pnlColor(s.pnl)}`}>{signedUsd(s.pnl)}</div>
          </div>
          <div className="bg-gray-900 rounded-sm px-2 py-1">
            <div className="text-gray-400 text-2xs">W/L</div>
            <div className="font-mono">{s.wins}/{s.losses}</div>
          </div>
          <div className="bg-gray-900 rounded-sm px-2 py-1">
            <div className="text-gray-400 text-2xs">Worst</div>
            <div className={`font-mono ${pnlColor(s.worst)}`}>{signedUsd(s.worst)}</div>
          </div>
        </div>
      )}

      <CyclesTable cycles={data?.cycles} />

      {data?.backtest && (
        <div className="text-2xs border-t border-gray-700 pt-1.5 space-y-0.5">
          <div className="text-gray-400">Backtest, all dips (same rules, fees, knock-outs, {data.backtest.spread > 0 ? `spread ${formatSpread(data.backtest.spread)} a side` : 'no spread'}{LISTING_LABEL[data.backtest.listing] ?? ''}):</div>
          <BacktestLine label={`Train to ${data.backtest.split?.slice(0, 10)}`} s={data.backtest.train} />
          <BacktestLine label="Held out after" s={data.backtest.test} />
          <div className="text-amber-300/80">High win rate, rare full-cost floor knock-outs.</div>
        </div>
      )}
      {data && <div className="text-2xs text-amber-300/80 mt-1">This rule lost money out of sample after costs. Watch, don&apos;t trade it.</div>}
      <ArchivedBook archived={data?.archived} />
      {data?.startedAt && <div className="text-2xs text-gray-400 mt-1">Paper tracking since {when(data.startedAt)}{s?.gaps > 0 && <span className="text-amber-300/80"> · {s.gaps} candle gap{s.gaps === 1 ? '' : 's'} (restart outage, bars missed)</span>}</div>}
    </div>
    {data?.shadow && <ShadowBook book={data.shadow} />}
    </details>
    </>
  )
}

export default memo(UpDipPanel)
