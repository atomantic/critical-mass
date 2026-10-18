import React from 'react'
import { formatPriceByMagnitude } from '../charts/chartUtils'

export default function VolatilityMetrics({ market }) {
  return (
    <>
      <div className="bg-gray-800 rounded-lg p-3">
        <h3 className="text-xs font-medium text-gray-400 mb-2">Volatility</h3>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <div className="flex justify-between">
            <span className="text-gray-400">ATR 1m</span>
            <span className="text-white font-mono">${formatPriceByMagnitude(market.atr1m)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">ATR 5m</span>
            <span className="text-white font-mono">${formatPriceByMagnitude(market.atr5m)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">VWAP</span>
            <span className="text-white font-mono">${formatPriceByMagnitude(market.vwap)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">VWAP Dist</span>
            <span className={`font-mono ${Math.abs(market.vwapDistance || 0) > 1 ? 'text-yellow-400' : 'text-white'}`}>
              {market.vwapDistance?.toFixed(2) || '-'} ATR
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">RVol</span>
            <span className="text-white font-mono">{market.realizedVol?.toFixed(2) || '-'}%</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Expansion</span>
            <span className={`font-mono ${(market.realizedVol / market.volBaseline) > 1.5 ? 'text-yellow-400' : 'text-white'}`}>
              {market.volBaseline ? (market.realizedVol / market.volBaseline).toFixed(2) : '-'}x
            </span>
          </div>
        </div>
      </div>
    </>
  )
}
