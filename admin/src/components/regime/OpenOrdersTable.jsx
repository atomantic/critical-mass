import React, { useMemo, useState } from 'react'
import { buildOpenOrderRelationIndex, deriveOpenOrderRows } from '../../utils/openOrderRelations.mjs'
import { DEFAULT_FEE_RATE_PER_SIDE } from '../../utils/openOrderEstimates.mjs'
import { getPriceDecimals, formatCurrency } from '../charts/chartUtils'
import { formatDuration, formatTimestamp } from './regimeFormat'

export const REGIME_ORDER_TOUCH_TARGET = 'min-h-11 min-w-11 inline-flex items-center justify-center regime-order-touch-target'

/**
 * RegimeDashboard "Open Orders" tables (sell/TP orders with their related buys,
 * then entry orders). Owns its own row-expansion state; all accounting comes
 * from the pure utils (openOrderRelations.mjs / openOrderEstimates.mjs).
 *
 * `liveFills` must be the UNFILTERED fill ledger: which buys a resting TP
 * covers must not change with the Filled Orders "current cycle" toggle (#700).
 */
function OpenOrdersTable({
  pendingOrdersList,
  liveFills,
  dryRunFilled,
  isDryRun,
  celestialBodies,
  position,
  config,
  market,
  asset,
  isRunning,
  openSearchId,
  setTpEditModal,
  setRollUpConfirm,
}) {
  const [expandedOrders, setExpandedOrders] = useState(new Set())
  // Historical fill scans depend only on the fill snapshot, never on the ~1s status tick.
  const relationIndex = useMemo(
    () => buildOpenOrderRelationIndex({ fills: liveFills, dryRunFilled, isDryRun }),
    [liveFills, dryRunFilled, isDryRun],
  )
  const bodyLookup = useMemo(() => new Map(celestialBodies.map(b => [b.tpOrderId, b])), [celestialBodies])

  if (pendingOrdersList.length === 0) {
    return <div className="text-gray-400 text-sm text-center py-4">No open orders</div>
  }

  const avgCost = position.avgCostBasis || 0
  const holdbackRatio = config?.holdbackRatio ?? 0.5
  const feeRatePerSide = config?.feeRatePerSide ?? config?.feeRate ?? DEFAULT_FEE_RATE_PER_SIDE

  const renderTpEditBtn = (order, mode) => {
    const isBodyTp = order.type === 'body_tp' || order.type === 'satellite_tp'
    if (!isBodyTp || !isRunning) return null
    const bd = bodyLookup.get(order.orderId)
    if (!bd) return null
    return (
      <button
        title="Edit TP target"
        className={`${REGIME_ORDER_TOUCH_TARGET} text-gray-400 hover:text-cyan-400 hover:bg-cyan-900/30 transition-colors ml-1 px-1 py-0.5 rounded text-sm leading-none`}
        onClick={(e) => {
          e.stopPropagation()
          setTpEditModal({ bodyId: bd.id, currentTpPct: order.tpPercent, currentPrice: order.price, avgPrice: bd.avgPrice, bodyLabel: bd.id.slice(-8), inputValue: String(order.tpPercent ?? ''), priceValue: String(order.price ?? ''), mode })
        }}
      >
        ✎
      </button>
    )
  }

  const toggleOrder = (orderId) => {
    setExpandedOrders(prev => {
      const next = new Set(prev)
      if (next.has(orderId)) next.delete(orderId)
      else next.add(orderId)
      return next
    })
  }

  const ordersWithCalcs = deriveOpenOrderRows(pendingOrdersList, {
    bodyLookup, index: relationIndex, avgCost, holdbackRatio, feeRatePerSide, now: Date.now(),
  })

  // Find highest body TP price for roll-up button visibility
  const bodyTpOrders = ordersWithCalcs.filter(o => o.type === 'body_tp' || o.type === 'satellite_tp')
  const highestBodyTpPrice = bodyTpOrders.reduce((max, o) => Math.max(max, o.price || 0), 0)

  const openFilter = openSearchId.toLowerCase()
  const matchesOpenSearch = (order) => {
    if (!openFilter) return true
    if (order.orderId?.toLowerCase().includes(openFilter)) return true
    if (order.relatedBuys?.some(b => b.orderId?.toLowerCase().includes(openFilter))) return true
    return false
  }
  const isEntry = (o) => o.type === 'entry' || o.type === 'ladder_entry'
  const sellOrders = ordersWithCalcs.filter(o => !isEntry(o) && matchesOpenSearch(o))
  const entryOrders = ordersWithCalcs.filter(o => isEntry(o) && matchesOpenSearch(o))

  // Sell order totals
  const totalSellSize = sellOrders.reduce((sum, o) => sum + (o.size || 0), 0)
  const totalSellValue = sellOrders.reduce((sum, o) => sum + (o.size || 0) * (o.price || 0), 0)
  const totalSellPnl = sellOrders.reduce((sum, o) => sum + (o.estPnl || 0), 0)
  const hasPnl = sellOrders.some(o => o.estPnl !== null)
  const totalSellFees = sellOrders.reduce((sum, o) => sum + (o.estSellFee || 0), 0)
  const totalHoldback = sellOrders.reduce((sum, o) => sum + (o.estHoldback || 0), 0)
  const totalHoldbackValue = sellOrders.reduce((sum, o) => sum + (o.estHoldbackValue || 0), 0)
  const hasHoldback = sellOrders.some(o => o.estHoldback !== null)

  return (
    <div className="overflow-x-auto">
      <div className="space-y-4">
      {/* Sell Orders Table */}
      {sellOrders.length > 0 && (
      <div>
        <div className="text-xs text-gray-400 mb-1">{sellOrders.length} sell {sellOrders.length === 1 ? 'order' : 'orders'}</div>
        <table className="w-full text-sm">
        <thead>
          <tr className="text-gray-400 text-xs border-b border-gray-700">
            <th className="text-left py-2 pr-1 w-6"></th>
            <th className="text-left py-2 pr-2">Order ID</th>
            <th className="text-left py-2 pr-2">Type</th>
            <th className="text-right py-2 pr-2">TP%</th>
            <th className="text-right py-2 pr-2">Size ({asset})</th>
            <th className="text-right py-2 pr-2">Price</th>
            <th className="text-right py-2 pr-2">Value</th>
            <th className="text-right py-2 pr-2">Est. P&L</th>
            <th className="text-right py-2 pr-2">Holdback</th>
            <th className="text-right py-2 pr-2">Age</th>
            <th className="py-2 w-6"></th>
          </tr>
        </thead>
        <tbody>
          {sellOrders.map((order) => {
            const isExpanded = expandedOrders.has(order.orderId)
            const isTp = order.type === 'take_profit' || order.type === 'satellite_tp' || order.type === 'body_tp'
            const hasBuys = order.relatedBuys.length > 0

            return (
              <React.Fragment key={order.orderId}>
                <tr
                  className={`border-b border-gray-700/50 ${isTp && hasBuys ? 'cursor-pointer' : ''} hover:bg-gray-700/30`}
                  onClick={isTp && hasBuys ? () => toggleOrder(order.orderId) : undefined}
                >
                  <td className="py-2 pr-1 text-gray-400 text-xs">
                    {isTp && hasBuys ? (
                      <span className={`inline-block transition-transform ${isExpanded ? 'rotate-90' : ''}`}>&#9654;</span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-2 font-mono text-gray-400 text-xs">
                    {order.orderId}
                    {hasBuys && <span className="text-gray-400 ml-1">({order.relatedBuys.length} {order.relatedBuys.length === 1 ? 'buy' : 'buys'})</span>}
                  </td>
                  <td className="py-2 pr-2">
                    {(() => {
                      const bodyInfo = (order.type === 'body_tp' || order.type === 'satellite_tp' || order.type === 'take_profit') ? bodyLookup.get(order.orderId) : null;
                      const tier = bodyInfo?.tier || order.bodyTier || (order.type === 'satellite_tp' ? 'satellite' : null);
                      const tierStyles = {
                        satellite:  { bg: 'bg-gray-700/60',    text: 'text-gray-300',    tooltip: 'Satellite — individual order, 1–3× base' },
                        asteroid:   { bg: 'bg-amber-900/40',   text: 'text-amber-600',   tooltip: 'Asteroid — small cluster, 2–3× base' },
                        moon:       { bg: 'bg-slate-600/50',   text: 'text-slate-300',   tooltip: 'Moon — cluster, 3–10× base' },
                        planet:     { bg: 'bg-blue-900/50',    text: 'text-blue-400',    tooltip: 'Planet — substantial mass, 10–100× base' },
                        sun:        { bg: 'bg-amber-900/50',   text: 'text-amber-400',   tooltip: 'Sun — large mass, 100–500× base' },
                        hypergiant: { bg: 'bg-purple-900/50',  text: 'text-purple-400',  tooltip: 'Hypergiant — massive mass, 500–1000× base' },
                        nebula:     { bg: 'bg-cyan-900/50',    text: 'text-cyan-400',    tooltip: 'Nebula — vast mass, 1000–5000× base' },
                        galaxy:     { bg: 'bg-pink-900/50',    text: 'text-pink-400',    tooltip: 'Galaxy — galactic mass, 5000–10000× base' },
                        black_hole: { bg: 'bg-red-900/50',     text: 'text-red-400',     tooltip: 'Black Hole — critical mass, 10000×+ base' },
                      };
                      if (tier && tierStyles[tier]) {
                        const s = tierStyles[tier];
                        const emoji = order.tierEmoji || bodyInfo?.emoji || '🛰️';
                        return <span className={`px-1.5 py-0.5 rounded text-xs ${s.bg} ${s.text}`} title={s.tooltip}>{emoji}</span>;
                      }
                      return <span className="px-1.5 py-0.5 rounded text-xs bg-cyan-900/50 text-cyan-400" title="Take-profit sell order">TP</span>;
                    })()}
                  </td>
                  <td className="text-right py-2 pr-2 font-mono text-xs text-cyan-400">
                    <span className="inline-flex items-center gap-1 justify-end">
                      {order.tpPercent ? `${order.tpPercent}%` : '—'}
                      {renderTpEditBtn(order, 'pct')}
                    </span>
                  </td>
                  <td className="text-right py-2 pr-2 font-mono text-white">
                    {order.size?.toFixed(8)}
                    {order.filledSize > 0 && (
                      <span className="ml-1 px-1 py-0.5 rounded text-[10px] bg-orange-900/50 text-orange-400" title={`${order.filledSize.toFixed(8)} of ${order.size?.toFixed(8)} filled`}>
                        {order.filledSize.toFixed(8)} filled
                      </span>
                    )}
                  </td>
                  <td className="text-right py-2 pr-2 font-mono text-white">
                    <span className="inline-flex items-center gap-1 justify-end">
                      ${order.price?.toLocaleString(undefined, { minimumFractionDigits: getPriceDecimals(market.lastPrice), maximumFractionDigits: getPriceDecimals(market.lastPrice) })}
                      {renderTpEditBtn(order, 'price')}
                    </span>
                  </td>
                  <td className="text-right py-2 pr-2 font-mono text-gray-300 text-xs">
                    ${(order.size * order.price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                  <td className={`text-right py-2 pr-2 font-mono text-xs ${order.estPnl !== null ? (order.estPnl >= 0 ? 'text-green-400' : 'text-red-400') : 'text-gray-400'}`} title={order.estSellFee ? `After est. sell fee: $${order.estSellFee.toFixed(4)}` : undefined}>
                    {order.estPnl !== null ? `${order.estPnl >= 0 ? '+' : ''}${formatCurrency(order.estPnl)}` : '—'}
                  </td>
                  <td className="text-right py-2 pr-2 font-mono text-xs text-cyan-400">
                    {order.estHoldback !== null ? (
                      <span title={`≈${formatCurrency(order.estHoldbackValue)}`}>+{order.estHoldback.toFixed(8)}</span>
                    ) : '—'}
                  </td>
                  <td className="text-right py-2 pr-2 font-mono text-gray-400 text-xs">
                    {formatDuration(order.age)}
                  </td>
                  <td className="py-2 text-center">
                    {(() => {
                      const isBodyTp = order.type === 'body_tp' || order.type === 'satellite_tp'
                      const hasPartialFill = order.filledSize > 0
                      const canRollUp = isBodyTp && isRunning && celestialBodies.length >= 2 && order.price < highestBodyTpPrice && !hasPartialFill
                      if (!canRollUp) return null
                      const bodyData = bodyLookup.get(order.orderId)
                      if (!bodyData) return null
                      const targetBody = celestialBodies
                        .filter(b => b.tpPrice > (bodyData.tpPrice || order.price))
                        .sort((a, b) => a.tpPrice - b.tpPrice)[0]
                      if (!targetBody) return null
                      // Check if target order is partially filled
                      const targetOrder = sellOrders.find(o => o.orderId === targetBody.tpOrderId)
                      if (targetOrder?.filledSize > 0) return null
                      const srcLabel = `${bodyData.id?.slice(-8)} ($${bodyData.costBasis?.toFixed(0)})`
                      const tgtLabel = `${targetBody.id?.slice(-8)} ($${targetBody.costBasis?.toFixed(0)})`
                      return (
                        <button
                          title={`Roll up into ${tgtLabel}`}
                          className={`${REGIME_ORDER_TOUCH_TARGET} px-1 py-0.5 text-xs text-yellow-400 hover:text-yellow-300 hover:bg-yellow-900/30 rounded transition-colors`}
                          onClick={(e) => {
                            e.stopPropagation()
                            setRollUpConfirm({ bodyId: bodyData.id, bodyLabel: srcLabel, targetLabel: tgtLabel })
                          }}
                        >
                          ↑
                        </button>
                      )
                    })()}
                  </td>
                </tr>
                {/* Buy sub-rows */}
                {isExpanded && order.relatedBuys.map((buy, idx) => (
                  <tr key={`${order.orderId}-buy-${buy.orderId}-${idx}`} className="border-b border-gray-700/30 bg-gray-750/20">
                    <td className="py-1 pr-1"></td>
                    <td className="py-1 pr-2 font-mono text-xs text-gray-400 pl-4">
                      <span className="text-green-400/70 mr-1">BUY</span>
                      {buy.orderId}
                    </td>
                    <td className="py-1 pr-2"></td>
                    <td className="py-1 pr-2"></td>
                    <td className="text-right py-1 pr-2 font-mono text-xs text-gray-300">
                      {buy.assetQty?.toFixed(8)}
                    </td>
                    <td className="text-right py-1 pr-2 font-mono text-xs text-gray-300">
                      ${buy.price?.toLocaleString(undefined, { minimumFractionDigits: getPriceDecimals(market.lastPrice), maximumFractionDigits: getPriceDecimals(market.lastPrice) })}
                    </td>
                    <td className="text-right py-1 pr-2 font-mono text-xs text-gray-400">
                      ${buy.sizeUsdc?.toFixed(2)}
                    </td>
                    <td className="py-1 pr-2"></td>
                    <td className="text-right py-1 font-mono text-xs text-gray-400">
                      {formatTimestamp(buy.filledAt)}
                    </td>
                    <td className="py-1"></td>
                  </tr>
                ))}
              </React.Fragment>
            )
          })}
        </tbody>
        <tfoot>
          <tr className="border-t border-gray-600 text-xs font-semibold">
            <td className="py-2 pr-1"></td>
            <td className="py-2 pr-2 text-gray-400">Totals</td>
            <td className="py-2 pr-2"></td>
            <td className="py-2 pr-2"></td>
            <td className="text-right py-2 pr-2 font-mono text-white">{totalSellSize.toFixed(8)}</td>
            <td className="py-2 pr-2"></td>
            <td className="text-right py-2 pr-2 font-mono text-gray-300">${totalSellValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            <td className={`text-right py-2 pr-2 font-mono ${hasPnl ? (totalSellPnl >= 0 ? 'text-green-400' : 'text-red-400') : 'text-gray-400'}`} title={totalSellFees ? `After est. sell fees: $${totalSellFees.toFixed(4)}` : undefined}>
              {hasPnl ? `${totalSellPnl >= 0 ? '+' : ''}${formatCurrency(totalSellPnl)}` : '—'}
            </td>
            <td className="text-right py-2 pr-2 font-mono text-cyan-400">
              {hasHoldback ? <span title={`≈${formatCurrency(totalHoldbackValue)}`}>+{totalHoldback.toFixed(8)}</span> : '—'}
            </td>
            <td className="py-2 pr-2"></td>
            <td className="py-2"></td>
          </tr>
        </tfoot>
      </table>
      </div>
      )}

      {/* Entry Orders Table */}
      {entryOrders.length > 0 && (
      <div>
        <div className="text-xs text-gray-400 mb-1">{entryOrders.length} entry {entryOrders.length === 1 ? 'order' : 'orders'}</div>
        <table className="w-full text-sm">
        <thead>
          <tr className="text-gray-400 text-xs border-b border-gray-700">
            <th className="text-left py-2 pr-2">Order ID</th>
            <th className="text-right py-2 pr-2">Size ({asset})</th>
            <th className="text-right py-2 pr-2">Price</th>
            <th className="text-right py-2 pr-2">Value</th>
            <th className="text-right py-2 pr-2">Age</th>
          </tr>
        </thead>
        <tbody>
          {entryOrders.map((order) => (
            <tr key={order.orderId} className="border-b border-gray-700/50 hover:bg-gray-700/30">
              <td className="py-2 pr-2 font-mono text-gray-400 text-xs">{order.orderId}</td>
              <td className="text-right py-2 pr-2 font-mono text-white">{order.size?.toFixed(8)}</td>
              <td className="text-right py-2 pr-2 font-mono text-white">
                ${order.price?.toLocaleString(undefined, { minimumFractionDigits: getPriceDecimals(market.lastPrice), maximumFractionDigits: getPriceDecimals(market.lastPrice) })}
              </td>
              <td className="text-right py-2 pr-2 font-mono text-gray-300 text-xs">
                ${(order.size * order.price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </td>
              <td className="text-right py-2 pr-2 font-mono text-gray-400 text-xs">{formatDuration(order.age)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      )}
      </div>
    </div>
  )
}

export default OpenOrdersTable
