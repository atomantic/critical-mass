import { useState, useEffect, useMemo } from 'react'
import { ComposedChart, Area, Line, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer, CartesianGrid } from 'recharts'
import { BarChart3 } from 'lucide-react'

const MAX_POINTS = 300

function formatPrice(value) {
  if (value == null) return ''
  return `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

export default function PriceChart({ tick, indicators, contract }) {
  const [priceHistory, setPriceHistory] = useState([])

  // Accumulate price points from tick data
  useEffect(() => {
    if (!tick?.price) return
    setPriceHistory(prev => {
      const point = {
        time: Date.now(),
        price: tick.price,
        bollingerUpper: null,
        bollingerLower: null,
        bollingerMiddle: null,
        vwap: null,
      }
      // Overlay Bollinger from indicators if available (use 5m timeframe)
      const tf = indicators?.['5m'] || indicators?.['3m'] || indicators?.['1m']
      const bb = tf?.bollingerBands || tf?.bollinger
      if (bb) {
        point.bollingerUpper = bb.upper
        point.bollingerLower = bb.lower
        point.bollingerMiddle = bb.middle
      }
      if (tf?.vwap) {
        point.vwap = tf.vwap
      }
      const next = [...prev, point]
      return next.length > MAX_POINTS ? next.slice(-MAX_POINTS) : next
    })
  }, [tick?.price, indicators])

  const chartData = useMemo(() => {
    return priceHistory.map(p => ({
      ...p,
      label: new Date(p.time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
    }))
  }, [priceHistory])

  const domain = useMemo(() => {
    if (!chartData.length) return ['auto', 'auto']
    const prices = chartData.map(d => d.price).filter(Boolean)
    const uppers = chartData.map(d => d.bollingerUpper).filter(Boolean)
    const lowers = chartData.map(d => d.bollingerLower).filter(Boolean)
    const all = [...prices, ...uppers, ...lowers]
    if (contract?.target) all.push(contract.target)
    if (contract?.stop) all.push(contract.stop)
    if (all.length === 0) return ['auto', 'auto']
    const min = Math.min(...all)
    const max = Math.max(...all)
    const padding = (max - min) * 0.05 || 50
    return [min - padding, max + padding]
  }, [chartData, contract])

  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      <div className="flex items-center gap-2 mb-3">
        <BarChart3 size={16} className="text-blue-400" />
        <h3 className="text-sm font-semibold">Price Chart</h3>
        {tick?.price && (
          <span className="ml-auto text-sm font-mono text-white">{formatPrice(tick.price)}</span>
        )}
      </div>

      {chartData.length < 2 ? (
        <div className="text-gray-500 text-sm text-center py-12">Waiting for price data...</div>
      ) : (
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={chartData} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: '#9ca3af' }}
              interval="preserveStartEnd"
            />
            <YAxis
              domain={domain}
              tick={{ fontSize: 10, fill: '#9ca3af' }}
              tickFormatter={formatPrice}
              width={70}
            />
            <Tooltip
              contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px', fontSize: '12px' }}
              labelStyle={{ color: '#9ca3af' }}
              formatter={(value, name) => {
                const labels = {
                  price: 'Price',
                  bollingerUpper: 'BB Upper',
                  bollingerLower: 'BB Lower',
                  bollingerMiddle: 'BB Middle',
                  vwap: 'VWAP',
                }
                return [formatPrice(value), labels[name] || name]
              }}
            />

            {/* Bollinger Band fill */}
            <Area
              type="monotone"
              dataKey="bollingerUpper"
              stroke="none"
              fill="none"
              connectNulls={false}
            />
            <Area
              type="monotone"
              dataKey="bollingerLower"
              stroke="none"
              fill="rgba(99, 102, 241, 0.08)"
              connectNulls={false}
            />

            {/* Bollinger lines */}
            <Line type="monotone" dataKey="bollingerUpper" stroke="#6366f1" strokeWidth={1} strokeDasharray="3 3" dot={false} connectNulls={false} />
            <Line type="monotone" dataKey="bollingerLower" stroke="#6366f1" strokeWidth={1} strokeDasharray="3 3" dot={false} connectNulls={false} />
            <Line type="monotone" dataKey="bollingerMiddle" stroke="#818cf8" strokeWidth={1} strokeDasharray="5 5" dot={false} connectNulls={false} />

            {/* VWAP */}
            <Line type="monotone" dataKey="vwap" stroke="#f59e0b" strokeWidth={1} strokeDasharray="4 4" dot={false} connectNulls={false} />

            {/* Price line */}
            <Line type="monotone" dataKey="price" stroke="#3b82f6" strokeWidth={2} dot={false} />

            {/* Target reference line */}
            {contract?.target && (
              <ReferenceLine y={contract.target} stroke="#10b981" strokeDasharray="3 3" label={{ value: `Target ${formatPrice(contract.target)}`, position: 'right', fontSize: 10, fill: '#10b981' }} />
            )}

            {/* Stop reference line */}
            {contract?.stop && (
              <ReferenceLine y={contract.stop} stroke="#ef4444" strokeDasharray="3 3" label={{ value: `Stop ${formatPrice(contract.stop)}`, position: 'right', fontSize: 10, fill: '#ef4444' }} />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
