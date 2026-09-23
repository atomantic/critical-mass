import React, { useId, useState } from 'react'
import { formatPriceByMagnitude, formatCurrency } from '../charts/chartUtils'

/**
 * RegimeDashboard "Rebuild Ladder" toggle + settings/preview panel. Owns its
 * own expand state, draft edits and in-flight flags; the parent only
 * supplies fetched config/status and the shared refetch/toast/socket-status
 * callbacks.
 *
 * Rendered as a single unit (toggle button + panel) on its own line below
 * the Open Orders header, above `<OpenOrdersTable>` — deliberately NOT
 * inside the header's buttons row, so opening it never shifts the Cancel
 * Ladder / Collapse All / order-filter controls that stay in that row. Only
 * the toggle button is gated by `entryMode === 'ladder' && isRunning`; the
 * settings/preview panel's own visibility is independent of that guard.
 */
function LadderPanel({ config, status, exchange, pairQuery, addToast, fetchConfig, setSocketStatus }) {
  const athDropId = useId()
  const spacingModeId = useId()
  const sizeModeId = useId()
  const minSpacingId = useId()

  const [showLadderPanel, setShowLadderPanel] = useState(false)
  const [ladderPreview, setLadderPreview] = useState(null)
  const [ladderEdits, setLadderEdits] = useState(null)
  // Raw in-progress text for the numeric ladder inputs, so clearing the field to
  // retype doesn't commit/persist 0 (mirrors ConfigEditor's FormInput draft pattern).
  const [ladderNumberDraft, setLadderNumberDraft] = useState({})
  const [placingLadder, setPlacingLadder] = useState(false)

  const fetchLadderPreview = async () => {
    try {
      const res = await fetch(`/api/${exchange}/regime/preview-ladder${pairQuery}`)
      const data = await res.json().catch(() => ({ success: false, message: 'Bad response' }))
      if (data.success) {
        setLadderPreview(data.preview)
      } else {
        setLadderPreview(null)
        addToast?.({ type: 'error', title: 'Preview Failed', message: data.message || 'Could not preview ladder' })
      }
    } catch (err) {
      setLadderPreview(null)
      addToast?.({ type: 'error', title: 'Preview Failed', message: err.message })
    }
  }

  const saveLadderEdits = async (edits) => {
    try {
      const res = await fetch(`/api/${exchange}/regime/config${pairQuery}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(edits),
      })
      if (res.ok) {
        await fetchConfig?.()
        await fetchLadderPreview()
      } else {
        addToast?.({ type: 'error', title: 'Save Failed', message: `Could not save ladder settings (HTTP ${res.status})` })
      }
    } catch (err) {
      addToast?.({ type: 'error', title: 'Save Failed', message: err.message })
    }
  }

  const handlePlaceLadder = async () => {
    setPlacingLadder(true)
    try {
      const res = await fetch(`/api/${exchange}/regime/rebuild-ladder${pairQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const data = await res.json().catch(() => ({ success: false, message: 'Bad response' }))
      if (data.success) {
        addToast?.({ type: 'success', title: 'Ladder Placed', message: data.message })
        if (data.status) setSocketStatus?.(data.status)
        setShowLadderPanel(false)
        setLadderPreview(null)
      } else {
        addToast?.({ type: 'error', title: 'Ladder Failed', message: data.message || 'Could not place ladder orders' })
      }
    } catch (err) {
      addToast?.({ type: 'error', title: 'Ladder Failed', message: err.message })
    } finally {
      setPlacingLadder(false)
    }
  }

  const handleToggle = () => {
    const opening = !showLadderPanel
    setShowLadderPanel(opening)
    if (opening) {
      setLadderEdits({
        ladderMaxAthDropPct: config?.ladderMaxAthDropPct ?? status?.config?.ladderMaxAthDropPct ?? 80,
        ladderSpacingMode: config?.ladderSpacingMode ?? status?.config?.ladderSpacingMode ?? 'sqrt',
        ladderSizeMode: config?.ladderSizeMode ?? status?.config?.ladderSizeMode ?? 'fibonacci',
        ladderMinSpacingPct: config?.ladderMinSpacingPct ?? status?.config?.ladderMinSpacingPct ?? 0.5,
      })
      setLadderNumberDraft({})
      fetchLadderPreview()
    }
  }

  // Only the TOGGLE BUTTON is gated by entryMode/isRunning — matching the
  // pre-extraction behavior, where the settings/preview panel rendered
  // independently of that condition (`{showLadderPanel && ladderEdits && (...)}`
  // had no entryMode/isRunning check of its own). Gating the whole component
  // behind that condition would hide an already-open panel the instant
  // isRunning/entryMode flips via a status update, without the operator ever
  // clicking "Close" — and since returning null doesn't reset local state,
  // the panel would silently reappear with stale preview data later.
  const showToggle = status?.config?.entryMode === 'ladder' && status?.isRunning

  return (
    <>
      {showToggle && (
        <button
          onClick={handleToggle}
          className="px-2 py-1 text-xs bg-indigo-600 hover:bg-indigo-500 text-white rounded transition-colors"
        >
          {showLadderPanel ? 'Close' : 'Rebuild Ladder'}
        </button>
      )}
      {showLadderPanel && ladderEdits && (
        <div className="mb-4 p-3 bg-indigo-900/20 border border-indigo-700/50 rounded-lg space-y-3">
          <div className="text-xs font-medium text-indigo-300">Ladder Settings</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <label htmlFor={athDropId} className="text-[10px] text-gray-400 block mb-1">ATH Drop %</label>
              <input
                id={athDropId}
                type="text"
                inputMode="decimal"
                value={ladderNumberDraft.ladderMaxAthDropPct ?? ladderEdits.ladderMaxAthDropPct}
                onChange={e => {
                  const raw = e.target.value
                  setLadderNumberDraft(prev => ({ ...prev, ladderMaxAthDropPct: raw }))
                  if (raw.trim() === '') return // don't commit 0 on clear
                  const n = parseFloat(raw)
                  if (Number.isFinite(n)) setLadderEdits(prev => ({ ...prev, ladderMaxAthDropPct: n }))
                }}
                onBlur={() => {
                  setLadderNumberDraft(prev => ({ ...prev, ladderMaxAthDropPct: undefined }))
                  saveLadderEdits({ ladderMaxAthDropPct: ladderEdits.ladderMaxAthDropPct })
                }}
                className="w-full bg-gray-700 text-white text-xs rounded px-2 py-1"
              />
            </div>
            <div>
              <label htmlFor={spacingModeId} className="text-[10px] text-gray-400 block mb-1">Spacing Mode</label>
              <select
                id={spacingModeId}
                value={ladderEdits.ladderSpacingMode}
                onChange={e => {
                  const val = e.target.value
                  setLadderEdits(prev => ({ ...prev, ladderSpacingMode: val }))
                  saveLadderEdits({ ladderSpacingMode: val })
                }}
                className="w-full bg-gray-700 text-white text-xs rounded px-2 py-1"
              >
                <option value="linear">Linear</option>
                <option value="sqrt">Sqrt</option>
                <option value="exponential">Exponential</option>
              </select>
            </div>
            <div>
              <label htmlFor={sizeModeId} className="text-[10px] text-gray-400 block mb-1">Size Mode</label>
              <select
                id={sizeModeId}
                value={ladderEdits.ladderSizeMode}
                onChange={e => {
                  const val = e.target.value
                  setLadderEdits(prev => ({ ...prev, ladderSizeMode: val }))
                  saveLadderEdits({ ladderSizeMode: val })
                }}
                className="w-full bg-gray-700 text-white text-xs rounded px-2 py-1"
              >
                <option value="flat">Flat</option>
                <option value="linear">Linear</option>
                <option value="sqrt">Sqrt</option>
                <option value="fibonacci">Fibonacci</option>
              </select>
            </div>
            <div>
              <label htmlFor={minSpacingId} className="text-[10px] text-gray-400 block mb-1">Min Spacing %</label>
              <input
                id={minSpacingId}
                type="text"
                inputMode="decimal"
                value={ladderNumberDraft.ladderMinSpacingPct ?? ladderEdits.ladderMinSpacingPct}
                onChange={e => {
                  const raw = e.target.value
                  setLadderNumberDraft(prev => ({ ...prev, ladderMinSpacingPct: raw }))
                  if (raw.trim() === '') return // don't commit 0 on clear
                  const n = parseFloat(raw)
                  if (Number.isFinite(n)) setLadderEdits(prev => ({ ...prev, ladderMinSpacingPct: n }))
                }}
                onBlur={() => {
                  setLadderNumberDraft(prev => ({ ...prev, ladderMinSpacingPct: undefined }))
                  saveLadderEdits({ ladderMinSpacingPct: ladderEdits.ladderMinSpacingPct })
                }}
                className="w-full bg-gray-700 text-white text-xs rounded px-2 py-1"
              />
            </div>
          </div>
          {/* Preview */}
          {ladderPreview ? (
            <div className="space-y-2">
              <div className="flex items-center gap-4 text-xs text-gray-300">
                <span>{ladderPreview.levelCount} levels</span>
                <span>{formatPriceByMagnitude(ladderPreview.levels[0]?.price)} — {formatPriceByMagnitude(ladderPreview.levels[ladderPreview.levels.length - 1]?.price)}</span>
                <span title={`Max: ${formatCurrency(ladderPreview.maxUsdcDeployed)} − Allocated: ${formatCurrency(ladderPreview.allocatedCapital)}`}>Budget: {formatCurrency(ladderPreview.totalBudget)}</span>
                <span>Range: {ladderPreview.lowerBoundPct?.toFixed(1)}%</span>
              </div>
              <div className="max-h-40 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-400 border-b border-gray-700">
                      <th className="text-left py-1 pr-2">#</th>
                      <th className="text-right py-1 pr-2">Price</th>
                      <th className="text-right py-1 pr-2">Size (USDC)</th>
                      <th className="text-right py-1 pr-2">Qty</th>
                      <th className="text-right py-1">Distance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ladderPreview.levels.map((level, i) => (
                      <tr key={i} className="border-b border-gray-700/30 text-gray-300">
                        <td className="py-1 pr-2 text-gray-400">{i + 1}</td>
                        <td className="text-right py-1 pr-2 font-mono">{formatPriceByMagnitude(level.price)}</td>
                        <td className="text-right py-1 pr-2 font-mono">${level.sizeUsdc?.toFixed(2)}</td>
                        <td className="text-right py-1 pr-2 font-mono">{level.assetQty?.toFixed(8)}</td>
                        <td className="text-right py-1 font-mono text-gray-400">{level.distancePct?.toFixed(2)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button
                onClick={handlePlaceLadder}
                disabled={placingLadder}
                className="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded transition-colors"
              >
                {placingLadder ? 'Placing...' : `Place ${ladderPreview.levelCount} Orders`}
              </button>
            </div>
          ) : (
            <div className="text-xs text-gray-400">Loading preview...</div>
          )}
        </div>
      )}
    </>
  )
}

export default LadderPanel
