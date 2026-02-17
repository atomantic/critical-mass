import { useState, useEffect, useRef, useMemo } from 'react'
import { Wifi, WifiOff } from 'lucide-react'
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip
} from 'recharts'

const MAX_HISTORY = 900

/**
 * Format BTC price with 2 decimal places
 * @param {number} value
 * @returns {string}
 */
const formatPrice = (value) => {
  if (!value) return '$0.00'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value)
}

/**
 * Format countdown as MM:SS
 * @param {number} seconds
 * @returns {string}
 */
const formatCountdown = (seconds) => {
  if (seconds <= 0) return '00:00'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/**
 * Format time for X axis
 * @param {number} ts - Unix timestamp
 * @returns {string}
 */
const formatTime = (ts) =>
  new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })

/**
 * Parse strike price from market title
 * @param {string} title
 * @returns {number | null}
 */
export const parseStrikeFromTitle = (title) => {
  const match = title?.match(/\$([0-9,]+(?:\.[0-9]+)?)/i)
  return match ? parseFloat(match[1].replace(/,/g, '')) : null
}

/**
 * Custom tooltip for the price chart
 */
const ChartTooltip = ({ active, payload, strike }) => {
  if (!active || !payload?.[0]) return null
  const data = payload[0].payload
  const { time, price, coinbase, kraken } = data
  const upDown = strike ? (price >= strike ? 'Up' : 'Down') : null
  const upDownColor = upDown === 'Up' ? 'text-green-400' : 'text-red-400'
  const divergence = coinbase && kraken ? Math.abs(coinbase - kraken) : null
  return (
    <div className="bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-xs shadow-lg">
      <div className="text-gray-400 mb-1">{formatTime(time)}</div>
      <div className="text-orange-400 font-semibold">Composite {formatPrice(price)}</div>
      {coinbase && <div className="text-blue-400">Coinbase {formatPrice(coinbase)}</div>}
      {kraken && <div className="text-purple-400">Kraken {formatPrice(kraken)}</div>}
      {divergence != null && divergence > 0 && (
        <div className={`mt-1 ${divergence > 50 ? 'text-red-400' : divergence > 20 ? 'text-yellow-400' : 'text-gray-500'}`}>
          Divergence ${divergence.toFixed(2)}
        </div>
      )}
      {upDown && <div className={`font-semibold mt-1 ${upDownColor}`}>{upDown} {strike ? `(vs $${strike.toLocaleString()})` : ''}</div>}
    </div>
  )
}

/**
 * Exchange price label rendered at the left edge of the chart
 */
const ExchangePriceLabel = ({ viewBox, name, value, color }) => {
  if (!viewBox || !value) return null
  const label = `${name} ${formatPrice(value)}`
  return (
    <g>
      <rect
        x={viewBox.x + 2}
        y={viewBox.y - 9}
        width={label.length * 6.2 + 10}
        height={18}
        rx={3}
        fill="#111827"
        fillOpacity={0.85}
      />
      <text
        x={viewBox.x + 7}
        y={viewBox.y + 4}
        textAnchor="start"
        fill={color}
        fontSize={10}
        fontWeight="600"
      >
        {label}
      </text>
    </g>
  )
}

/**
 * Floating current-price label rendered at the right edge of the chart
 */
const CurrentPriceLabel = ({ viewBox, value, color = '#f97316' }) => {
  if (!viewBox || !value) return null
  return (
    <g>
      <rect
        x={viewBox.x + viewBox.width - 80}
        y={viewBox.y - 10}
        width={76}
        height={20}
        rx={4}
        fill="#1f2937"
        stroke={color}
        strokeWidth={1}
      />
      <text
        x={viewBox.x + viewBox.width - 42}
        y={viewBox.y + 4}
        textAnchor="middle"
        fill={color}
        fontSize={11}
        fontWeight="bold"
      >
        {formatPrice(value)}
      </text>
    </g>
  )
}

/**
 * Strike threshold label -- rendered as a pill spanning the chart width
 */
const StrikeLabel = ({ viewBox, value }) => {
  if (!viewBox || !value) return null
  const text = `${formatPrice(value)} or above`
  return (
    <g>
      <rect
        x={viewBox.x + viewBox.width / 2 - 80}
        y={viewBox.y - 11}
        width={160}
        height={22}
        rx={4}
        fill="#1f2937"
        stroke="#facc15"
        strokeWidth={1}
      />
      <text
        x={viewBox.x + viewBox.width / 2}
        y={viewBox.y + 4}
        textAnchor="middle"
        fill="#facc15"
        fontSize={11}
        fontWeight="bold"
      >
        {text}
      </text>
    </g>
  )
}

/**
 * Live BTC market chart with real-time price, strike line, countdown, and Yes/No prices
 */
export default function LiveBTCChart({
  btcPrice,
  kalshiPrices,
  positions,
  diagnostics,
  coinbaseConnected,
  chartOnly = false,
  activeMarketOverride,
  timeLeftOverride,
  orderBook,
  compositePrice
}) {
  const [history, setHistory] = useState([])
  const lastPushRef = useRef(0)
  const [internalActiveMarket, setInternalActiveMarket] = useState(null)
  const [internalTimeLeft, setInternalTimeLeft] = useState(0)
  const prevPriceRef = useRef(null)

  // Use override or internal state
  const activeMarket = activeMarketOverride ?? internalActiveMarket
  const timeLeft = timeLeftOverride ?? internalTimeLeft

  // Accumulate price history with per-exchange breakdown
  const compositePriceRef = useRef(null)
  useEffect(() => {
    compositePriceRef.current = compositePrice
  }, [compositePrice])

  useEffect(() => {
    const price = btcPrice?.price
    if (!price) return

    const now = Date.now()
    if (now - lastPushRef.current < 1000) return
    lastPushRef.current = now

    const cp = compositePriceRef.current
    const coinbase = cp?.byExchange?.coinbase?.price ?? null
    const kraken = cp?.byExchange?.kraken?.price ?? null
    const compositeVal = cp?.price ?? null

    setHistory(prev => {
      const next = [...prev, {
        time: now,
        price: compositeVal || price,
        coinbase,
        kraken
      }]
      return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next
    })
  }, [btcPrice?.price])

  // Derive active market from diagnostics (only when no override)
  useEffect(() => {
    if (activeMarketOverride || !diagnostics?.length) return

    const btcDiags = diagnostics
      .filter(d => d.ticker?.startsWith('KX') && d.ttl > 0)
      .sort((a, b) => a.ttl - b.ttl)

    const nearest = btcDiags[0]
    if (!nearest) return

    setInternalActiveMarket(prev => {
      if (prev?.ticker === nearest.ticker) return prev
      return {
        ticker: nearest.ticker,
        strike: nearest.strike,
        closeTime: Date.now() + nearest.ttl * 1000,
        ttl: nearest.ttl
      }
    })
  }, [diagnostics, activeMarketOverride])

  // Fallback: fetch from REST API if no diagnostics and no override
  useEffect(() => {
    if (activeMarketOverride || diagnostics?.length > 0) return

    let cancelled = false
    const fetchMarket = async () => {
      const res = await fetch('/api/kalshi/markets?type=crypto')
      if (!res.ok || cancelled) return
      const data = await res.json().catch(() => null)
      if (!data) return
      const now = Date.now()
      const btcMarkets = (data.markets || [])
        .filter(m => m.ticker?.startsWith('KX') && new Date(m.close_time).getTime() > now)
        .sort((a, b) => new Date(a.close_time).getTime() - new Date(b.close_time).getTime())

      const nearest = btcMarkets[0]
      if (!nearest || cancelled) return

      const strike = parseStrikeFromTitle(nearest.title)
      const closeTime = new Date(nearest.close_time).getTime()
      setInternalActiveMarket({ ticker: nearest.ticker, strike, closeTime, title: nearest.title })
    }

    fetchMarket()
    const interval = setInterval(fetchMarket, 120000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [diagnostics?.length, activeMarketOverride])

  // Update TTL from diagnostics on each eval cycle (only when no override)
  useEffect(() => {
    if (activeMarketOverride) return
    if (!internalActiveMarket?.ticker || !diagnostics?.length) return
    const match = diagnostics.find(d => d.ticker === internalActiveMarket.ticker)
    if (match?.ttl > 0) {
      setInternalActiveMarket(prev => prev ? { ...prev, closeTime: Date.now() + match.ttl * 1000 } : prev)
    }
  }, [diagnostics, internalActiveMarket?.ticker, activeMarketOverride])

  // Countdown timer (only when no timeLeftOverride)
  useEffect(() => {
    if (timeLeftOverride != null) return
    if (!activeMarket?.closeTime) { setInternalTimeLeft(0); return }
    const tick = () => setInternalTimeLeft(Math.max(0, Math.round((activeMarket.closeTime - Date.now()) / 1000)))
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [activeMarket?.closeTime, timeLeftOverride])

  // Price change calculation
  const priceChange = useMemo(() => {
    const current = btcPrice?.price
    const prev = prevPriceRef.current
    if (current && prev) return current - prev
    return 0
  }, [btcPrice?.price])

  useEffect(() => {
    if (btcPrice?.price) prevPriceRef.current = btcPrice.price
  }, [btcPrice?.price])

  const currentPrice = btcPrice?.price || 0
  const strike = activeMarket?.strike
  const coinbasePrice = compositePrice?.byExchange?.coinbase?.price ?? null
  const krakenPrice = compositePrice?.byExchange?.kraken?.price ?? null

  const marketPrice = activeMarket?.ticker ? kalshiPrices?.get(activeMarket.ticker) : null
  const yesAsk = marketPrice?.yesAsk ?? null
  const noAsk = yesAsk != null ? 100 - yesAsk : null

  const matchingPosition = useMemo(() => {
    if (!activeMarket?.ticker || !positions?.length) return null
    return positions.find(p => p.ticker === activeMarket.ticker)
  }, [activeMarket?.ticker, positions])

  // Y-axis domain (include all exchange prices)
  const yDomain = useMemo(() => {
    if (history.length === 0) return ['auto', 'auto']
    const prices = history.flatMap(h => [h.price, h.coinbase, h.kraken].filter(Boolean))
    if (strike) prices.push(strike)
    const min = Math.min(...prices)
    const max = Math.max(...prices)
    const padding = (max - min) * 0.15 || 50
    return [Math.floor(min - padding), Math.ceil(max + padding)]
  }, [history, strike])

  const countdownColor = timeLeft > 300 ? 'text-green-400' : timeLeft > 60 ? 'text-yellow-400' : 'text-red-400'
  const countdownPulse = timeLeft > 0 && timeLeft <= 60 ? 'animate-pulse' : ''
  const changeColor = btcPrice?.priceChange >= 0 ? 'text-green-400' : 'text-red-400'
  const changeArrow = btcPrice?.priceChange >= 0 ? '▲' : '▼'
  const changeAmount = Math.abs(btcPrice?.priceChange || 0)

  const isAboveStrike = strike && currentPrice > 0 && currentPrice >= strike
  const areaColor = strike && currentPrice > 0
    ? (isAboveStrike ? '#22c55e' : '#ef4444')
    : '#f97316'

  // Chart-only mode: just the chart, taller, clean
  if (chartOnly) {
    return (
      <div className="h-52 md:h-72" style={{ minWidth: 0 }}>
        {history.length > 1 ? (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={history} margin={{ top: 5, right: 50, bottom: 0, left: 5 }}>
              <defs>
                <linearGradient id="btcGradientChartOnly" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={areaColor} stopOpacity={0.15} />
                  <stop offset="95%" stopColor={areaColor} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="time"
                tickFormatter={formatTime}
                stroke="#6b7280"
                tick={{ fontSize: 10 }}
                minTickGap={60}
              />
              <YAxis
                domain={yDomain}
                tickFormatter={(v) => `$${v.toLocaleString()}`}
                stroke="#6b7280"
                tick={{ fontSize: 10 }}
                width={75}
              />
              <Tooltip content={<ChartTooltip strike={strike} />} />
              {strike && (
                <ReferenceLine
                  y={strike}
                  stroke="#facc15"
                  strokeWidth={2}
                  strokeOpacity={0.9}
                  label={<StrikeLabel value={strike} />}
                />
              )}
              {currentPrice > 0 && (
                <ReferenceLine
                  y={currentPrice}
                  stroke={areaColor}
                  strokeDasharray="6 3"
                  strokeWidth={1.5}
                  strokeOpacity={0.8}
                  label={<CurrentPriceLabel value={currentPrice} color={areaColor} />}
                />
              )}
              {/* Order book walls near strike */}
              {orderBook?.walls?.map((wall, i) => (
                <ReferenceLine
                  key={`wall-${i}`}
                  y={wall.price}
                  stroke={wall.side === 'bid' ? '#22c55e' : '#ef4444'}
                  strokeDasharray="3 3"
                  strokeOpacity={0.5}
                  label={{
                    value: `${wall.side === 'bid' ? 'B' : 'A'} ${wall.size.toFixed(1)}`,
                    position: 'left',
                    fill: wall.side === 'bid' ? '#22c55e' : '#ef4444',
                    fontSize: 9
                  }}
                />
              ))}
              {/* Exchange price labels on chart */}
              {coinbasePrice && (
                <ReferenceLine
                  y={coinbasePrice}
                  stroke="none"
                  label={<ExchangePriceLabel name="Coinbase" value={coinbasePrice} color="#60a5fa" />}
                />
              )}
              {krakenPrice && (
                <ReferenceLine
                  y={krakenPrice}
                  stroke="none"
                  label={<ExchangePriceLabel name="Kraken" value={krakenPrice} color="#a78bfa" />}
                />
              )}
              {/* Composite price area fill */}
              <Area
                type="monotone"
                dataKey="price"
                stroke="none"
                fill="url(#btcGradientChartOnly)"
                dot={false}
                isAnimationActive={false}
              />
              {/* Individual exchange lines */}
              <Line
                type="monotone"
                dataKey="coinbase"
                stroke="#60a5fa"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="kraken"
                stroke="#a78bfa"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
              {/* Composite price line on top */}
              <Line
                type="monotone"
                dataKey="price"
                stroke={areaColor}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500 text-sm">
            Waiting for price data...
          </div>
        )}
        {/* Chart legend */}
        <div className="flex flex-wrap items-center gap-2 md:gap-4 mt-1 text-[11px] text-gray-500">
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-0.5 rounded" style={{ backgroundColor: areaColor }} />
            Composite
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-0.5 rounded bg-blue-400" />
            Coinbase
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-0.5 rounded bg-purple-400" />
            Kraken
          </span>
          {strike && (
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-0.5 rounded bg-yellow-400" />
              Strike
            </span>
          )}
        </div>
      </div>
    )
  }

  // Full mode (original layout)
  return (
    <div className="bg-gray-800 rounded-lg p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="text-lg">₿</span>
          <span className="font-semibold text-gray-300">BTC</span>
          {activeMarket?.ticker && (
            <span className="text-xs text-gray-600 font-mono">{activeMarket.ticker}</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {timeLeft > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-gray-500">settles in</span>
              <span className={`text-sm font-mono font-semibold ${countdownColor} ${countdownPulse}`}>
                {formatCountdown(timeLeft)}
              </span>
            </div>
          )}
          <div className={`flex items-center gap-1 text-xs ${coinbaseConnected ? 'text-green-400' : 'text-gray-500'}`}>
            {coinbaseConnected ? <Wifi size={12} /> : <WifiOff size={12} />}
          </div>
        </div>
      </div>

      {/* Price display */}
      <div className="flex items-baseline gap-2 mb-3">
        <span className="text-2xl font-bold">{currentPrice ? formatPrice(currentPrice) : '---'}</span>
        {changeAmount > 0 && (
          <span className={`text-sm ${changeColor}`}>
            {changeArrow} {formatPrice(changeAmount)}
          </span>
        )}
      </div>

      {/* Chart */}
      <div className="h-48" style={{ minWidth: 0 }}>
        {history.length > 1 ? (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={history} margin={{ top: 5, right: 45, bottom: 0, left: 5 }}>
              <defs>
                <linearGradient id="btcGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={areaColor} stopOpacity={0.15} />
                  <stop offset="95%" stopColor={areaColor} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="time"
                tickFormatter={formatTime}
                stroke="#6b7280"
                tick={{ fontSize: 10 }}
                minTickGap={60}
              />
              <YAxis
                domain={yDomain}
                tickFormatter={(v) => `$${v.toLocaleString()}`}
                stroke="#6b7280"
                tick={{ fontSize: 10 }}
                width={75}
              />
              <Tooltip content={<ChartTooltip strike={strike} />} />
              {strike && (
                <ReferenceLine
                  y={strike}
                  stroke="#facc15"
                  strokeWidth={2}
                  strokeOpacity={0.9}
                  label={<StrikeLabel value={strike} />}
                />
              )}
              <Area
                type="monotone"
                dataKey="price"
                stroke="none"
                fill="url(#btcGradient)"
                dot={false}
                isAnimationActive={false}
              />
              <Line type="monotone" dataKey="coinbase" stroke="#60a5fa" strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
              <Line type="monotone" dataKey="kraken" stroke="#a78bfa" strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
              <Line type="monotone" dataKey="price" stroke={areaColor} strokeWidth={2} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500 text-sm">
            Waiting for price data...
          </div>
        )}
      </div>

      {/* Bottom bar: Yes/No + Position */}
      <div className="flex items-center gap-3 mt-3 pt-3 border-t border-gray-700">
        {yesAsk !== null ? (
          <>
            <span className="px-3 py-1.5 rounded bg-green-900/40 border border-green-700/50 text-green-400 text-sm font-semibold">
              ▲ Up {yesAsk}¢
            </span>
            <span className="px-3 py-1.5 rounded bg-red-900/40 border border-red-700/50 text-red-400 text-sm font-semibold">
              ▼ Down {noAsk}¢
            </span>
          </>
        ) : (
          <span className="text-xs text-gray-500">No market prices</span>
        )}

        <div className="ml-auto text-sm text-gray-400">
          {matchingPosition ? (
            <span className={matchingPosition.side === 'yes' || matchingPosition.position > 0 ? 'text-green-400' : 'text-red-400'}>
              {matchingPosition.side === 'yes' || matchingPosition.position > 0
                ? `${matchingPosition.contracts || Math.abs(matchingPosition.position)} Up (${matchingPosition.avgCost || matchingPosition.average_price}¢)`
                : `${matchingPosition.contracts || Math.abs(matchingPosition.position)} Down (${matchingPosition.avgCost || matchingPosition.average_price}¢)`
              }
            </span>
          ) : (
            <span className="text-gray-600">No position</span>
          )}
        </div>
      </div>
    </div>
  )
}
