import { memo, useMemo, useState } from 'react'
import Button from '../ui/Button'
import { CartesianChart } from '../charts/primitives/CartesianChart'
import HeikinAshiRenderer from '../charts/HeikinAshiRenderer'
import VolumeRenderer from '../charts/VolumeRenderer'
import { AXIS_TICK, BTC_TOOLTIP_STYLE, GRID, colors, formatBTCPrice } from '../charts/chartUtils'
import useBtcSeconds from '../../hooks/useBtcSeconds'
import { formatUsd } from '../../utils/format.mjs'
import { INTERVALS, MOVE_SECONDS, RANGES, buildSlots, contractBounds, freshness, isAllowed, priceMoves } from '../../utils/btcSeconds.mjs'

const RANGE_LABELS = { 300: '5m', 900: '15m', 3600: '1h' }
const OHLC = { open: 'open', high: 'high', low: 'low', close: 'close' }
const FRESHNESS_COLOR = { live: 'text-green-400', amber: 'text-amber-400', stale: 'text-red-400' }
const SERIES = [
  { dataKey: 'indexValue', name: 'Index (proxy)', stroke: colors.yellow, strokeWidth: 1 },
  // Transparent: the candles draw the price, this only feeds the tooltip.
  { dataKey: 'close', name: 'Coinbase', stroke: 'transparent' },
]
const MAIN_MARGIN = { top: 5, right: 5, bottom: 0, left: 5 }
const VOLUME_MARGIN = { top: 2, right: 5, bottom: 0, left: 5 }
const VOLUME_X_AXIS = { dataKey: 'chartIndex', hide: true }
const Y_WIDTH = 70

const usd0 = (value) => formatUsd(value, { decimals: 0 })
const signed = (value) => (value === null ? '---' : `${value < 0 ? '−' : '+'}${usd0(Math.abs(value))}`)
const clock = (t) => new Date(t).toLocaleTimeString('en-US', { hour12: false })
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`

function freshnessText(state, age) {
  if (state === 'stale') return age === null ? 'stale' : `stale ${seconds(age)}`
  return state === 'live' ? `live ${seconds(age)}` : `slow ${seconds(age)}`
}

// Fits visible candles and index values only, so a distant bound never flattens the chart.
function priceDomain(slots) {
  const values = slots.flatMap(s => [s.high, s.low, s.indexValue]).filter(v => v !== null)
  if (!values.length) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const pad = (max - min) * 0.05 || 1
  return [min - pad, max + pad]
}

const SecondPricePlots = memo(function SecondPricePlots({ slots, floor, ceiling }) {
  const domain = useMemo(() => priceDomain(slots), [slots])
  const xAxis = useMemo(() => ({
    dataKey: 'chartIndex', tickFormatter: i => (slots[i] ? clock(slots[i].t) : ''), tick: AXIS_TICK, interval: 'preserveStartEnd',
  }), [slots])
  const yAxes = useMemo(() => [{ domain: domain ?? ['auto', 'auto'], allowDataOverflow: true, tick: AXIS_TICK, tickFormatter: formatBTCPrice, width: Y_WIDTH }], [domain])
  const volumeYAxes = useMemo(() => [{
    domain: [0, Math.max(...slots.map(s => s.buyVolume + s.sellVolume), 0) || 1], tick: AXIS_TICK, tickFormatter: v => v.toFixed(1), width: Y_WIDTH,
  }], [slots])
  const tooltip = useMemo(() => ({
    labelFormatter: i => (slots[i] ? clock(slots[i].t) : ''),
    contentStyle: BTC_TOOLTIP_STYLE,
    labelStyle: { color: '#9ca3af' },
    formatter: (value, name) => [formatBTCPrice(value), name],
  }), [slots])
  // ReferenceLine itself draws nothing for a level outside the axis.
  const referenceLines = useMemo(() => floor == null ? [] : [
    { y: floor, stroke: colors.red, strokeDasharray: '3 3', label: { value: 'Floor', fontSize: 10 } },
    { y: ceiling, stroke: colors.green, strokeDasharray: '3 3', label: { value: 'Ceiling', fontSize: 10 } },
  ], [floor, ceiling])

  return domain && (
    <>
      <CartesianChart
        data={slots} height={240} margin={MAIN_MARGIN} grid={GRID} xAxis={xAxis} yAxes={yAxes} tooltip={tooltip}
        series={SERIES} referenceLines={referenceLines} underlay={<HeikinAshiRenderer data={slots} fields={OHLC} />}
      />
      <CartesianChart
        data={slots} height={60} margin={VOLUME_MARGIN} xAxis={VOLUME_X_AXIS} yAxes={volumeYAxes} underlay={<VolumeRenderer data={slots} />}
      />
    </>
  )
})

/** Sub-minute BTC: Coinbase 1s candles and volume, the Crypto.com index, and contract distances. */
function SecondChart({ contract, held }) {
  const [interval, setIntervalSeconds] = useState(1)
  const [range, setRange] = useState(300)
  const { bars, index, nowMs, ages, error } = useBtcSeconds(range)

  const chooseInterval = (next) => {
    setIntervalSeconds(next)
    if (!isAllowed(next, range)) setRange(RANGES.filter(r => isAllowed(next, r)).at(-1))
  }

  const state = freshness(ages.coinbase)
  const stale = state === 'stale'
  const indexStale = freshness(ages.index) === 'stale'
  const price = bars.at(-1)?.close ?? null
  const indexValue = indexStale ? null : index.at(-1)?.value ?? null
  const moves = priceMoves(bars, { stale })
  const gap = stale || price === null || indexValue === null ? null : price - indexValue
  const bounds = contractBounds(held, contract, nowMs ?? 0)
  // Which price the app knocks out on is not established, so both are shown.
  const distances = (level) => `index ${signed(indexValue === null ? null : level - indexValue)} / Coinbase ${signed(stale || price === null ? null : level - price)}`

  // The clock ticks twice a second; slots only need to move when a slot boundary passes.
  const slotNow = nowMs === null ? null : Math.floor(nowMs / 1000) * 1000
  const slots = useMemo(
    () => (slotNow === null ? [] : buildSlots({ bars, index, interval, range, nowMs: slotNow })),
    [bars, index, interval, range, slotNow],
  )
  const { floor, ceiling } = bounds ?? {}

  return (
    <section aria-label="BTC 1-second chart" className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-2">
        <h3 className="text-sm font-semibold">BTC {interval}s</h3>
        <div className="flex gap-1">
          {INTERVALS.map(i => (
            <Button key={i} onClick={() => chooseInterval(i)} aria-pressed={interval === i} variant={interval === i ? 'primary' : 'secondary'} size="xs">{i}s</Button>
          ))}
        </div>
        <div className="flex gap-1">
          {RANGES.map(r => (
            <Button key={r} onClick={() => setRange(r)} disabled={!isAllowed(interval, r)} aria-pressed={range === r} variant={range === r ? 'soft-info' : 'secondary'} size="xs">{RANGE_LABELS[r]}</Button>
          ))}
        </div>
        <span data-testid="second-freshness" className={`ml-auto text-xs font-mono ${FRESHNESS_COLOR[state]}`}>● {freshnessText(state, ages.coinbase)}</span>
      </div>

      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-2 text-xs font-mono">
        <span className={`text-sm ${stale ? 'text-gray-400' : 'text-white'}`}>
          {usd0(price)}{moves[10] !== null && (moves[10] < 0 ? ' ▼' : ' ▲')}
        </span>
        <span data-testid="second-moves" className="text-gray-300">{MOVE_SECONDS.map(s => `${s}s ${signed(moves[s])}`).join(' ')}</span>
        <span data-testid="second-index" className={indexStale ? 'text-red-400' : 'text-yellow-500'}>Index {usd0(indexValue)} (proxy) gap {signed(gap)}</span>
      </div>

      {error && <div role="alert" className="text-red-400 text-xs mb-2">1-second feed: {error}</div>}
      {!error && !bars.length && <div className="text-gray-400 text-sm text-center py-12">Waiting for trades…</div>}

      <SecondPricePlots slots={slots} floor={floor} ceiling={ceiling} />

      {bounds && (
        <div data-testid="second-bounds" className="mt-2 text-xs font-mono text-gray-300">
          floor {distances(bounds.floor)} · ceiling {distances(bounds.ceiling)} ({bounds.label}){bounds.note && ` — ${bounds.note}`}
        </div>
      )}
    </section>
  )
}

export default memo(SecondChart)
