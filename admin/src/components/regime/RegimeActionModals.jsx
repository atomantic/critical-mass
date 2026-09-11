import React from 'react'

const RegimeActionModals = ({
  // Collapse All state & handlers
  collapseAllConfirm,
  collapsingAll,
  onDismissCollapseAll,
  onExecuteCollapseAll,

  // Reset Cycle state & handlers
  resetCycleConfirm,
  resettingCycle,
  onDismissResetCycle,
  onExecuteResetCycle,

  // Unresolved placement-intent reconcile state & handlers
  intentConfirm,
  reconcilingIntent,
  onDismissIntent,
  onExecuteIntent,

  // Resume Drawdown state & handlers
  drawdownResumeConfirm,
  onDismissResumeDrawdown,
  onExecuteResumeDrawdown,

  // Roll Up Body state & handlers
  rollUpConfirm,
  rollingUp,
  onDismissRollUp,
  onExecuteRollUp,

  // Set TP Target state & handlers
  tpEditModal,
  settingTp,
  onDismissSetTp,
  onExecuteSetTp,
  onSetTpMode,
  onSetTpInputValue,
  onSetTpPriceValue,

  // DCA Conversion state & handlers
  showConvertConfirm,
  converting,
  convertPreview,
  onDismissConvert,
  onExecuteConvert,

  // Context & utilities
  status,
  position,
  config,
  getBaseCurrency,
  getQuoteCurrency,
}) => {
  return (
    <>
      {/* Collapse-all confirmation dialog */}
      {collapseAllConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => !collapsingAll && onDismissCollapseAll()}>
          <div className="bg-gray-800 border border-gray-600 rounded-lg p-6 max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-white text-lg font-medium mb-3">Collapse All Bodies</h3>
            <p className="text-gray-300 text-sm mb-4">
              Cancel <span className="text-amber-300 font-medium">{status?.celestial?.bodies?.length || 0}</span> body TP orders, combine all buys into a single body, and place one new TP order.
            </p>
            <p className="text-gray-500 text-xs mb-4">
              Aborts if any TP has a partial fill. Final TP% is capped at the highest body's pre-merge TP%, so the combined sell price can only move down.
            </p>
            <div className="flex justify-end gap-3">
              <button
                className="px-4 py-2 text-sm text-gray-400 hover:text-white bg-gray-700 hover:bg-gray-600 rounded transition-colors"
                onClick={() => onDismissCollapseAll()}
                disabled={collapsingAll}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 text-sm text-white bg-amber-600 hover:bg-amber-500 rounded transition-colors disabled:opacity-50"
                onClick={onExecuteCollapseAll}
                disabled={collapsingAll}
              >
                {collapsingAll ? 'Collapsing…' : 'Collapse All'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reset-cycle confirmation dialog */}
      {resetCycleConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => !resettingCycle && onDismissResetCycle()}>
          <div className="bg-gray-800 border border-gray-600 rounded-lg p-6 max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-white text-lg font-medium mb-3">Reset Cycle & Resume Buying</h3>
            <p className="text-gray-300 text-sm mb-4">
              Starts a new accumulation cycle so the bot resumes buying. Your open positions and their take-profit orders are preserved.
            </p>
            <p className="text-gray-500 text-xs mb-4">
              Resets the cycle buy counter ({position.cycleBuys}/{config?.maxCycleBuys}) to 0. The reset is persistent and survives an engine restart.
            </p>
            <div className="flex justify-end gap-3">
              <button
                className="px-4 py-2 text-sm text-gray-400 hover:text-white bg-gray-700 hover:bg-gray-600 rounded transition-colors"
                onClick={() => onDismissResetCycle()}
                disabled={resettingCycle}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 text-sm text-white bg-yellow-600 hover:bg-yellow-500 rounded transition-colors disabled:opacity-50"
                onClick={onExecuteResetCycle}
                disabled={resettingCycle}
              >
                {resettingCycle ? 'Resetting…' : 'Reset cycle & resume buying'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Unresolved placement-intent reconcile dialog */}
      {intentConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => !reconcilingIntent && onDismissIntent()}>
          <div className="bg-gray-800 border border-gray-600 rounded-lg p-6 max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-white text-lg font-medium mb-3">
              {intentConfirm.action === 'adopt' ? 'Adopt the exchange order' : 'Discard the placement intent'}
            </h3>
            <p className="text-gray-300 text-sm mb-4">
              {intentConfirm.action === 'adopt'
                ? 'Looks this placement up on the exchange by its client order id and, only if a live or filled order comes back, brings it under normal tracking. Nothing is adopted on an empty or failed lookup.'
                : 'Clears the record so this fund can place orders again. Do this only once you have checked the exchange yourself and confirmed no order from this placement is live — a duplicate would trade against the same capital twice.'}
            </p>
            <p className="text-gray-500 text-xs mb-4 font-mono break-all">
              {intentConfirm.intent?.action || 'order'} · {intentConfirm.intent?.side || '?'}
              {intentConfirm.intent?.clientOrderId ? ` · client_order_id ${intentConfirm.intent.clientOrderId}` : ' · no client order id recorded'}
            </p>
            <div className="flex justify-end gap-3">
              <button
                className="px-4 py-2 text-sm text-gray-400 hover:text-white bg-gray-700 hover:bg-gray-600 rounded transition-colors"
                onClick={() => onDismissIntent()}
                disabled={reconcilingIntent}
              >
                Cancel
              </button>
              <button
                className={`px-4 py-2 text-sm text-white rounded transition-colors disabled:opacity-50 ${intentConfirm.action === 'adopt' ? 'bg-blue-600 hover:bg-blue-500' : 'bg-amber-600 hover:bg-amber-500'}`}
                onClick={onExecuteIntent}
                disabled={reconcilingIntent}
              >
                {reconcilingIntent
                  ? 'Working…'
                  : intentConfirm.action === 'adopt' ? 'Look up & adopt' : 'Discard intent'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Drawdown resume confirmation dialog */}
      {drawdownResumeConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => onDismissResumeDrawdown()}>
          <div className="bg-gray-800 border border-gray-600 rounded-lg p-6 max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-white text-lg font-medium mb-3">Resume from Drawdown Pause</h3>
            <p className="text-gray-300 text-sm mb-4">
              Resume trading from the drawdown pause? This resets the peak equity to current levels.
            </p>
            <div className="flex justify-end gap-3">
              <button
                className="px-4 py-2 text-sm text-gray-400 hover:text-white bg-gray-700 hover:bg-gray-600 rounded transition-colors"
                onClick={() => onDismissResumeDrawdown()}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 text-sm text-white bg-green-600 hover:bg-green-500 rounded transition-colors"
                onClick={onExecuteResumeDrawdown}
              >
                Resume Trading
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Roll-up confirmation dialog */}
      {rollUpConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => !rollingUp && onDismissRollUp()}>
          <div className="bg-gray-800 border border-gray-600 rounded-lg p-6 max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-white text-lg font-medium mb-3">Roll Up Body</h3>
            <p className="text-gray-300 text-sm mb-4">
              Merge body <span className="font-mono text-yellow-400">{rollUpConfirm.bodyLabel}</span> into <span className="font-mono text-green-400">{rollUpConfirm.targetLabel}</span>?
            </p>
            <p className="text-gray-500 text-xs mb-4">
              Both TP orders will be cancelled, buys combined, and a new TP placed for the merged body.
            </p>
            <div className="flex justify-end gap-3">
              <button
                className="px-4 py-2 text-sm text-gray-400 hover:text-white bg-gray-700 hover:bg-gray-600 rounded transition-colors"
                onClick={() => onDismissRollUp()}
                disabled={rollingUp}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 text-sm text-white bg-yellow-600 hover:bg-yellow-500 rounded transition-colors disabled:opacity-50"
                onClick={() => onExecuteRollUp(rollUpConfirm.bodyId)}
                disabled={rollingUp}
              >
                {rollingUp ? 'Merging...' : 'Roll Up'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TP edit dialog (% or price) */}
      {tpEditModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => !settingTp && onDismissSetTp()}>
          <div className="bg-gray-800 border border-gray-600 rounded-lg p-6 max-w-sm mx-4 w-full" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-white text-lg font-medium mb-1">Set TP Target</h3>
            <p className="text-gray-400 text-xs font-mono mb-3">body …{tpEditModal.bodyLabel}</p>
            {/* Mode tabs */}
            <div className="flex mb-3 border border-gray-600 rounded overflow-hidden">
              <button
                className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${tpEditModal.mode === 'pct' ? 'bg-cyan-800 text-white' : 'bg-gray-700 text-gray-400 hover:text-white'}`}
                onClick={() => onSetTpMode('pct')}
              >
                Percentage
              </button>
              <button
                className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${tpEditModal.mode === 'price' ? 'bg-cyan-800 text-white' : 'bg-gray-700 text-gray-400 hover:text-white'}`}
                onClick={() => onSetTpMode('price')}
              >
                Limit Price
              </button>
            </div>
            {tpEditModal.mode === 'pct' ? (
              <div className="mb-1">
                <label className="text-gray-400 text-xs block mb-1">Take-profit % above avg cost</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    max="50"
                    className="flex-1 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white font-mono text-sm focus:outline-none focus:border-cyan-500"
                    value={tpEditModal.inputValue}
                    onChange={(e) => {
                      const pct = parseFloat(e.target.value)
                      const newPrice = tpEditModal.avgPrice && !isNaN(pct) && pct > 0
                        ? (tpEditModal.avgPrice * (1 + pct / 100)).toFixed(2)
                        : tpEditModal.priceValue
                      onSetTpInputValue(e.target.value, newPrice)
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && onExecuteSetTp('pct')}
                    autoFocus
                  />
                  <span className="text-gray-400 text-sm">%</span>
                </div>
                {tpEditModal.currentTpPct && (
                  <p className="text-gray-500 text-xs mt-1">Current: {tpEditModal.currentTpPct}%</p>
                )}
                {tpEditModal.avgPrice && tpEditModal.inputValue && !isNaN(parseFloat(tpEditModal.inputValue)) && (
                  <p className="text-gray-500 text-xs mt-0.5">= ${(tpEditModal.avgPrice * (1 + parseFloat(tpEditModal.inputValue) / 100)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                )}
              </div>
            ) : (
              <div className="mb-1">
                <label className="text-gray-400 text-xs block mb-1">Limit sell price (USD)</label>
                <div className="flex items-center gap-2">
                  <span className="text-gray-400 text-sm">$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    className="flex-1 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white font-mono text-sm focus:outline-none focus:border-cyan-500"
                    value={tpEditModal.priceValue}
                    onChange={(e) => {
                      const price = parseFloat(e.target.value)
                      const newPct = tpEditModal.avgPrice && !isNaN(price) && price > tpEditModal.avgPrice
                        ? (((price - tpEditModal.avgPrice) / tpEditModal.avgPrice) * 100).toFixed(2)
                        : tpEditModal.inputValue
                      onSetTpPriceValue(e.target.value, newPct)
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && onExecuteSetTp('price')}
                    autoFocus
                  />
                </div>
                {tpEditModal.currentPrice && (
                  <p className="text-gray-500 text-xs mt-1">Current: ${tpEditModal.currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                )}
                {tpEditModal.avgPrice && tpEditModal.priceValue && !isNaN(parseFloat(tpEditModal.priceValue)) && parseFloat(tpEditModal.priceValue) > tpEditModal.avgPrice && (
                  <p className="text-gray-500 text-xs mt-0.5">= {(((parseFloat(tpEditModal.priceValue) - tpEditModal.avgPrice) / tpEditModal.avgPrice) * 100).toFixed(2)}% above avg cost</p>
                )}
                {tpEditModal.avgPrice && (
                  <p className="text-gray-500 text-xs mt-0.5">Avg cost: ${tpEditModal.avgPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                )}
              </div>
            )}
            <div className="flex justify-end gap-3 mt-4">
              <button
                className="px-4 py-2 text-sm text-gray-400 hover:text-white bg-gray-700 hover:bg-gray-600 rounded transition-colors"
                onClick={() => onDismissSetTp()}
                disabled={settingTp}
              >
                Cancel
              </button>
              {tpEditModal.mode === 'pct' ? (
                <button
                  className="px-4 py-2 text-sm text-white bg-cyan-700 hover:bg-cyan-600 rounded transition-colors disabled:opacity-50"
                  onClick={() => onExecuteSetTp('pct')}
                  disabled={settingTp || !tpEditModal.inputValue || parseFloat(tpEditModal.inputValue) <= 0}
                >
                  {settingTp ? 'Placing...' : 'Set TP%'}
                </button>
              ) : (
                <button
                  className="px-4 py-2 text-sm text-white bg-cyan-700 hover:bg-cyan-600 rounded transition-colors disabled:opacity-50"
                  onClick={() => onExecuteSetTp('price')}
                  disabled={settingTp || !tpEditModal.priceValue || parseFloat(tpEditModal.priceValue) <= (tpEditModal.avgPrice || 0)}
                >
                  {settingTp ? 'Placing...' : 'Set Price'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* DCA-to-Regime conversion confirmation dialog */}
      {showConvertConfirm && convertPreview && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => !converting && onDismissConvert()}>
          <div className="bg-gray-800 border border-gray-600 rounded-lg p-6 max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-white text-lg font-medium mb-3">{convertPreview.merge ? 'Import DCA Orders' : 'Upgrade DCA Orders'}</h3>
            <p className="text-gray-300 text-sm mb-4">
              {convertPreview.merge
                ? `Merge DCA positions into the existing regime engine (${convertPreview.existingBodies} bodies, ${convertPreview.existingAsset?.toFixed(8)} BTC). New sell orders will be placed when the engine starts.`
                : 'Convert your DCA order history into the Regime Engine format. Existing sell orders on the exchange will be preserved.'}
            </p>
            {(() => {
              const asset = getBaseCurrency(convertPreview.productId)
              const quote = getQuoteCurrency(convertPreview.productId)
              return (
                <div className="bg-gray-900 rounded-lg p-3 mb-4 text-sm space-y-1.5">
                  <div className="flex justify-between">
                    <span className="text-gray-400">Open positions (pending sells)</span>
                    <span className="text-white font-mono">{convertPreview.pending}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Completed orders</span>
                    <span className="text-white font-mono">{convertPreview.filled}</span>
                  </div>
                  {convertPreview.skipped > 0 && (
                    <div className="flex justify-between">
                      <span className="text-gray-400">Skipped (consolidated sources)</span>
                      <span className="text-gray-500 font-mono">{convertPreview.skipped}</span>
                    </div>
                  )}
                  <div className="border-t border-gray-700 pt-1.5 flex justify-between">
                    <span className="text-gray-400">Pending {asset}</span>
                    <span className="text-yellow-400 font-mono">{convertPreview.pendingBaseQty?.toFixed(8)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Pending cost basis</span>
                    <span className="text-yellow-400 font-mono">{quote.startsWith('USD') ? '$' : ''}{convertPreview.pendingCostBasis?.toFixed(2)}{!quote.startsWith('USD') ? ` ${quote}` : ''}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Total filled {asset}</span>
                    <span className="text-green-400 font-mono">{convertPreview.totalBaseQty?.toFixed(8)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Total cost basis</span>
                    <span className="text-green-400 font-mono">{quote.startsWith('USD') ? '$' : ''}{convertPreview.totalCostBasis?.toFixed(2)}{!quote.startsWith('USD') ? ` ${quote}` : ''}</span>
                  </div>
                </div>
              )
            })()}
            <p className="text-gray-500 text-xs mb-4">
              {convertPreview.merge
                ? 'This will create backup files and add celestial bodies to the existing regime position. The regime engine will place new sell orders when started.'
                : 'This will disable the DCA engine, create backup files, and build regime state with celestial bodies for each open position.'}
            </p>
            <div className="flex justify-end gap-3">
              <button
                className="px-4 py-2 text-sm text-gray-400 hover:text-white bg-gray-700 hover:bg-gray-600 rounded transition-colors"
                onClick={() => onDismissConvert()}
                disabled={converting}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 text-sm text-white bg-indigo-600 hover:bg-indigo-500 rounded transition-colors disabled:opacity-50"
                onClick={onExecuteConvert}
                disabled={converting}
              >
                {converting ? 'Converting...' : convertPreview?.merge ? 'Confirm Import' : 'Confirm Upgrade'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default RegimeActionModals
