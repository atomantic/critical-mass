import React, { useState, useEffect } from 'react'
import { resolveElapsedDisplay } from '../../utils/liveTimerElapsed.mjs'
import { formatCountdown } from '../../utils/countdown.mjs'
import { formatDuration } from './regimeFormat'
import { formatPriceByMagnitude } from '../charts/chartUtils'
import EntryStatusCard from './EntryStatusCard'
import CurrentRegimeCard from './CurrentRegimeCard'
import EntryModeCard from './EntryModeCard'

function LivePriceTicker({ price, prevPrice }) {
  const direction = price > prevPrice ? 'up' : price < prevPrice ? 'down' : 'none'
  const directionColors = {
    up: 'text-green-400',
    down: 'text-red-400',
    none: 'text-white',
  }

  return (
    <div className="flex items-center gap-1">
      <span className={`text-lg font-bold font-mono transition-colors duration-300 ${directionColors[direction]}`}>
        ${formatPriceByMagnitude(price)}
      </span>
      {direction !== 'none' && (
        <span className={`text-sm ${directionColors[direction]} animate-pulse`}>
          {direction === 'up' ? '▲' : '▼'}
        </span>
      )}
    </div>
  )
}

// Countdown/Timer display
function LiveTimer({ label, targetTime, elapsed, total, variant = 'countdown' }) {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [])

  if (variant === 'countdown' && targetTime) {
    const remaining = Math.max(0, targetTime - now)
    const progress = total ? Math.min(100, ((total - remaining) / total) * 100) : 0

    return (
      <div className="bg-gray-900 rounded-sm p-1.5">
        <div className="text-[10px] text-gray-400 mb-0.5">{label}</div>
        <div className="flex items-center gap-1">
          <span className="text-sm font-mono text-cyan-400">{formatCountdown(remaining, 'minutes')}</span>
          {remaining === 0 && <span className="text-[10px] text-yellow-400 animate-pulse">Ready</span>}
        </div>
        {total && (
          <div className="h-0.5 bg-gray-700 rounded-full mt-1 overflow-hidden">
            <div
              className="h-full bg-cyan-500 transition-all duration-1000"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
      </div>
    )
  }

  if (variant === 'elapsed') {
    const display = resolveElapsedDisplay(elapsed, now, formatDuration)
    return (
      <div className="bg-gray-900 rounded-sm p-1.5">
        <div className="text-[10px] text-gray-400 mb-0.5">{label}</div>
        <span className="text-sm font-mono text-gray-300">{display.primary}</span>
        {display.secondary && (
          <div className="text-[10px] text-gray-400">{display.secondary}</div>
        )}
      </div>
    )
  }

  return null
}
function TriggerDistance({ currentPrice, anchorPrice, atr, kFactor }) {
  if (!currentPrice || !atr || atr === 0) return null

  const triggerDistance = kFactor * atr
  const priceMove = anchorPrice ? Math.abs(currentPrice - anchorPrice) : 0
  const progress = anchorPrice ? Math.min(100, (priceMove / triggerDistance) * 100) : 0
  const distanceToTrigger = Math.max(0, triggerDistance - priceMove)

  return (
    <div className="bg-gray-900 rounded-sm p-1.5">
      <div className="text-[10px] text-gray-400 mb-0.5">ATR Trigger Distance</div>
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-gray-300">
          ${formatPriceByMagnitude(distanceToTrigger)} to go
        </span>
        <span className="text-[10px] text-gray-400">
          ({progress.toFixed(0)}%)
        </span>
      </div>
      <div className="h-1 bg-gray-700 rounded-full mt-0.5 overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${
            progress >= 100 ? 'bg-green-500 animate-pulse' : progress >= 75 ? 'bg-yellow-500' : 'bg-blue-500'
          }`}
          style={{ width: `${progress}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-gray-400 mt-0.5">
        <span>Anchor: ${formatPriceByMagnitude(anchorPrice)}</span>
        <span>Target: ±${formatPriceByMagnitude(triggerDistance)}</span>
      </div>
    </div>
  )
}

export default function LiveStatusBar({ asset, market, position, config, prevPrice, health, regime, celestial, macro, entryMode, ladder, autoSwitch }) {
  return (
    <div className="bg-gray-800 rounded-lg p-2 sm:p-3">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-2 sm:gap-3">
        {/* Live Price */}
        <div className="col-span-1">
          <span className="text-[10px] text-gray-400">{asset} Price</span>
          <LivePriceTicker
            price={market.lastPrice}
            prevPrice={prevPrice}
          />
          <div className="text-[10px] text-gray-400">
            Spread: ${formatPriceByMagnitude(market.spread)} ({market.spread && market.lastPrice ? ((market.spread / market.lastPrice) * 10000).toFixed(1) : '-'} bps)
          </div>
        </div>

        {/* Time Since Last Entry */}
        <div className="col-span-1">
          <LiveTimer
            label="Since Last Entry"
            elapsed={position.lastEntryTime}
            variant="elapsed"
          />
        </div>

        {/* Countdown to Max Interval */}
        <div className="col-span-1">
          <LiveTimer
            label="Max Interval Timer"
            targetTime={position.lastEntryTime ? position.lastEntryTime + (config?.maxIntervalMs || 3600000) : null}
            total={config?.maxIntervalMs || 3600000}
            variant="countdown"
          />
        </div>

        {/* ATR Trigger Distance */}
        <div className="col-span-1">
          <TriggerDistance
            currentPrice={market.lastPrice}
            anchorPrice={position.anchorPrice}
            atr={market.atr1m}
            kFactor={config?.kFactor || 0.6}
          />
        </div>

        {/* Entry Status */}
        <EntryStatusCard healthMode={health.mode} regimeMode={regime.mode} celestial={celestial} macroEnabled={config?.macroEnabled} maxCelestialBodies={config?.maxCelestialBodies} macro={macro} trendScale={config?.trendScale} />

        {/* Compact Current Regime */}
        <CurrentRegimeCard regime={regime} healthMode={health.mode} macroEnabled={config?.macroEnabled} macro={macro} />

        {/* Entry Mode */}
        <EntryModeCard entryMode={entryMode} ladder={ladder} autoSwitch={autoSwitch} ladderAutoSwitch={config?.ladderAutoSwitch} />

      </div>
    </div>

  )
}
