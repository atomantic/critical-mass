import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  deriveRegimeFillGroups, searchRegimeFillGroups, visibleOrphanBuys,
  deriveDryRunFillGroups, searchDryRunFillGroups,
} from '../../utils/regimeFillGroups.mjs'
import { getPriceDecimals, formatCurrency } from '../charts/chartUtils'
import { formatDuration, formatTimestamp } from './regimeFormat'

const EMPTY = []

/**
 * RegimeDashboard "Filled Orders" section. Owns its cycle toggle, search and
 * expansion state; cycle accounting comes from regimeFillGroups.mjs (live:
 * shared/cycle-pairing.mjs via deriveRegimeFillGroups; dry-run:
 * deriveDryRunFillGroups). Parent passes only fetched data.
 */
function FilledOrdersSection({ liveFills, isDryRun, dryRunFilled: dryRunFilledProp, pendingOrdersList, market, asset }) {
  const dryRunFilled = dryRunFilledProp || EMPTY
  const [showAllCycles, setShowAllCycles] = useState(true)
  const [expandedFills, setExpandedFills] = useState(new Set())
  const [expandedCycles, setExpandedCycles] = useState(new Set())
  const [fillSearchId, setFillSearchId] = useState('')

  // Compute filtered fills for display based on cycle toggle
  const filteredFills = useMemo(() => {
    if (!liveFills || liveFills.length === 0) {
      return []
    }
    if (showAllCycles) {
      return liveFills
    }
    // Find the most recent cycleId by comparing cycle numbers
    const currentCycleId = liveFills.reduce((latest, f) => {
      if (!f.cycleId) return latest
      if (!latest) return f.cycleId
      const latestNum = parseInt(latest.replace('cycle-', '')) || 0
      const fillNum = parseInt(f.cycleId.replace('cycle-', '')) || 0
      return fillNum > latestNum ? f.cycleId : latest
    }, null)
    return liveFills.filter(f => f.cycleId === currentCycleId)
  }, [liveFills, showAllCycles])

  // Historical work depends only on the selected fill snapshot, never ticker status.
  const historicalFillGroups = useMemo(() => deriveRegimeFillGroups(filteredFills), [filteredFills])
  const searchedFillGroups = useMemo(() => searchRegimeFillGroups(historicalFillGroups, fillSearchId), [historicalFillGroups, fillSearchId])

  // Derive the most recent cycle ID from filtered fills
  const mostRecentCycleId = useMemo(() => {
    if (!filteredFills || filteredFills.length === 0) return null
    return filteredFills.reduce((latest, f) => {
      if (!f.cycleId) return latest
      if (!latest) return f.cycleId
      const latestNum = parseInt(latest.replace('cycle-', '')) || 0
      const fillNum = parseInt(f.cycleId.replace('cycle-', '')) || 0
      return fillNum > latestNum ? f.cycleId : latest
    }, null)
  }, [filteredFills])

  // Auto-expand most recent cycle on mount / when cycle list changes
  const cycleInitRef = useRef(false)
  useEffect(() => {
    if (mostRecentCycleId && !cycleInitRef.current) {
      setExpandedCycles(new Set([mostRecentCycleId]))
      cycleInitRef.current = true
    }
  }, [mostRecentCycleId])

  const searchedDryRunFillGroups = useMemo(
    () => (isDryRun ? searchDryRunFillGroups(deriveDryRunFillGroups(dryRunFilled), fillSearchId) : null),
    [isDryRun, dryRunFilled, fillSearchId],
  )

  return (
    <div className="bg-gray-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-400">Filled Orders</h3>
        <div className="flex items-center gap-3">
          {!isDryRun && liveFills?.length > 0 && (
            <button
              onClick={() => { setShowAllCycles(!showAllCycles); setExpandedCycles(new Set()); cycleInitRef.current = false }}
              className={`text-xs px-2 py-1 rounded transition-colors ${
                showAllCycles
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
              }`}
            >
              {showAllCycles ? 'All Cycles' : 'Current Cycle'}
            </button>
          )}
          {((isDryRun && dryRunFilled.length > 0) || (!isDryRun && filteredFills.length > 0)) && (
            <span className="text-xs text-gray-400">
              {isDryRun
                ? dryRunFilled.length
                : filteredFills.length
              } fills
              {!isDryRun && (() => {
                const cc = new Set(filteredFills.map(f => f.cycleId).filter(Boolean)).size
                return cc > 0 ? ` (${cc} ${cc === 1 ? 'cycle' : 'cycles'})` : ''
              })()}
            </span>
          )}
          <input
            aria-label="Filter fills by ID"
            type="text"
            value={fillSearchId}
            onChange={e => setFillSearchId(e.target.value)}
            placeholder="Filter by ID…"
            className="bg-gray-700 text-gray-200 text-xs rounded px-2 py-1 placeholder-gray-400 w-36"
          />
        </div>
      </div>
      {(isDryRun
        ? dryRunFilled.length
        : filteredFills.length
      ) === 0 ? (
        <div className="text-gray-400 text-sm text-center py-4">
          {!isDryRun && liveFills?.length > 0 && !showAllCycles
            ? 'No fills in current cycle (toggle to see all cycles)'
            : 'No filled orders yet'
          }
        </div>
      ) : (
        /* Filled Sells with expandable buy sub-rows */
        <div>
          {(() => {
            const toggleFill = (key) => {
              setExpandedFills(prev => {
                const next = new Set(prev)
                if (next.has(key)) next.delete(key)
                else next.add(key)
                return next
              })
            }

            // Build sell groups: each = { sell, buys[], key }
            const shownGroups = isDryRun ? searchedDryRunFillGroups : searchedFillGroups
            const sellGroups = shownGroups.sellGroups
            const orphanedBuys = isDryRun ? [] : visibleOrphanBuys(searchedFillGroups.orphanCandidates, pendingOrdersList)

            if (sellGroups.length === 0 && orphanedBuys.length === 0) {
              return <div className="text-gray-400 text-sm text-center py-4">{fillSearchId ? 'No matching orders' : 'No filled sells yet'}</div>
            }

            // Source of truth: sum of per-sell pnl across all cycles. The engine's
            // contract is buy(n)→sell(1) per cycle, so each sell's pnl reflects its
            // paired buys' cost basis. Summing across cycles gives total realized USD.
            const totalPnl = shownGroups.totalPnl

            // Shared sell + buy row renderer
            const renderSellRow = (group) => {
              const isExpanded = expandedFills.has(group.key)
              const sell = group.sell
              const buys = group.buys
              const sellPrice = sell.fillPrice || sell.price
              const sellValue = sell.quoteAmount || ((sell.size || 0) * (sellPrice || 0))
              const sellPnl = sell.pnl ?? sell.bodyPnl ?? sell.satellitePnl ?? null
              const sellHoldback = isDryRun ? sell.holdbackAsset : sell.holdback
              const sellTime = sell.filledAt || sell.timestamp

              return (
                <React.Fragment key={group.key}>
                  <tr
                    className="border-b border-gray-700 cursor-pointer hover:bg-gray-700/40 transition-colors"
                    onClick={() => toggleFill(group.key)}
                  >
                    <td className="py-1.5 pr-1 text-gray-400 text-xs">
                      <span className={`inline-block transition-transform ${isExpanded ? 'rotate-90' : ''}`}>&#9654;</span>
                    </td>
                    <td className="py-1.5 pr-2 font-mono text-xs text-gray-400">
                      {sell.orderId}
                      {buys.length > 0 && <span className="text-gray-400 ml-1">({buys.length} {buys.length === 1 ? 'buy' : 'buys'})</span>}
                      {buys.length === 0 && sell.duplicateTpNote && <span className="text-yellow-600/70 ml-1" title={sell.duplicateTpNote}>(dup TP)</span>}
                      {buys.length === 0 && sell.untrackedSell && !sell.duplicateTpNote && <span className="text-yellow-600/70 ml-1">(orphan)</span>}
                    </td>
                    <td className="text-right py-1.5 pr-2 font-mono text-white text-xs">
                      {sell.size?.toFixed(8)}
                    </td>
                    <td className="text-right py-1.5 pr-2 font-mono text-white text-xs">
                      ${sellPrice?.toLocaleString(undefined, { minimumFractionDigits: getPriceDecimals(market.lastPrice), maximumFractionDigits: getPriceDecimals(market.lastPrice) })}
                    </td>
                    <td className="text-right py-1.5 pr-2 font-mono text-gray-400 text-xs">
                      ${sellValue.toFixed(2)}
                    </td>
                    <td className={`text-right py-1.5 pr-2 font-mono text-xs ${
                      sellPnl !== null ? (sellPnl >= 0 ? 'text-green-400' : 'text-red-400') : 'text-gray-400'
                    }`}>
                      {sellPnl !== null ? `${sellPnl >= 0 ? '+' : ''}${formatCurrency(sellPnl)}` : '—'}
                      {sellHoldback > 0 && <span className="ml-1 text-cyan-400" title={`Holdback ${asset}`}>+{sellHoldback.toFixed(8)}</span>}
                      {!isDryRun && sell.reservesSold > 0 && <span className="ml-1 text-amber-400" title={`Sold beyond the body's holdings — drawn from ${asset} reserves`}>−{sell.reservesSold.toFixed(8)}</span>}
                    </td>
                    <td className="text-right py-1.5 font-mono text-gray-400 text-xs">
                      {formatTimestamp(sellTime)}
                    </td>
                  </tr>
                  {isExpanded && buys.length === 0 && (sell.duplicateTpNote || sell.untrackedSell) && (
                    <tr className="border-b border-gray-700/30 bg-gray-750/20">
                      <td className="py-1 pr-1"></td>
                      <td colSpan={6} className="py-1.5 pl-5 text-xs text-yellow-600/70 italic">
                        {sell.duplicateTpNote || 'Untracked sell — buy orders linked to original TP'}
                        {(sell.bodyCostBasis ?? sell.satelliteCostBasis) > 0 && <span className="ml-2 text-gray-400">Cost basis: ${(sell.bodyCostBasis ?? sell.satelliteCostBasis).toFixed(2)}</span>}
                      </td>
                    </tr>
                  )}
                  {isExpanded && buys.map((buy, idx) => {
                    const buyPrice = buy.fillPrice || buy.price
                    const buyValue = buy.quoteAmount || ((buy.size || 0) * (buyPrice || 0))
                    const buyTime = buy.filledAt || buy.timestamp
                    const fillTimeMs = isDryRun
                      ? (buy.filledAt && buy.placedAt ? buy.filledAt - buy.placedAt : null)
                      : buy.fillTimeMs
                    return (
                      <tr key={`${group.key}-buy-${buy.orderId || buy.tradeId}-${idx}`}
                        className="border-b border-gray-700/30 bg-gray-750/20"
                      >
                        <td className="py-1 pr-1"></td>
                        <td className="py-1 pr-2 font-mono text-xs text-gray-400 pl-5">
                          <span className="text-green-400/70 mr-1">BUY</span>
                          {buy.orderId}
                        </td>
                        <td className="text-right py-1 pr-2 font-mono text-xs text-gray-300">
                          {buy.size?.toFixed(8)}
                        </td>
                        <td className="text-right py-1 pr-2 font-mono text-xs text-gray-300">
                          ${buyPrice?.toLocaleString(undefined, { minimumFractionDigits: getPriceDecimals(market.lastPrice), maximumFractionDigits: getPriceDecimals(market.lastPrice) })}
                        </td>
                        <td className="text-right py-1 pr-2 font-mono text-xs text-gray-400">
                          ${buyValue.toFixed(2)}
                        </td>
                        <td className="text-right py-1 pr-2 font-mono text-xs text-gray-400">
                          {fillTimeMs !== null ? formatDuration(fillTimeMs) : ''}
                        </td>
                        <td className="text-right py-1 font-mono text-xs text-gray-400">
                          {formatTimestamp(buyTime)}
                        </td>
                      </tr>
                    )
                  })}
                </React.Fragment>
              )
            }

            const tableHeader = (
              <tr className="text-gray-400 text-xs border-b border-gray-700">
                <th className="text-left py-1.5 pr-1 w-6"></th>
                <th className="text-left py-1.5 pr-2">Order ID</th>
                <th className="text-right py-1.5 pr-2">Size ({asset})</th>
                <th className="text-right py-1.5 pr-2">Price</th>
                <th className="text-right py-1.5 pr-2">Value</th>
                <th className="text-right py-1.5 pr-2">P&L</th>
                <th className="text-right py-1.5">Filled</th>
              </tr>
            )

            // --- DryRun: flat table (no cycle grouping) ---
            if (isDryRun) {
              const { totalHoldback } = searchedDryRunFillGroups
              return (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      {tableHeader}
                    </thead>
                    <tbody>
                      {sellGroups.length > 1 && (
                        <tr className="border-b border-gray-600 bg-gray-700/30 font-medium">
                          <td className="py-1.5 pr-1"></td>
                          <td className="py-1.5 pr-2 text-gray-400 text-xs" colSpan={4}>Totals ({sellGroups.length} sells)</td>
                          <td className={`text-right py-1.5 pr-2 font-mono text-xs ${totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {totalPnl !== 0 ? `${totalPnl >= 0 ? '+' : ''}${formatCurrency(totalPnl)}` : '—'}
                            {totalHoldback > 0 && <span className="ml-1 text-cyan-400" title="Total holdback">+{totalHoldback.toFixed(8)}</span>}
                          </td>
                          <td className="text-right py-1.5"></td>
                        </tr>
                      )}
                      {sellGroups.map(renderSellRow)}
                    </tbody>
                  </table>
                </div>
              )
            }

            // --- Live: cycle-grouped layout ---
            const { cycleGroups, totalHoldback } = searchedFillGroups

            return (
              <div className="overflow-x-auto space-y-2">
                {/* Grand totals bar */}
                {cycleGroups.length > 0 && (() => {
                  const reservesUsd = (totalHoldback || 0) * (market.lastPrice || 0)
                  const grandTotal = totalPnl + reservesUsd
                  const showReserves = totalHoldback > 0
                  return (
                    <div className="flex items-center justify-between px-2 py-1.5 bg-gray-700/30 rounded text-xs">
                      <span className="text-gray-400">{sellGroups.length} sells across {cycleGroups.length} {cycleGroups.length === 1 ? 'cycle' : 'cycles'}</span>
                      <span className="font-mono">
                        <span className={totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                          {totalPnl !== 0 ? `${totalPnl >= 0 ? '+' : ''}${formatCurrency(totalPnl)}` : '—'}
                        </span>
                        {showReserves && (
                          <>
                            <span className="ml-1 text-cyan-400">+{totalHoldback.toFixed(8)} {asset}</span>
                            {reservesUsd > 0 && (
                              <>
                                <span className="ml-1 text-cyan-400/70">({formatCurrency(reservesUsd)})</span>
                                <span className={`ml-2 font-bold ${grandTotal >= 0 ? 'text-green-300' : 'text-red-300'}`}>
                                  = {grandTotal >= 0 ? '+' : ''}{formatCurrency(grandTotal)}
                                </span>
                              </>
                            )}
                          </>
                        )}
                      </span>
                    </div>
                  )
                })()}
                {/* Orphaned buys (not linked to any sell) */}
                {!isDryRun && orphanedBuys && orphanedBuys.length > 0 && (
                  <div className="border border-yellow-700/40 rounded-lg overflow-hidden">
                    <div
                      className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-gray-700/40 transition-colors"
                      onClick={() => {
                        setExpandedCycles(prev => {
                          const next = new Set(prev)
                          if (next.has('orphans')) next.delete('orphans')
                          else next.add('orphans')
                          return next
                        })
                      }}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`inline-block transition-transform text-xs text-gray-500 ${expandedCycles.has('orphans') ? 'rotate-90' : ''}`}>&#9654;</span>
                        <span className="px-2 py-0.5 rounded text-xs bg-yellow-900/50 text-yellow-400">Orphaned</span>
                        <span className="text-xs text-gray-400">{orphanedBuys.length} buys not linked to any sell</span>
                      </div>
                      <span className="font-mono text-xs text-yellow-400">{orphanedBuys.reduce((s, b) => s + (b.size || 0), 0).toFixed(8)} {asset}</span>
                    </div>
                    {expandedCycles.has('orphans') && (
                      <div className="border-t border-gray-700">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-gray-400 text-xs border-b border-gray-700">
                              <th className="text-left py-1.5 pr-1 w-6"></th>
                              <th className="text-left py-1.5 pr-2">Order ID</th>
                              <th className="text-right py-1.5 pr-2">Size ({asset})</th>
                              <th className="text-right py-1.5 pr-2">Price</th>
                              <th className="text-right py-1.5 pr-2">Value</th>
                              <th className="text-right py-1.5 pr-2">Cycle</th>
                              <th className="text-right py-1.5">Filled</th>
                            </tr>
                          </thead>
                          <tbody>
                            {orphanedBuys.map((buy, idx) => {
                              const buyPrice = buy.fillPrice || buy.price
                              const buyValue = buy.quoteAmount || ((buy.size || 0) * (buyPrice || 0))
                              return (
                                <tr key={`orphan-${buy.orderId}-${idx}`} className="border-b border-gray-700/30">
                                  <td className="py-1 pr-1"></td>
                                  <td className="py-1 pr-2 font-mono text-xs text-yellow-400/70">
                                    {buy.orderId}
                                  </td>
                                  <td className="text-right py-1 pr-2 font-mono text-xs text-gray-300">
                                    {buy.size?.toFixed(8)}
                                  </td>
                                  <td className="text-right py-1 pr-2 font-mono text-xs text-gray-300">
                                    ${buyPrice?.toLocaleString(undefined, { minimumFractionDigits: getPriceDecimals(market.lastPrice), maximumFractionDigits: getPriceDecimals(market.lastPrice) })}
                                  </td>
                                  <td className="text-right py-1 pr-2 font-mono text-xs text-gray-400">
                                    ${buyValue.toFixed(2)}
                                  </td>
                                  <td className="text-right py-1 pr-2 font-mono text-xs text-gray-400">
                                    {buy.cycleId?.replace('cycle-', '#') || '—'}
                                  </td>
                                  <td className="text-right py-1 font-mono text-xs text-gray-400">
                                    {formatTimestamp(buy.timestamp || buy.filledAt)}
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
                {cycleGroups.map(cycle => {
                  const isCurrentCycle = cycle.cycleId === mostRecentCycleId
                  const isCycleExpanded = expandedCycles.has(cycle.cycleId)
                  const cycleLabel = cycle.cycleId === 'unknown' ? 'Unassigned' : cycle.cycleId.replace('cycle-', '#')

                  return (
                    <div key={cycle.cycleId} className="border border-gray-700 rounded-lg overflow-hidden">
                      <div
                        className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-gray-700/40 transition-colors"
                        onClick={() => {
                          setExpandedCycles(prev => {
                            const next = new Set(prev)
                            if (next.has(cycle.cycleId)) next.delete(cycle.cycleId)
                            else next.add(cycle.cycleId)
                            return next
                          })
                        }}
                      >
                        <div className="flex items-center gap-2">
                          <span className={`inline-block transition-transform text-xs text-gray-500 ${isCycleExpanded ? 'rotate-90' : ''}`}>&#9654;</span>
                          <span className={`px-2 py-0.5 rounded text-xs ${
                            cycle.cycleId === 'unknown'
                              ? 'bg-gray-700 text-gray-400'
                              : isCurrentCycle
                                ? 'bg-blue-900/50 text-blue-400'
                                : 'bg-green-900/50 text-green-400'
                          }`}>
                            {cycleLabel}
                          </span>
                          <span className="text-xs text-gray-400">
                            {cycle.sells.length} {cycle.sells.length === 1 ? 'sell' : 'sells'}, {cycle.buyCount} {cycle.buyCount === 1 ? 'buy' : 'buys'}
                          </span>
                          {cycle.minTs < Infinity && (
                            <span className="text-[10px] text-gray-400 font-mono">
                              {new Date(cycle.minTs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                              {cycle.maxTs > cycle.minTs && ` – ${new Date(cycle.maxTs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}
                            </span>
                          )}
                        </div>
                        <span className={`font-mono text-xs ${cycle.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {cycle.totalPnl !== 0 ? `${cycle.totalPnl >= 0 ? '+' : ''}${formatCurrency(cycle.totalPnl)}` : '—'}
                          {cycle.totalHoldback > 0 && <span className="ml-1 text-cyan-400">+{cycle.totalHoldback.toFixed(8)}</span>}
                        </span>
                      </div>
                      {isCycleExpanded && (
                        <div className="border-t border-gray-700">
                          <table className="w-full text-sm">
                            <thead>
                              {tableHeader}
                            </thead>
                            <tbody>
                              {cycle.sells.map(renderSellRow)}
                              {cycle.sells.length > 1 && (
                                <tr className="border-t border-gray-600 bg-gray-700/20">
                                  <td className="py-1.5 pr-1"></td>
                                  <td className="py-1.5 pr-2 text-gray-400 text-xs">Subtotal ({cycle.sells.length} sells)</td>
                                  <td className="text-right py-1.5 pr-2 font-mono text-white text-xs">{cycle.totalSize.toFixed(8)}</td>
                                  <td className="text-right py-1.5 pr-2"></td>
                                  <td className="text-right py-1.5 pr-2"></td>
                                  <td className={`text-right py-1.5 pr-2 font-mono text-xs ${cycle.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                    {cycle.totalPnl !== 0 ? `${cycle.totalPnl >= 0 ? '+' : ''}${formatCurrency(cycle.totalPnl)}` : '—'}
                                    {cycle.totalHoldback > 0 && <span className="ml-1 text-cyan-400">+{cycle.totalHoldback.toFixed(8)}</span>}
                                  </td>
                                  <td className="text-right py-1.5"></td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })()}
        </div>
      )}
    </div>
  )
}

export default FilledOrdersSection
