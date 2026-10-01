import React, { useId, useRef, useState } from 'react'
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
  // Why Place is (un)available. 'ready' is the ONLY state that enables it, and
  // is entered solely when a preview for the CURRENT generation has loaded:
  // loading | saving | editing | ready | rejected | notApplied | previewFailed
  const [panelState, setPanelState] = useState('loading')
  const [blockMessage, setBlockMessage] = useState('')

  // Synchronous gate (refs, so rapid clicks before React commits are still
  // blocked). `gen` bumps on every open/close/edit/preview request: a response
  // or save completion from an older generation never touches the preview.
  const gen = useRef(0)
  const saveChain = useRef(Promise.resolve())
  const pendingSaves = useRef(0)
  const dirty = useRef(false) // numeric field edited but not yet saved (blur)
  const failed = useRef(false) // a save was rejected / not applied live
  const placing = useRef(false)
  const previewGen = useRef(-1) // generation the displayed preview belongs to
  const confirmed = useRef(null) // last settings known to be applied live

  const canPlaceNow = () =>
    !placing.current && !failed.current && !dirty.current &&
    pendingSaves.current === 0 && previewGen.current === gen.current

  const fetchLadderPreview = async (myGen) => {
    setPanelState('loading')
    try {
      const res = await fetch(`/api/${exchange}/regime/preview-ladder${pairQuery}`)
      const data = await res.json().catch(() => ({ success: false, message: 'Bad response' }))
      if (myGen !== gen.current) return // superseded by a newer edit/open/close
      if (data.success) {
        previewGen.current = myGen
        setLadderPreview(data.preview)
        setPanelState('ready')
      } else {
        setLadderPreview(null)
        setPanelState('previewFailed')
        addToast?.({ type: 'error', title: 'Preview Failed', message: data.message || 'Could not preview ladder' })
      }
    } catch (err) {
      if (myGen !== gen.current) return
      setLadderPreview(null)
      setPanelState('previewFailed')
      addToast?.({ type: 'error', title: 'Preview Failed', message: err.message })
    }
  }

  // Invalidate the shown preview's authority to place, then reload it.
  const refreshPreview = () => {
    const myGen = ++gen.current
    setLadderPreview(null)
    return fetchLadderPreview(myGen)
  }

  // Applies one save. Never throws. Only the latest generation fetches the
  // corresponding preview; failures block placement until retried/reverted.
  const persist = async (edits, myGen) => {
    try {
      if (failed.current) return // draft stays unsaved; Retry sends all of it
      const res = await fetch(`/api/${exchange}/regime/config${pairQuery}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(edits),
      })
      if (res.ok) {
        confirmed.current = { ...confirmed.current, ...edits }
        await fetchConfig?.()
        if (myGen === gen.current && !failed.current) await fetchLadderPreview(myGen)
        return
      }
      const data = await res.json().catch(() => ({}))
      failed.current = true
      previewGen.current = -1
      setLadderPreview(null)
      if (data?.persisted && data?.applied === false) {
        setPanelState('notApplied')
        setBlockMessage('Saved, but the live engine did not apply it - restart the engine or retry before placing.')
        addToast?.({ type: 'error', title: 'Not Applied', message: data.error || 'Ladder settings were saved but not applied to the live engine' })
      } else {
        setPanelState('rejected')
        setBlockMessage(`Settings were not saved (HTTP ${res.status}). Retry or revert before placing.`)
        addToast?.({ type: 'error', title: 'Save Failed', message: `Could not save ladder settings (HTTP ${res.status})` })
      }
    } catch (err) {
      failed.current = true
      previewGen.current = -1
      setLadderPreview(null)
      setPanelState('rejected')
      setBlockMessage('Settings were not saved. Retry or revert before placing.')
      addToast?.({ type: 'error', title: 'Save Failed', message: err.message })
    } finally {
      pendingSaves.current--
    }
  }

  const saveLadderEdits = (edits) => {
    if (placing.current) return
    const myGen = ++gen.current
    dirty.current = false
    setLadderPreview(null)
    if (failed.current) return // blocked until Retry/Revert
    setPanelState('saving')
    pendingSaves.current++
    saveChain.current = saveChain.current.then(() => persist(edits, myGen))
  }

  // Numeric fields commit on blur; typing already revokes the old preview.
  const markDraftEdited = () => {
    gen.current++
    dirty.current = true
    setLadderPreview(null)
    if (!failed.current) setPanelState('editing')
  }

  const commitNumber = (key) => {
    setLadderNumberDraft(prev => ({ ...prev, [key]: undefined }))
    if (!dirty.current) return
    const value = ladderEdits[key]
    if (!failed.current && confirmed.current?.[key] === value) {
      dirty.current = false
      refreshPreview()
      return
    }
    saveLadderEdits({ [key]: value })
  }

  const handleRetry = () => {
    if (placing.current) return
    failed.current = false
    setBlockMessage('')
    setLadderNumberDraft({})
    saveLadderEdits({ ...ladderEdits })
  }

  const handleRevert = () => {
    if (placing.current || !confirmed.current) return
    failed.current = false
    dirty.current = false
    setBlockMessage('')
    setLadderNumberDraft({})
    setLadderEdits({ ...confirmed.current })
    refreshPreview()
  }

  const handlePlaceLadder = async () => {
    if (!canPlaceNow()) return
    placing.current = true
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
        gen.current++
        previewGen.current = -1
        setShowLadderPanel(false)
        setLadderPreview(null)
      } else {
        addToast?.({ type: 'error', title: 'Ladder Failed', message: data.message || 'Could not place ladder orders' })
      }
    } catch (err) {
      addToast?.({ type: 'error', title: 'Ladder Failed', message: err.message })
    } finally {
      placing.current = false
      setPlacingLadder(false)
    }
  }

  const handleToggle = () => {
    if (placing.current) return
    const opening = !showLadderPanel
    setShowLadderPanel(opening)
    const myGen = ++gen.current // closing also supersedes in-flight previews
    previewGen.current = -1
    setLadderPreview(null)
    if (opening) {
      const initial = {
        ladderMaxAthDropPct: config?.ladderMaxAthDropPct ?? status?.config?.ladderMaxAthDropPct ?? 80,
        ladderSpacingMode: config?.ladderSpacingMode ?? status?.config?.ladderSpacingMode ?? 'sqrt',
        ladderSizeMode: config?.ladderSizeMode ?? status?.config?.ladderSizeMode ?? 'fibonacci',
        ladderMinSpacingPct: config?.ladderMinSpacingPct ?? status?.config?.ladderMinSpacingPct ?? 0.5,
      }
      confirmed.current = initial
      failed.current = false
      dirty.current = false
      setBlockMessage('')
      setLadderEdits(initial)
      setLadderNumberDraft({})
      setPanelState('loading')
      // A save still in flight from before the panel was closed must settle first.
      saveChain.current.then(() => myGen === gen.current && fetchLadderPreview(myGen))
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
                  if (placingLadder) return
                  const raw = e.target.value
                  markDraftEdited()
                  setLadderNumberDraft(prev => ({ ...prev, ladderMaxAthDropPct: raw }))
                  if (raw.trim() === '') return // don't commit 0 on clear
                  const n = parseFloat(raw)
                  if (Number.isFinite(n)) setLadderEdits(prev => ({ ...prev, ladderMaxAthDropPct: n }))
                }}
                onBlur={() => commitNumber('ladderMaxAthDropPct')}
                disabled={placingLadder}
                className="w-full bg-gray-700 text-white text-xs rounded px-2 py-1"
              />
            </div>
            <div>
              <label htmlFor={spacingModeId} className="text-[10px] text-gray-400 block mb-1">Spacing Mode</label>
              <select
                id={spacingModeId}
                value={ladderEdits.ladderSpacingMode}
                disabled={placingLadder}
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
                disabled={placingLadder}
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
                  if (placingLadder) return
                  const raw = e.target.value
                  markDraftEdited()
                  setLadderNumberDraft(prev => ({ ...prev, ladderMinSpacingPct: raw }))
                  if (raw.trim() === '') return // don't commit 0 on clear
                  const n = parseFloat(raw)
                  if (Number.isFinite(n)) setLadderEdits(prev => ({ ...prev, ladderMinSpacingPct: n }))
                }}
                onBlur={() => commitNumber('ladderMinSpacingPct')}
                disabled={placingLadder}
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
                disabled={placingLadder || panelState !== 'ready'}
                className="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded transition-colors"
              >
                {placingLadder ? 'Placing...' : `Place ${ladderPreview.levelCount} Orders`}
              </button>
            </div>
          ) : (
            <div className="text-xs text-gray-400" role="status" aria-busy={panelState === 'loading' || panelState === 'saving'}>
              {panelState === 'saving' && 'Saving settings...'}
              {panelState === 'editing' && 'Unsaved changes - leave the field to save before placing.'}
              {panelState === 'loading' && 'Loading preview...'}
              {panelState === 'previewFailed' && 'Preview unavailable. Placement is blocked.'}
              {(panelState === 'rejected' || panelState === 'notApplied') && (
                <span className="text-red-400">
                  {blockMessage}{' '}
                  <button onClick={handleRetry} className="underline text-indigo-300">Retry</button>
                  {panelState === 'rejected' && <>{' '}<button onClick={handleRevert} className="underline text-indigo-300">Revert</button></>}
                </span>
              )}
              {panelState === 'previewFailed' && <>{' '}<button onClick={refreshPreview} className="underline text-indigo-300">Retry preview</button></>}
            </div>
          )}
        </div>
      )}
    </>
  )
}

export default LadderPanel
