import { useState, useEffect, useRef, useMemo } from 'react'
import { Wifi, WifiOff } from 'lucide-react'
import BTCPriceChart from '../charts/BTCPriceChart'

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
 * Parse strike price from market title
 * @param {string} title
 * @returns {number | null}
 */
export const parseStrikeFromTitle = (title) => {
  const match = title?.match(/\$([0-9,]+(?:\.[0-9]+)?)/i)
  return match ? parseFloat(match[1].replace(/,/g, '')) : null
}

const EXCHANGE_LINES = [
  { dataKey: 'coinbase', stroke: '#60a5fa', label: 'Coinbase' },
  { dataKey: 'kraken', stroke: '#a78bfa', label: 'Kraken' },
]

/**
 * Live BTC market chart with real-time price, strike line, countdown, and Yes/No prices.
 * Uses shared BTCPriceChart for the chart section with coinbase candle data.
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
  const [internalActiveMarket, setInternalActiveMarket] = useState(null)
  const [internalTimeLeft, setInternalTimeLeft] = useState(0)
  const prevPriceRef = useRef(null)

  // Use override or internal state
  const activeMarket = activeMarketOverride ?? internalActiveMarket
  const timeLeft = timeLeftOverride ?? internalTimeLeft

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

  const countdownColor = timeLeft > 300 ? 'text-green-400' : timeLeft > 60 ? 'text-yellow-400' : 'text-red-400'
  const countdownPulse = timeLeft > 0 && timeLeft <= 60 ? 'animate-pulse' : ''
  const changeColor = btcPrice?.priceChange >= 0 ? 'text-green-400' : 'text-red-400'
  const changeArrow = btcPrice?.priceChange >= 0 ? '▲' : '▼'
  const changeAmount = Math.abs(btcPrice?.priceChange || 0)

  // Reference lines: strike + order book walls
  const referenceLines = useMemo(() => {
    const lines = []
    if (strike) {
      lines.push({
        y: strike,
        stroke: '#facc15',
        strokeDasharray: '6 3',
        label: `Strike ${formatPrice(strike)}`,
        labelFill: '#facc15',
      })
    }
    if (orderBook?.walls) {
      for (const wall of orderBook.walls) {
        lines.push({
          y: wall.price,
          stroke: wall.side === 'bid' ? '#22c55e' : '#ef4444',
          strokeDasharray: '3 3',
          label: `${wall.side === 'bid' ? 'B' : 'A'} ${wall.size.toFixed(1)}`,
          labelFill: wall.side === 'bid' ? '#22c55e' : '#ef4444',
        })
      }
    }
    return lines
  }, [strike, orderBook?.walls])

  // Exchange tick data for per-exchange lines on chart
  const exchangeTickData = useMemo(() => ({
    coinbase: coinbasePrice,
    kraken: krakenPrice,
  }), [coinbasePrice, krakenPrice])

  // Chart-only mode: just the shared chart
  if (chartOnly) {
    return (
      <div>
        <BTCPriceChart
          exchange="coinbase"
          tickPrice={compositePrice?.price || currentPrice}
          tickTimestamp={undefined}
          exchangeLines={EXCHANGE_LINES}
          exchangeTickData={exchangeTickData}
          referenceLines={referenceLines}
          showViewSelector={false}
          defaultView="1h"
          height={288}
        />
        {/* Chart legend */}
        <div className="flex flex-wrap items-center gap-2 md:gap-4 mt-1 text-[11px] text-gray-500">
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-0.5 rounded bg-blue-500" />
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

  // Full mode with header, chart, and footer
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

      {/* Chart (using shared BTCPriceChart) */}
      <BTCPriceChart
        exchange="coinbase"
        tickPrice={compositePrice?.price || currentPrice}
        tickTimestamp={Date.now()}
        exchangeLines={EXCHANGE_LINES}
        exchangeTickData={exchangeTickData}
        referenceLines={referenceLines}
        showViewSelector={false}
        defaultView="1h"
        height={192}
      />

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
