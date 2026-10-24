import { describeConfigSaveError } from '../utils/configSaveError.mjs'
import { apiGet, apiPost, apiPut, apiPatch } from '../utils/apiClient'
import { buildSavePayload } from '../utils/configSavePayload.mjs'
import { INTERVAL_OPTIONS } from '../utils/intervals.mjs'
import { TIERS as CELESTIAL_TIERS, formatTierCapitalRange } from '../../../shared/celestial-tiers.mjs'
import { useState, useEffect, useId, useRef, useCallback } from 'react'
import ToggleSwitch from './ToggleSwitch'
import { useNotify, useToast } from './Toast'
import Button from './ui/Button'
import { getBaseCurrency, getQuoteCurrency } from '../App'

// Input component defined OUTSIDE ConfigEditor to prevent re-creation on every render
function FormInput({ label, hint, value, onChange, type = 'text', className = '' }) {
  const inputId = useId()
  const hintId = `${inputId}-hint`
  // For number inputs, hold the raw string locally while editing so partial
  // entries survive ("0." doesn't collapse to "0" mid-type, and clearing the
  // field shows empty rather than instantly committing 0). The parsed number is
  // committed only when the text parses to a finite value; an empty/partial
  // field commits nothing (keeps the last valid value) (#111).
  const [draft, setDraft] = useState(null)
  if (type !== 'number') {
    return (
      <div className={className}>
        <label htmlFor={inputId} className="block text-xs text-gray-400 mb-1">{label}</label>
        <input
          id={inputId}
          type={type}
          aria-describedby={hint ? hintId : undefined}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded-sm text-sm text-white focus:outline-hidden focus:border-blue-500"
        />
        {hint && <div id={hintId} className="text-2xs text-gray-400 mt-0.5 leading-tight">{hint}</div>}
      </div>
    )
  }
  const handleNumberChange = (e) => {
    const raw = e.target.value
    setDraft(raw)
    if (raw.trim() === '') return // don't commit 0 on clear
    const n = parseFloat(raw)
    if (Number.isFinite(n)) onChange(n)
  }
  // Show the in-progress draft while focused/editing; otherwise reflect the
  // committed value. Reset the draft on blur so external value changes show.
  const display = draft != null ? draft : (value ?? '')
  return (
    <div className={className}>
      <label htmlFor={inputId} className="block text-xs text-gray-400 mb-1">{label}</label>
      <input
        id={inputId}
        type="text"
        inputMode="decimal"
        aria-describedby={hint ? hintId : undefined}
        value={display}
        onChange={handleNumberChange}
        onBlur={() => setDraft(null)}
        className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded-sm text-sm text-white focus:outline-hidden focus:border-blue-500"
      />
      {hint && <div id={hintId} className="text-2xs text-gray-400 mt-0.5 leading-tight">{hint}</div>}
    </div>
  )
}

function FormSelect({ label, hint, value, onChange, options, className = '' }) {
  const selectId = useId()
  const hintId = `${selectId}-hint`
  return (
    <div className={className}>
      <label htmlFor={selectId} className="block text-xs text-gray-400 mb-1">{label}</label>
      <select
        id={selectId}
        aria-describedby={hint ? hintId : undefined}
        value={value ?? options[0]?.value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded-sm text-sm text-white focus:outline-hidden focus:border-blue-500"
      >
        {options.map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
      {hint && <div id={hintId} className="text-2xs text-gray-400 mt-0.5 leading-tight">{hint}</div>}
    </div>
  )
}

// Reusable section card for the 2-column regime grid
function SectionCard({ title, children, className = '' }) {
  return (
    <div className={`bg-gray-900/40 rounded-lg p-4 ${className}`}>
      <h3 className="text-sm font-medium text-purple-400 mb-3">{title}</h3>
      {children}
    </div>
  )
}

function ConfigEditor({ config: initialConfig, onSave, exchange = 'coinbase', pair, strategy = 'dca', engineRunning = null, engineDryRun = null, onRestart, loadError, onRetry }) {
  const [config, setConfig] = useState(initialConfig)
  // The server copy the draft was loaded from; Save diffs against it (#1395).
  const baselineRef = useRef(initialConfig)
  const [saving, setSaving] = useState(false)
  const [toggleBusy, setToggleBusy] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const notify = useNotify()
  const { removeToast } = useToast()
  // Id of the sticky "restart the engine to apply" warning currently on screen.
  // Dismissed when the restart succeeds or a later save applies cleanly, so it
  // never contradicts a newer success toast.
  const restartWarningRef = useRef(null)
  const dismissRestartWarning = () => {
    if (restartWarningRef.current !== null) removeToast(restartWarningRef.current)
    restartWarningRef.current = null
  }
  const warnRestartNeeded = (message) => {
    dismissRestartWarning() // one warning at a time; the newest supersedes
    restartWarningRef.current = notify('warning', message, { sticky: true })
  }
  const [isDirty, setIsDirty] = useState(false)
  const [presets, setPresets] = useState(null)
  const [editingPresets, setEditingPresets] = useState(null)
  const [presetsError, setPresetsError] = useState(null)
  const [presetsDirty, setPresetsDirty] = useState(false)
  const [savingPresets, setSavingPresets] = useState(false)
  const pendingPresetSaveRef = useRef(false)
  const [expandedPresets, setExpandedPresets] = useState(new Set())
  const prevExchangeRef = useRef(exchange)
  const prevStrategyRef = useRef(strategy)
  // Count of in-flight configuration writes. Full-form saves AND both
  // top-level toggle auto-saves share this one ref so the write paths can
  // never overlap — a slow full save can no longer be raced by a toggle
  // PATCH (or vice versa), which previously let Save submit a PUT containing
  // an unconfirmed optimistic toggle value (#455). It is checked synchronously
  // at the top of handleSave/handleToggleDryRun/handleToggleEnabled, so a
  // rapid double-click can't slip a second write in before React commits the
  // disabled controls. It also still guards the background-refresh sync
  // effect below: the summary poll refreshes initialConfig every ~30s, and
  // without this check a poll landing mid-write would fire that effect
  // (isDirty is never set for a toggle) and snap the UI back to stale state.
  const pendingWriteRef = useRef(0)
  // Apply a server-confirmed value to both the draft and its baseline.
  const adoptSaved = updater => {
    baselineRef.current = updater(baselineRef.current)
    setConfig(updater)
  }
  const loadDraft = next => adoptSaved(() => next)

  // Determine if showing regime config based on URL strategy prop
  const isRegime = strategy === 'regime'
  const isFibonacci = !isRegime && config?.dcaStrategy === 'fibonacci'

  // Reset config when exchange or strategy changes
  useEffect(() => {
    if (prevExchangeRef.current !== exchange || prevStrategyRef.current !== strategy) {
      prevExchangeRef.current = exchange
      prevStrategyRef.current = strategy
      if (initialConfig) {
        loadDraft(initialConfig)
        setIsDirty(false)
      }
    }
  }, [exchange, strategy, initialConfig])

  // A regime fund needs an engine restart to apply a dryRun change whenever the
  // saved config diverges from the mode the running engine actually started in.
  // Derived from authoritative, freshly-polled server state (engineRunning /
  // engineDryRun, refreshed every 5s and on fund switch) rather than a local
  // baseline — so it self-corrects across toggles, reverts, other-tab edits, and
  // navigation without any stored flag to go stale. dryRun only takes effect at
  // engine construction (the engine captures it once and picks its live-vs-paper
  // executor), so a config/engine mismatch is exactly the restart trigger.
  const restartNeeded = isRegime && engineRunning === true && typeof engineDryRun === 'boolean' && config?.dryRun !== engineDryRun

  // Sync with initialConfig when not dirty (e.g., server-side refresh). Skip
  // while any configuration write (full save or toggle auto-save) is in
  // flight so a background poll can't clobber the optimistic/pending value
  // before the write resolves.
  useEffect(() => {
    if (!initialConfig) {
      loadDraft(undefined)
      setIsDirty(false)
      return
    }
    if (initialConfig && !isDirty && pendingWriteRef.current === 0) {
      loadDraft(initialConfig)
    }
  }, [initialConfig]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch aggressiveness presets for regime mode
  const loadPresets = useCallback(async (isStale = () => false) => {
    const result = await apiGet('/api/presets/aggressiveness')
    if (isStale()) return
    const data = result.ok ? result.data : null
    if (data?.presets) {
      setPresets(data.presets)
      setEditingPresets(JSON.parse(JSON.stringify(data.presets)))
      setPresetsError(null)
    } else if (result.ok) setPresetsError('Presets unavailable')
    else setPresetsError(result.status >= 400 ? `Presets unavailable (HTTP ${result.status})` : 'Presets unavailable: request failed')
  }, [])
  useEffect(() => {
    if (!isRegime) return
    let stale = false
    loadPresets(() => stale)
    return () => { stale = true }
  }, [isRegime, loadPresets])

  // Do not render editable defaults or retain a previous draft when this fund's
  // summary has not arrived. All hooks stay above this gate so Retry can mount
  // the real form only once its own authoritative config is available.
  if (!initialConfig || !config) {
    return (
      <div className="bg-gray-800 rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-3">Bot Configuration</h2>
        <Button disabled>Save Configuration</Button>
        {loadError ? (
          <div role="alert" className="mt-4 text-red-200">
            Failed to load configuration: {loadError}
            <Button type="button" onClick={onRetry} variant="link" size="inline" className="ml-3 underline">Retry configuration</Button>
          </div>
        ) : (
          <p role="status" className="mt-4 text-gray-400">Loading configuration...</p>
        )}
      </div>
    )
  }

  const handlePresetParamChange = (level, key, value) => {
    if (pendingPresetSaveRef.current) return
    setEditingPresets(prev => ({
      ...prev,
      [level]: { ...prev[level], [key]: value },
    }))
    setPresetsDirty(true)
  }

  const handleSavePresets = async () => {
    if (pendingPresetSaveRef.current || !presetsDirty) return
    pendingPresetSaveRef.current = true
    setSavingPresets(true)
    try {
      const result = await apiPut('/api/presets/aggressiveness', editingPresets, { allowEmpty: true })
      if (result.ok) {
        const data = result.data
        if (data) {
          setPresets(data.presets)
          setEditingPresets(JSON.parse(JSON.stringify(data.presets)))
        }
        setPresetsDirty(false)
        notify('success', 'Presets saved!')
      } else {
        const reason = result.data?.errors?.join(', ') || (result.status ? '' : result.error)
        notify('error', reason || 'Failed to save')
      }
    } finally {
      pendingPresetSaveRef.current = false
      setSavingPresets(false)
    }
  }

  const handleResetPresets = () => {
    if (pendingPresetSaveRef.current) return
    if (presets) {
      setEditingPresets(JSON.parse(JSON.stringify(presets)))
      setPresetsDirty(false)
    }
  }

  const togglePresetExpanded = (level) => {
    setExpandedPresets(prev => {
      const next = new Set(prev)
      if (next.has(level)) next.delete(level)
      else next.add(level)
      return next
    })
  }

  const handleChange = (key, value) => {
    setConfig(prev => ({ ...prev, [key]: value }))
    setIsDirty(true)
  }

  // Handler for nested regime config changes
  const handleRegimeChange = (key, value) => {
    setConfig(prev => ({
      ...prev,
      regime: { ...prev.regime, [key]: value }
    }))
    setIsDirty(true)
  }

  // Get regime config with defaults
  const regimeConfig = config.regime || {}

  const pairQuery = pair ? `?pair=${encodeURIComponent(pair)}` : ''

  // Operator-facing reason for a failed config write. A reply that was never
  // read (status 0) has no body, so the client's own message stands in for it.
  const describeWriteFailure = (result) => (
    describeConfigSaveError(result.status || null, result.status ? result.data : { message: result.error }).message
  )

  const handleSave = async () => {
    if (pendingWriteRef.current > 0) return // a toggle (or another save) is already in flight
    pendingWriteRef.current += 1
    setSaving(true)
    const payload = buildSavePayload(config, baselineRef.current)
    try {
      const res = await apiPut(`/api/${exchange}/config${pairQuery}`, payload, { allowEmpty: true })
      const result = res.data || {}
      if (res.ok) {
        if (result.config) loadDraft(result.config)
        dismissRestartWarning()
        notify('success', 'Configuration saved!')
        setIsDirty(false)
        onSave?.()
      } else if (result.persisted === true) {
        // Persistence succeeded even though the live engine rejected or missed
        // propagation. Keep the authoritative saved value and tell the operator
        // that a restart is required; reverting here would display stale state.
        if (result.config) loadDraft(result.config)
        setIsDirty(false)
        warnRestartNeeded('Configuration saved, but the live engine is still using the previous settings. Restart the engine to apply it.')
        onSave?.()
      } else {
        notify('error', describeWriteFailure(res))
      }
    } finally {
      pendingWriteRef.current -= 1
      setSaving(false)
    }
  }

  const handleReset = () => {
    if (initialConfig) {
      loadDraft(initialConfig)
      setIsDirty(false)
    }
  }

  // Persist a single toggle immediately (no full-form Save). Optimistically flips
  // local state, then reverts if persistence fails so the switch never lies about
  // the saved state. A persisted-but-not-live response keeps the saved value and
  // surfaces the required restart. `enabled`/`dryRun` write where the Save button
  // does — see the PATCH /api/:exchange/config and PUT regime/config handlers.
  // Serialized via the shared pendingWriteRef (see the click guard in the
  // handlers, and in handleSave): only one write of any kind — toggle or
  // full save — is ever in flight, so out-of-order responses can't persist
  // the opposite of the final UI state, and a full save can't submit an
  // unconfirmed optimistic toggle value. try/finally is required here — a
  // thrown render-time error must still decrement the ref, or the sync effect
  // stays blocked forever and the toggle is stuck showing an unsaved value.
  const persistToggle = async (label, doFetch, optimistic, revert, adoptToggle) => {
    pendingWriteRef.current += 1
    setToggleBusy(true)
    optimistic()
    try {
      const res = await doFetch()
      const result = res.data || {}
      if (res.ok) {
        adoptToggle(result.config)
        dismissRestartWarning()
        notify('success', `${label} saved`)
        // restartNeeded is derived from engine vs saved state — the optimistic
        // config update plus onSave's refetch drive the banner; nothing to set.
        onSave?.()
      } else if (result.persisted === true) {
        // A toggle acknowledges only its own field. Updating both copies keeps
        // it out of the next Save diff without replacing unrelated draft edits
        // with the older server snapshot, even when propagation fails.
        adoptToggle(result.config)
        warnRestartNeeded(`${label} saved, but the live engine is still using the previous setting. Restart the engine to apply it.`)
        onSave?.()
      } else {
        revert()
        notify('error', describeWriteFailure(res))
      }
    } finally {
      pendingWriteRef.current -= 1
      setToggleBusy(false)
    }
  }

  // Restart the regime engine so it reconstructs from the freshly-saved config.
  // This is the only way a dryRun change actually takes effect — the engine
  // captures dryRun (and picks its live vs paper order executor) at construction
  // and never re-derives it on a config update. start refuses if already
  // running, so stop first; an engine that is already stopped just starts fresh.
  const handleRestartEngine = async () => {
    setRestarting(true)
    const stop = await apiPost(`/api/${exchange}/regime/stop${pairQuery}`, undefined, { allowEmpty: true })
    if (!stop.ok) {
      const stopErr = stop.data || {}
      const alreadyStopped = typeof stopErr.error === 'string' && stopErr.error.includes('not running')
      if (!alreadyStopped) {
        // Starting now would only answer "already running" and hide why the
        // stop failed, while the engine keeps trading in its previous mode.
        const reason = stop.status
          ? (stopErr.error || `HTTP ${stop.status}`)
          : 'the server is unreachable'
        notify('error', `Could not stop the engine to apply the change (${reason}). It may still be running with its previous Dry Run setting — retry the restart.`)
        onRestart?.()
        setRestarting(false)
        return
      }
    }
    const start = await apiPost(`/api/${exchange}/regime/start${pairQuery}`, undefined, { allowEmpty: true })
    if (start.ok) {
      dismissRestartWarning()
      notify('success', 'Engine restarted — change applied')
      onSave?.()
      onRestart?.() // refresh engine status so the derived restart banner clears
    } else {
      // Stop succeeded, so the engine is now STOPPED rather than running its
      // old mode. Say so explicitly — "failed to restart" alone would imply
      // nothing changed.
      const reason = start.data?.error || (start.status ? `HTTP ${start.status}` : 'the server is unreachable')
      notify('error', `Engine stopped but did not start again (${reason}) — start it manually from the dashboard.`)
      onRestart?.() // refresh engine status to reflect the stop
    }
    setRestarting(false)
  }

  const handleToggleDryRun = () => {
    if (pendingWriteRef.current > 0) return // a save or another toggle is already in flight
    const next = !config.dryRun
    persistToggle(
      'Dry Run',
      () => apiPatch(`/api/${exchange}/config${pairQuery}`, { dryRun: next }, { allowEmpty: true }),
      () => setConfig(prev => ({ ...prev, dryRun: next })),
      () => setConfig(prev => ({ ...prev, dryRun: !next })),
      saved => adoptSaved(prev => ({ ...prev, dryRun: saved?.dryRun ?? next })),
    )
  }

  const handleToggleEnabled = () => {
    if (pendingWriteRef.current > 0) return // a save or another toggle is already in flight
    if (isRegime) {
      // Regime funds track activation in regime.enabled — persist via the regime
      // config endpoint (a fund-level PATCH would write the wrong field).
      const next = !regimeConfig.enabled
      persistToggle(
        'Enabled',
        () => apiPut(`/api/${exchange}/regime/config${pairQuery}`, { enabled: next }, { allowEmpty: true }),
        () => setConfig(prev => ({ ...prev, regime: { ...prev.regime, enabled: next } })),
        () => setConfig(prev => ({ ...prev, regime: { ...prev.regime, enabled: !next } })),
        saved => adoptSaved(prev => ({
          ...prev,
          regime: { ...prev.regime, enabled: saved?.enabled ?? next },
        })),
      )
    } else {
      const next = !config.enabled
      persistToggle(
        'Enabled',
        () => apiPatch(`/api/${exchange}/config${pairQuery}`, { enabled: next }, { allowEmpty: true }),
        () => setConfig(prev => ({ ...prev, enabled: next })),
        () => setConfig(prev => ({ ...prev, enabled: !next })),
        saved => adoptSaved(prev => ({ ...prev, enabled: saved?.enabled ?? next })),
      )
    }
  }

  // Render-state mirror of pendingWriteRef: true while a full-form save OR a
  // top-level toggle autosave is in flight. Drives the disabled state of every
  // fund-config control (inputs, selects, both toggles, Save, Reset) so the
  // two write paths can't be interleaved from the UI, while global preset
  // editing (savingPresets/presetsDirty) stays on its own, independent gate.
  const locked = saving || toggleBusy

  const CONSOLIDATE_INTERVAL_OPTIONS = [
    { value: 'never', label: 'Off' },
    { value: 'daily', label: 'Daily' },
    { value: 'weekly', label: 'Weekly' },
  ]

  const DCA_STRATEGY_OPTIONS = [
    { value: 'fixed', label: 'Fixed Amount DCA' },
    { value: 'fibonacci', label: 'Fibonacci DCA' },
  ]

  // Generate Fibonacci preview sequence
  const getFibPreview = (baseAmount, count = 8) => {
    const fib = [1, 1]
    for (let i = 2; i < count; i++) fib.push(fib[i-1] + fib[i-2])
    return fib.map(n => `$${(n * baseAmount).toFixed(0)}`).join(' → ')
  }

  const quoteCurrency = getQuoteCurrency(config.productId)
  const baseCurrency = getBaseCurrency(config.productId)
  const intervalsToSpread = config.intervalsToSpread || config.daysToSpread || 1
  const intervalAmount = intervalsToSpread ? (config.totalAllocation / intervalsToSpread) : 0
  const intervalLabel = INTERVAL_OPTIONS.find(o => o.value === config.intervalType)?.label || 'Daily'

  // Describe consolidation behavior
  const getConsolidationStatus = () => {
    const threshold = config.consolidateAfterOrders || 0
    const interval = config.consolidateInterval || 'never'
    const parts = []
    if (threshold > 0) parts.push(`when orders > ${threshold}`)
    if (interval !== 'never') parts.push(`${interval}`)
    if (parts.length === 0) return 'Manual only'
    return parts.join(' + ')
  }

  return (
    <div>
      {/* Sticky action bar for fund configuration save/reset */}
      <div className="sticky top-0 z-10 bg-gray-800 border-b border-gray-700 p-4 mb-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Button
              variant={isDirty ? 'primary' : 'primary-muted'}
              className="font-medium"
              onClick={handleSave}
              disabled={locked}
            >
              {saving ? 'Saving...' : 'Save Configuration'}
            </Button>
            {isDirty && (
              <Button
                variant="secondary"
                className="font-medium"
                onClick={handleReset}
                disabled={locked}
              >
                Reset
              </Button>
            )}
            {isDirty && (
              <span className="text-sm font-medium text-yellow-400">Unsaved changes</span>
            )}
          </div>
        </div>
      </div>

      <div className="bg-gray-800 rounded-lg p-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Bot Configuration</h2>
          <div className="flex items-center gap-3">
            <ToggleSwitch
              label="Enabled"
              checked={Boolean(isRegime ? regimeConfig.enabled : config.enabled)}
              onChange={handleToggleEnabled}
              disabled={locked}
              colorOn="bg-green-500"
              hint={isRegime ? 'Shows the fund as Ready in the fund list. Does not start or stop trading; use Start / Stop in the fund header.' : undefined}
            />
            <ToggleSwitch
              label="Dry Run"
              checked={Boolean(config.dryRun)}
              onChange={handleToggleDryRun}
              disabled={locked}
              colorOn="bg-yellow-500"
            />
          </div>
        </div>

        {restartNeeded && (
          <div className="mb-3 p-2 rounded-sm text-sm bg-amber-900/40 border border-amber-700 text-amber-200 flex items-center justify-between gap-3">
            <span>⚠️ Dry-run mode is applied when the engine starts — restart it for this change to take effect.</span>
            <Button
              variant="caution"
              size="xs"
              className="font-medium whitespace-nowrap"
              onClick={handleRestartEngine}
              disabled={restarting}
            >
              {restarting ? 'Restarting…' : 'Restart Engine'}
            </Button>
          </div>
        )}

        {/* Strategy Header */}
        <div className="border-b border-gray-700 pb-3 mb-4">
          {isRegime ? (
            <div className="bg-purple-900/30 border border-purple-700/50 rounded-sm p-3 text-xs">
              <div className="flex items-center justify-between mb-2">
                <span className="text-purple-400 font-medium">Regime-Aware Volatility Engine Configuration</span>
              </div>
              <p className="text-gray-400 leading-relaxed mb-3">
                An advanced volatility-driven trading system that replaces fixed-interval DCA with ATR-based triggers.
                It adapts to three market regimes: <span className="text-green-400">HARVEST</span> (mean-reverting, full entries),
                <span className="text-yellow-400"> CAUTION</span> (elevated volatility, reduced sizing), and
                <span className="text-red-400"> TREND</span> (strong momentum; buys scaled by Trend Scale, none at 0). Uses real-time WebSocket data,
                dynamic take-profit based on recent volatility, and automatic safety modes.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-gray-400">
                <div>
                  <span className="text-gray-400">Entry Trigger:</span>
                  <span className="ml-1 text-white">k × ATR price move</span>
                </div>
                <div>
                  <span className="text-gray-400">Position Sizing:</span>
                  <span className="ml-1 text-white">Liquidity-aware ladder</span>
                </div>
                <div>
                  <span className="text-gray-400">Take-Profit:</span>
                  <span className="ml-1 text-white">Dynamic volatility-based</span>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-4 mb-2">
                <FormSelect
                  label="DCA Strategy"
                  value={config.dcaStrategy || 'fixed'}
                  onChange={(v) => handleChange('dcaStrategy', v)}
                  options={DCA_STRATEGY_OPTIONS}
                  className="w-48"
                />
                {isFibonacci && (
                  <FormInput
                    label="Fib Base Amount"
                    value={config.fibBaseAmount || 10}
                    onChange={(v) => handleChange('fibBaseAmount', v)}
                    type="number"
                    className="w-32"
                  />
                )}
              </div>
              {isFibonacci && (
                <div className="bg-gray-900/50 rounded-sm p-3 text-xs">
                  <div className="text-gray-400 mb-1">
                    <span className="text-yellow-400 font-medium">Fibonacci Sequence:</span>{' '}
                    <span className="text-white font-mono">{getFibPreview(config.fibBaseAmount || 10)}</span>
                  </div>
                  <p className="text-gray-400 leading-relaxed">
                    This strategy is a volatility-harvesting accumulation system that incrementally builds an asset position using
                    Fibonacci-sized buys on a fixed cadence during sideways conditions, continuously resetting a limit-sell order
                    based on the updated weighted cost basis while retaining a small percentage as long-term inventory.
                    It relies on short-term mean reversion within low-to-moderate volatility regimes to capture small, repeated
                    price oscillations that exceed the effective fee floor (~0.045% per entry), making modest profit targets
                    (sub-1%) more structurally aligned than large moves. There is no directional edge; the mechanism is position
                    sizing plus inventory cycling, and during trending or volatility expansion regimes it transitions from a
                    trading system into an asset accumulation engine, concentrating capital over a short window (Fibonacci ramp)
                    and potentially locking funds into drawdowns, which is acceptable under the assumption of long-term asset
                    conviction and no need for near-term capital liquidity.
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        {/* Regular DCA Trading Settings - 3 column grid */}
        {!isRegime && (
          // A native disabled fieldset gates every input/select/checkbox below in
          // one place (browser-enforced, no per-field disabled prop needed) while
          // display:contents keeps it out of the layout so the grid/flex classes
          // on its children behave exactly as they did inside the old Fragment.
          <fieldset disabled={locked} className="contents">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 mb-4">
              <FormInput label="Product ID" value={config.productId} onChange={(v) => handleChange('productId', v)} />
              {!isFibonacci && (
                <>
                  <FormInput label={`Allocation (${quoteCurrency})`} value={config.totalAllocation} onChange={(v) => handleChange('totalAllocation', v)} type="number" />
                  <FormInput label="Intervals" value={config.intervalsToSpread} onChange={(v) => handleChange('intervalsToSpread', v)} type="number" />
                </>
              )}
              <FormSelect label="Interval" value={config.intervalType} onChange={(v) => handleChange('intervalType', v)} options={INTERVAL_OPTIONS} />
              <FormInput label="Markup %" value={config.sellMarkupPercent} onChange={(v) => handleChange('sellMarkupPercent', v)} type="number" />
              <FormInput label="Holdback %" value={config.holdbackPercent} onChange={(v) => handleChange('holdbackPercent', v)} type="number" />
              <FormInput label={`Min Order (${quoteCurrency})`} value={config.minOrderSize} onChange={(v) => handleChange('minOrderSize', v)} type="number" />
              <FormInput label={`Max Price (${quoteCurrency})`} value={config.maxBuyPrice} onChange={(v) => handleChange('maxBuyPrice', v)} type="number" />
            </div>
            {/* Holdback vs Markup validation warning */}
            {(() => {
              const holdback = config.holdbackPercent || 0;
              const markup = config.sellMarkupPercent || 1;
              const cashReturn = (1 - holdback / 100) * (1 + markup / 100) * 100 - 100;
              const maxHoldbackForCashBreakeven = (markup / (1 + markup / 100)).toFixed(2);

              if (holdback > markup && holdback > 0) {
                return (
                  <div className="mb-4 p-2 bg-amber-900/30 border border-amber-600/50 rounded-sm text-xs">
                    <div className="text-amber-400 font-medium mb-1">⚠️ Holdback exceeds Markup</div>
                    <div className="text-gray-300">
                      Each cycle returns{' '}
                      <span className="text-red-400 font-medium">{cashReturn.toFixed(2)}% cash</span>
                      {' '}but gains{' '}
                      <span className="text-green-400 font-medium">+{holdback}% {baseCurrency}</span>.
                      <div className="mt-1 text-gray-400">
                        For cash-neutral cycles at {markup}% markup, set holdback ≤ {maxHoldbackForCashBreakeven}%.
                      </div>
                    </div>
                  </div>
                );
              }
              return null;
            })()}

            {/* Consolidation - inline row (hidden for Fibonacci which handles its own consolidation) */}
            {!isFibonacci && (
              <div className="border-t border-gray-700 pt-3 mb-4">
                <div className="flex items-center gap-4">
                  <span className="text-xs text-gray-400 whitespace-nowrap">Auto-Consolidate:</span>
                  <div className="flex items-center gap-2">
                    <span id="consolidate-when-label" className="text-xs text-gray-400">When orders &gt;</span>
                    <input
                      aria-labelledby="consolidate-when-label"
                      type="number"
                      value={config.consolidateAfterOrders || 0}
                      onChange={(e) => handleChange('consolidateAfterOrders', parseInt(e.target.value) || 0)}
                      className="w-16 px-2 py-1 bg-gray-700 border border-gray-600 rounded-sm text-sm text-white focus:outline-hidden focus:border-blue-500"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span id="consolidate-schedule-label" className="text-xs text-gray-400">or on schedule:</span>
                    <select
                      aria-labelledby="consolidate-schedule-label"
                      value={config.consolidateInterval || 'never'}
                      onChange={(e) => handleChange('consolidateInterval', e.target.value)}
                      className="px-2 py-1 bg-gray-700 border border-gray-600 rounded-sm text-sm text-white focus:outline-hidden focus:border-blue-500"
                    >
                      {CONSOLIDATE_INTERVAL_OPTIONS.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                  <span className="text-xs text-gray-400 ml-auto">
                    Active: <span className="text-white">{getConsolidationStatus()}</span>
                  </span>
                </div>
              </div>
            )}

            {/* Calculated Values - compact */}
            <div className="border-t border-gray-700 pt-3 mb-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                {!isFibonacci && (
                  <div>
                    <span className="text-gray-400">Buy per {intervalLabel}:</span>
                    <span className="ml-1 text-white">${intervalAmount.toFixed(2)}</span>
                  </div>
                )}
                {isFibonacci && (
                  <div>
                    <span className="text-gray-400">Strategy:</span>
                    <span className="ml-1 text-yellow-400">Fibonacci</span>
                  </div>
                )}
                <div>
                  <span className="text-gray-400">Return/Cycle:</span>
                  <span className="ml-1 text-green-400">
                    +{((1 - config.holdbackPercent / 100) * (1 + config.sellMarkupPercent / 100) * 100 - 100).toFixed(2)}%
                  </span>
                </div>
                <div>
                  <span className="text-gray-400">Holdback:</span>
                  <span className="ml-1 text-white">{config.holdbackPercent}%</span>
                </div>
                <div>
                  <span className="text-gray-400">Sell Multiplier:</span>
                  <span className="ml-1 text-white">{(1 + config.sellMarkupPercent / 100).toFixed(2)}x</span>
                </div>
              </div>
            </div>
          </fieldset>
        )}

        {/* Regime Engine Settings - 2-column card grid */}
        {isRegime && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Every card up to (but excluding) Aggressiveness Presets sits inside
                this fieldset, same rationale as the DCA one above: one disabled
                boolean gates the whole fund config, and display:contents lets its
                children remain direct grid items so the lg:col-span-2 cards still
                span correctly. Presets are a sibling outside it — global preset
                editing (savingPresets) stays independent of this save/toggle gate. */}
            <fieldset disabled={locked} className="contents">

            {/* Volatility Clock */}
            <SectionCard title="Volatility Clock">
              <div className="grid grid-cols-2 gap-3">
                <FormInput label="Product ID" hint="Trading pair (e.g. BTC-USDC)" value={config.productId} onChange={(v) => handleChange('productId', v)} />
                <FormInput label={`Base Size (${quoteCurrency})`} hint="Quote-currency amount per entry order" value={regimeConfig.baseSizeUsdc || 50} onChange={(v) => handleRegimeChange('baseSizeUsdc', v)} type="number" />
                <FormInput label="k Factor (ATR mult)" hint="Higher = longer waits between entries" value={regimeConfig.kFactor || 0.6} onChange={(v) => handleRegimeChange('kFactor', v)} type="number" />
                <FormInput label="ATR Period" hint="# of candles for ATR calculation" value={regimeConfig.atrPeriod || 14} onChange={(v) => handleRegimeChange('atrPeriod', v)} type="number" />
                <FormInput label="Min Interval (ms)" hint="Fastest allowed entry interval" value={regimeConfig.minIntervalMs || 60000} onChange={(v) => handleRegimeChange('minIntervalMs', v)} type="number" />
                <FormInput label="Max Interval (ms)" hint="Slowest entry interval (low-vol cap)" value={regimeConfig.maxIntervalMs || 3600000} onChange={(v) => handleRegimeChange('maxIntervalMs', v)} type="number" />
              </div>
            </SectionCard>

            {/* Regime Scaling */}
            <SectionCard title="Regime Scaling">
              <div className="grid grid-cols-2 gap-3">
                <FormInput label="Harvest Scale" hint="Size multiplier in calm, mean-reverting markets" value={regimeConfig.harvestScale || 1.0} onChange={(v) => handleRegimeChange('harvestScale', v)} type="number" />
                <FormInput label="Caution Scale" hint="Size multiplier during elevated volatility" value={regimeConfig.cautionScale ?? 0.5} onChange={(v) => handleRegimeChange('cautionScale', v)} type="number" />
                <FormInput label="Trend Scale" hint="Size multiplier in strong trends (0 = no entries)" value={regimeConfig.trendScale ?? 0.0} onChange={(v) => handleRegimeChange('trendScale', v)} type="number" />
                <FormInput label="Max Cycle Buys" hint="Max buys per cycle before pausing entries" value={regimeConfig.maxCycleBuys || 10} onChange={(v) => handleRegimeChange('maxCycleBuys', v)} type="number" />
                <FormInput label="Min Order Size ($)" hint="Floor for order size after all multipliers" value={regimeConfig.minOrderSizeUsdc || 5} onChange={(v) => handleRegimeChange('minOrderSizeUsdc', v)} type="number" />
              </div>
              <div className="mt-2 text-xs text-gray-400">
                Scaling: HARVEST={regimeConfig.harvestScale ?? 1.0}x, CAUTION={regimeConfig.cautionScale ?? 0.5}x, TREND={regimeConfig.trendScale ?? 0.0}x base size
              </div>
            </SectionCard>

            {/* Entry Mode & Ladder - full width */}
            <SectionCard title="Entry Mode & Ladder" className="lg:col-span-2">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
                <FormSelect
                  label="Entry Mode"
                  hint="Reactive: one order per trigger. Ladder: multiple orders spread across price levels"
                  value={regimeConfig.entryMode || 'reactive'}
                  onChange={(v) => handleRegimeChange('entryMode', v)}
                  options={[
                    { value: 'reactive', label: 'Reactive (single order)' },
                    { value: 'ladder', label: 'Ladder (pre-positioned)' }
                  ]}
                />
                <div className="pt-5">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="ladderAutoSwitch"
                      checked={regimeConfig.ladderAutoSwitch || false}
                      onChange={(e) => handleRegimeChange('ladderAutoSwitch', e.target.checked)}
                      className="w-4 h-4 rounded-sm bg-gray-700 border-gray-600"
                    />
                    <label htmlFor="ladderAutoSwitch" className="text-sm text-gray-300">Auto-Switch on Vol</label>
                  </div>
                  <div className="text-2xs text-gray-400 mt-0.5 leading-tight">Switch from reactive to ladder when vol spikes</div>
                </div>
                {regimeConfig.ladderAutoSwitch && (
                  <FormInput label="Auto-Switch Vol Mult" hint="Switch to ladder when realized volatility reaches this multiple of its baseline (1.5 = 50% above)" value={regimeConfig.ladderAutoSwitchVolMult || 2.0} onChange={(v) => handleRegimeChange('ladderAutoSwitchVolMult', v)} type="number" />
                )}
              </div>
              {(regimeConfig.entryMode === 'ladder' || regimeConfig.ladderAutoSwitch) && (
                <>
                  <div className="bg-indigo-900/20 border border-indigo-700/30 rounded-sm p-3 mb-3">
                    <div className="text-xs text-indigo-300">
                      <span className="font-medium">Ladder Mode:</span> Deploys all available {quoteCurrency} as limit buy orders from just below current price
                      down to an ATH-based floor with Fibonacci-weighted sizing. Orders stay in place during flash events; rebuild only after cycle reset.
                    </div>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <FormInput label="Max ATH Drop %" hint="Floor = ATH × (1 - this/100). 80 means lowest bid at 20% of ATH" value={regimeConfig.ladderMaxAthDropPct || 80} onChange={(v) => handleRegimeChange('ladderMaxAthDropPct', v)} type="number" />
                    <FormInput label="Min Spacing %" hint="Minimum gap between adjacent rungs" value={regimeConfig.ladderMinSpacingPct || 0.5} onChange={(v) => handleRegimeChange('ladderMinSpacingPct', v)} type="number" />
                    <FormSelect
                      label="Spacing Mode"
                      hint="How orders are distributed across the price range"
                      value={regimeConfig.ladderSpacingMode || 'sqrt'}
                      onChange={(v) => handleRegimeChange('ladderSpacingMode', v)}
                      options={[
                        { value: 'linear', label: 'Linear (even spacing)' },
                        { value: 'sqrt', label: 'Sqrt (denser near top)' },
                        { value: 'exponential', label: 'Exponential (denser at bottom)' }
                      ]}
                    />
                    <FormSelect
                      label="Size Mode"
                      hint="How order sizes scale across the ladder"
                      value={regimeConfig.ladderSizeMode || 'fibonacci'}
                      onChange={(v) => handleRegimeChange('ladderSizeMode', v)}
                      options={[
                        { value: 'fibonacci', label: 'Fibonacci (escalating at bottom)' },
                        { value: 'flat', label: 'Flat (equal sizes)' },
                        { value: 'linear', label: 'Linear (larger at bottom)' },
                        { value: 'sqrt', label: 'Sqrt (moderate scaling)' }
                      ]}
                    />
                  </div>
                  <div className="mt-2 text-xs text-gray-400">
                    Dynamic order count. Floor at {regimeConfig.ladderMaxAthDropPct || 80}% below ATH. {regimeConfig.ladderSizeMode || 'fibonacci'} sizing across all available {quoteCurrency}.
                    {regimeConfig.ladderAutoSwitch && ` Auto-switches to ladder when vol expands ${regimeConfig.ladderAutoSwitchVolMult || 2.0}x.`}
                  </div>
                </>
              )}
            </SectionCard>

            {/* Take-Profit */}
            <SectionCard title="Take-Profit">
              <div className="grid grid-cols-2 gap-3">
                <FormInput label="TP Multiplier" hint="ATR-based TP scaling factor" value={regimeConfig.tpMult || 1.0} onChange={(v) => handleRegimeChange('tpMult', v)} type="number" />
                <FormInput label="TP Min %" hint="Floor for take-profit percentage" value={regimeConfig.tpMinPercent || 2.0} onChange={(v) => handleRegimeChange('tpMinPercent', v)} type="number" />
                <FormInput label="TP Max %" hint="Ceiling for take-profit percentage" value={regimeConfig.tpMaxPercent || 15.0} onChange={(v) => handleRegimeChange('tpMaxPercent', v)} type="number" />
                <FormInput label="Holdback Ratio" hint="Base share of gross TP profit allocated to retained asset (0-1)" value={regimeConfig.holdbackRatio ?? 0.5} onChange={(v) => handleRegimeChange('holdbackRatio', v)} type="number" />
              </div>
              <div className="mt-2 text-xs text-gray-400">
                Base allocation: <span className="text-white font-medium">{((regimeConfig.holdbackRatio ?? 0.5) * 100).toFixed(0)}%</span> of gross TP profit to retained {baseCurrency}, valued at the target price.
                {' '}The body tier multiplies this ratio; the effective profit share is capped at 95%.
                {' '}Example: 0.01 BTC at $100,000/BTC targeting $110,000/BTC, with ratio 0.5 and tier scale 1, has $100 gross profit. Allocating $50 to retained BTC leaves about 0.00045455 BTC (4.55% of the position), with about 0.00954545 BTC to sell.
                {' '}This example excludes fees and rounds quantities to eight decimals. Actual placement also applies quantity rounding, a minimum holdback, fee floors and exchange minimums; net returns are not guaranteed.
              </div>
            </SectionCard>

            {/* Regime Detection */}
            <SectionCard title="Regime Detection">
              <div className="grid grid-cols-2 gap-3">
                <FormInput label="Momentum Mult" hint="VWAP divergence threshold (×10 bps)" value={regimeConfig.momentumMult || 1.5} onChange={(v) => handleRegimeChange('momentumMult', v)} type="number" />
                <FormInput label="Vol Expansion" hint="realizedVol/baseline ratio to enter CAUTION" value={regimeConfig.volExpansionMult || 1.5} onChange={(v) => handleRegimeChange('volExpansionMult', v)} type="number" />
                <FormInput label="Vol Contraction" hint="realizedVol/baseline ratio to return to HARVEST" value={regimeConfig.volContractionMult || 1.2} onChange={(v) => handleRegimeChange('volContractionMult', v)} type="number" />
                <FormInput label="VWAP Hours" hint="Rolling window for VWAP calculation" value={regimeConfig.vwapPeriodHours || 4} onChange={(v) => handleRegimeChange('vwapPeriodHours', v)} type="number" />
                <FormInput label="Trend Confirm Periods" hint="Consecutive momentum periods to confirm TREND" value={regimeConfig.trendConfirmationPeriods || 5} onChange={(v) => handleRegimeChange('trendConfirmationPeriods', v)} type="number" />
              </div>
            </SectionCard>

            {/* Celestial Hierarchy - full width */}
            <SectionCard title="Celestial Hierarchy" className="lg:col-span-2">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-3">
                <ToggleSwitch
                  label="Enable Celestial Bodies"
                  checked={regimeConfig.celestialEnabled !== false}
                  onChange={() => handleRegimeChange('celestialEnabled', !(regimeConfig.celestialEnabled !== false))}
                />
                {regimeConfig.celestialEnabled !== false && (
                  <span className="text-xs text-cyan-400">
                    Buys become celestial bodies that consolidate and promote through tiers
                  </span>
                )}
              </div>
              {regimeConfig.celestialEnabled !== false && (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <FormInput label="Max Celestial Bodies" hint="Max concurrent body TP orders (1-1000)" value={regimeConfig.maxCelestialBodies ?? 10} onChange={(v) => handleRegimeChange('maxCelestialBodies', Math.round(v))} type="number" />
                    <FormInput label="Merge Proximity Scale" hint="How aggressively bodies merge (0.25=conservative, 1.0=default, 3.0=aggressive)" value={regimeConfig.mergeProximityScale ?? 1.0} onChange={(v) => handleRegimeChange('mergeProximityScale', Math.max(0.25, Math.min(3.0, Math.round(v * 100) / 100)))} type="number" />
                  </div>
                  <div className="mt-2 text-xs text-gray-400">
                    Each buy creates a celestial body. Bodies merge when TP prices are close, and promote to higher tiers as mass grows.
                    Tiers: {CELESTIAL_TIERS.map(t => `${t.emoji} ${t.label.toLowerCase()}`).join(' → ')}.
                    Higher tiers have wider TP targets and hold more {baseCurrency}.
                  </div>
                  <div className="mt-2 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-9 gap-1 text-xs text-center">
                    {CELESTIAL_TIERS.map(tier => (
                      <div key={tier.name} className="bg-gray-800/50 rounded-sm p-1">
                        <div>{tier.emoji}</div>
                        <div className="text-gray-400">{tier.label}</div>
                        <div className="text-gray-400">{formatTierCapitalRange(tier, regimeConfig.maxUsdcDeployed || 10000)}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </SectionCard>

            {/* Macro Regime - full width */}
            <SectionCard title="Macro Regime (Multi-Timeframe)" className="lg:col-span-2">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-3">
                <ToggleSwitch
                  label="Enable Macro Regime"
                  checked={Boolean(regimeConfig.macroEnabled)}
                  onChange={() => handleRegimeChange('macroEnabled', !regimeConfig.macroEnabled)}
                />
                {regimeConfig.macroEnabled && (
                  <span className="text-xs text-cyan-400">
                    Hourly + daily EMA overlay modulates sizing, TP, and entry offset
                  </span>
                )}
              </div>
              {regimeConfig.macroEnabled && (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
                    <FormInput label="Update Interval (ms)" hint="How often to re-score macro (60000-600000)" value={regimeConfig.macroUpdateIntervalMs ?? 300000} onChange={(v) => handleRegimeChange('macroUpdateIntervalMs', v)} type="number" />
                    <FormInput label="Suggestion Delay (hours)" hint="Stable long-term bias divergence before an advisory (0.01–720). Never changes sizing automatically." value={regimeConfig.aggressivenessSuggestionHours ?? 6} onChange={(v) => handleRegimeChange('aggressivenessSuggestionHours', v)} type="number" />
                    <FormInput label="Hysteresis" hint="Score buffer to prevent mode chatter (1-20)" value={regimeConfig.macroHysteresis ?? 5} onChange={(v) => handleRegimeChange('macroHysteresis', v)} type="number" />
                    <FormInput label="Accumulation Threshold" hint="Score below this = ACCUMULATION" value={regimeConfig.macroAccumulationThreshold ?? -15} onChange={(v) => handleRegimeChange('macroAccumulationThreshold', v)} type="number" />
                    <FormInput label="Decline Threshold" hint="Score below this = DECLINE" value={regimeConfig.macroDeclineThreshold ?? -50} onChange={(v) => handleRegimeChange('macroDeclineThreshold', v)} type="number" />
                    <FormInput label="Markup Threshold" hint="Score above this = MARKUP" value={regimeConfig.macroMarkupThreshold ?? 35} onChange={(v) => handleRegimeChange('macroMarkupThreshold', v)} type="number" />
                  </div>
                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                    <div className="bg-green-900/15 border border-green-800/30 rounded-sm p-3">
                      <div className="text-xs text-green-400 font-medium mb-2">Accumulation (buying dips harder)</div>
                      <div className="grid grid-cols-3 gap-2">
                        <FormInput label="Size" hint="0.1-3.0" value={regimeConfig.macroAccumulationSizeMult ?? 1.3} onChange={(v) => handleRegimeChange('macroAccumulationSizeMult', v)} type="number" />
                        <FormInput label="TP" hint="Tighter" value={regimeConfig.macroAccumulationTpMult ?? 0.85} onChange={(v) => handleRegimeChange('macroAccumulationTpMult', v)} type="number" />
                        <FormInput label="Offset" hint="Tighter" value={regimeConfig.macroAccumulationOffsetMult ?? 0.8} onChange={(v) => handleRegimeChange('macroAccumulationOffsetMult', v)} type="number" />
                      </div>
                    </div>
                    <div className="bg-yellow-900/15 border border-yellow-800/30 rounded-sm p-3">
                      <div className="text-xs text-yellow-400 font-medium mb-2">Markup (uptrend — reduce exposure)</div>
                      <div className="grid grid-cols-3 gap-2">
                        <FormInput label="Size" hint="0.1-3.0" value={regimeConfig.macroMarkupSizeMult ?? 0.7} onChange={(v) => handleRegimeChange('macroMarkupSizeMult', v)} type="number" />
                        <FormInput label="TP" hint="Wider" value={regimeConfig.macroMarkupTpMult ?? 1.3} onChange={(v) => handleRegimeChange('macroMarkupTpMult', v)} type="number" />
                        <FormInput label="Offset" hint="Wider" value={regimeConfig.macroMarkupOffsetMult ?? 1.2} onChange={(v) => handleRegimeChange('macroMarkupOffsetMult', v)} type="number" />
                      </div>
                    </div>
                    <div className="bg-red-900/15 border border-red-800/30 rounded-sm p-3">
                      <div className="text-xs text-red-400 font-medium mb-2">Decline (capitulation — conservative)</div>
                      <div className="grid grid-cols-3 gap-2">
                        <FormInput label="Size" hint="0.1-3.0" value={regimeConfig.macroDeclineSizeMult ?? 0.4} onChange={(v) => handleRegimeChange('macroDeclineSizeMult', v)} type="number" />
                        <FormInput label="TP" hint="Tighter" value={regimeConfig.macroDeclineTpMult ?? 0.7} onChange={(v) => handleRegimeChange('macroDeclineTpMult', v)} type="number" />
                        <FormInput label="Offset" hint="Wider" value={regimeConfig.macroDeclineOffsetMult ?? 1.5} onChange={(v) => handleRegimeChange('macroDeclineOffsetMult', v)} type="number" />
                      </div>
                    </div>
                  </div>
                  <div className="mt-2 text-xs text-gray-400">
                    RANGING mode uses 1.0x for all multipliers (passthrough). Score range: -100 to +100. Thresholds must be ordered: decline &lt; accumulation &lt; markup.
                  </div>
                </>
              )}
            </SectionCard>

            {/* TP Auto-Management - full width */}
            <SectionCard title="TP Auto-Management" className="lg:col-span-2">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-3">
                <ToggleSwitch
                  label="Enable Auto-Management"
                  checked={Boolean(regimeConfig.tpAutoManaged)}
                  onChange={() => handleRegimeChange('tpAutoManaged', !regimeConfig.tpAutoManaged)}
                />
                {regimeConfig.tpAutoManaged && (
                  <span className="text-xs text-cyan-400">
                    TP values will be dynamically adjusted based on observed cycle data
                  </span>
                )}
              </div>
              {regimeConfig.tpAutoManaged && (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                    <FormInput label="Evaluation Cycles" hint="Re-evaluate TP after this many completed cycles" value={regimeConfig.tpEvaluationCycles || 5} onChange={(v) => handleRegimeChange('tpEvaluationCycles', v)} type="number" />
                    <FormInput label="Eval Max Hours" hint="Max hours before forcing TP re-evaluation" value={regimeConfig.tpEvaluationMaxHours || 24} onChange={(v) => handleRegimeChange('tpEvaluationMaxHours', v)} type="number" />
                    <FormInput label="Min Sample Size" hint="Min fills needed before first auto-adjust" value={regimeConfig.tpMinSampleSize || 10} onChange={(v) => handleRegimeChange('tpMinSampleSize', v)} type="number" />
                    <FormInput label="Max Change %" hint="Max single adjustment to TP values" value={regimeConfig.tpMaxChangePercent || 25} onChange={(v) => handleRegimeChange('tpMaxChangePercent', v)} type="number" />
                    <FormInput label="TP Absolute Min %" hint="Hard floor: TP can never go below this" value={regimeConfig.tpAbsoluteMin || 0.05} onChange={(v) => handleRegimeChange('tpAbsoluteMin', v)} type="number" />
                    <FormInput label="TP Absolute Max %" hint="Hard ceiling: TP can never go above this" value={regimeConfig.tpAbsoluteMax || 5.0} onChange={(v) => handleRegimeChange('tpAbsoluteMax', v)} type="number" />
                  </div>
                  <div className="mt-2 text-xs text-gray-400">
                    Auto-adjusts TP range every {regimeConfig.tpEvaluationCycles || 5} cycles or {regimeConfig.tpEvaluationMaxHours || 24}h.
                    Requires {regimeConfig.tpMinSampleSize || 10} samples before first adjustment.
                    Holdback auto-set to half of TP Min.
                  </div>
                </>
              )}
            </SectionCard>

            {/* Risk Caps */}
            <SectionCard title="Risk Caps">
              <div className="grid grid-cols-2 gap-3">
                <FormInput label="Deposited Capital" hint="Your actual cash deposits (0 = auto-derive)" value={regimeConfig.depositedCapital || 0} onChange={(v) => handleRegimeChange('depositedCapital', v)} type="number" />
                <FormInput label={`Max ${baseCurrency} Exposure`} hint={`Max ${baseCurrency} the engine can hold (0 = uncapped)`} value={regimeConfig.maxAssetExposure ?? 0} onChange={(v) => handleRegimeChange('maxAssetExposure', v)} type="number" />
                <FormInput label={`Max Deployed (${quoteCurrency})`} hint={`Max ${quoteCurrency} deployed across active orders`} value={regimeConfig.maxUsdcDeployed || 10000} onChange={(v) => handleRegimeChange('maxUsdcDeployed', v)} type="number" />
                <FormInput label="Max Drawdown %" hint="Pause new buys when fund equity (capital + realized + held coins at market) falls this % below its peak" value={regimeConfig.maxDrawdownPercent || 20} onChange={(v) => handleRegimeChange('maxDrawdownPercent', v)} type="number" />
                <FormInput label="Liquidity Factor Cap" hint="Max size multiplier from orderbook liquidity" value={regimeConfig.liquidityFactorCap || 2.0} onChange={(v) => handleRegimeChange('liquidityFactorCap', v)} type="number" />
                <FormInput label="Drawdown Reset (hrs)" hint="Hours at drawdown cap before auto-resuming (0 = off)" value={regimeConfig.drawdownResetHours ?? 72} onChange={(v) => handleRegimeChange('drawdownResetHours', v)} type="number" />
                <FormInput label="Cycle Reset (hrs)" hint="Hours at cycle buys limit before auto-resetting (0 = off)" value={regimeConfig.cycleResetHours ?? 72} onChange={(v) => handleRegimeChange('cycleResetHours', v)} type="number" />
              </div>
              <div className="mt-2 text-xs text-gray-400">
                Auto-reset hours: 0 = disabled. After this time at a limit, the engine resumes with reset counters.
              </div>
            </SectionCard>

            {/* Order Execution */}
            <SectionCard title="Order Execution">
              <div className="grid grid-cols-2 gap-3">
                <FormInput label="Entry Offset (bps)" hint="Place limit buy this many bps below market" value={regimeConfig.entryOffsetBps ?? 10} onChange={(v) => handleRegimeChange('entryOffsetBps', v)} type="number" />
                <FormInput label="Entry Offset Up (bps)" hint="Offset when momentum is UP (tighter to fill before rise)" value={regimeConfig.entryOffsetUpBps ?? 5} onChange={(v) => handleRegimeChange('entryOffsetUpBps', v)} type="number" />
                <FormInput label="Entry Offset Down (bps)" hint="Offset when momentum is DOWN (deeper to catch the dip)" value={regimeConfig.entryOffsetDownBps ?? 15} onChange={(v) => handleRegimeChange('entryOffsetDownBps', v)} type="number" />
                <FormInput label="Entry Max Retries" hint="Retry cancelled entries up to this many times" value={regimeConfig.entryMaxRetries || 3} onChange={(v) => handleRegimeChange('entryMaxRetries', v)} type="number" />
                <FormInput label="Order Stale Floor (ms)" hint="Min entry timeout; actual scales with offset²/ATR², capped at Max Interval" value={regimeConfig.orderStaleMs || 30000} onChange={(v) => handleRegimeChange('orderStaleMs', v)} type="number" />
                <FormInput label="Cancel Rate Limit (ms)" hint="Min wait between cancel API calls" value={regimeConfig.cancelRateLimitMs || 1000} onChange={(v) => handleRegimeChange('cancelRateLimitMs', v)} type="number" />
                <FormInput label="Max Open Orders" hint="Max simultaneous entry orders allowed" value={regimeConfig.maxOpenOrders || 3} onChange={(v) => handleRegimeChange('maxOpenOrders', v)} type="number" />
                <FormInput label="TP Update Threshold %" hint="Min price change before updating TP order" value={regimeConfig.tpUpdateThresholdPct || 0.5} onChange={(v) => handleRegimeChange('tpUpdateThresholdPct', v)} type="number" />
                <FormInput label="Reconcile Interval (ms)" hint="How often to sync local state with exchange" value={regimeConfig.reconcileIntervalMs || 300000} onChange={(v) => handleRegimeChange('reconcileIntervalMs', v)} type="number" />
              </div>
            </SectionCard>

            {/* Safety & Tail Events — only applies to reactive mode */}
            <SectionCard title="Safety & Tail Events">
              <p className="text-xs text-gray-400 mb-3">
                Depth-based entry protection is unavailable in this build.
              </p>
              {regimeConfig.entryMode === 'ladder' ? (
                <div className="text-xs text-gray-400 italic">
                  These settings apply to Reactive mode only. Ladder mode bypasses tail event checks — the ladder IS the flash event strategy.
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <FormInput label="Max Spread (bps)" hint="Pause entries when bid-ask spread exceeds this" value={regimeConfig.maxSpreadBps || 50} onChange={(v) => handleRegimeChange('maxSpreadBps', v)} type="number" />
                    <FormInput label="Spread Pause (ms)" hint="How long to pause after spread breach" value={regimeConfig.spreadPauseMs || 300000} onChange={(v) => handleRegimeChange('spreadPauseMs', v)} type="number" />
                    <FormInput label="Flash Move Mult" hint="ATR multiplier to detect flash crashes" value={regimeConfig.flashMoveMult || 3.0} onChange={(v) => handleRegimeChange('flashMoveMult', v)} type="number" />
                    <FormInput label="Flash Cooldown (ms)" hint="Pause duration after flash event detected" value={regimeConfig.flashCooldownMs || 600000} onChange={(v) => handleRegimeChange('flashCooldownMs', v)} type="number" />
                  </div>
                  <div className="mt-3">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="cancelEntriesOnFlash"
                        checked={regimeConfig.cancelEntriesOnFlash !== false}
                        onChange={(e) => handleRegimeChange('cancelEntriesOnFlash', e.target.checked)}
                        className="w-4 h-4 rounded-sm bg-gray-700 border-gray-600"
                      />
                      <label htmlFor="cancelEntriesOnFlash" className="text-sm text-gray-300">Cancel Entries on Flash</label>
                    </div>
                    <div className="text-2xs text-gray-400 mt-0.5 leading-tight">Pull all pending entries during flash events</div>
                  </div>
                </>
              )}
            </SectionCard>

            {/* System Health */}
            <SectionCard title="System Health">
              <div className="grid grid-cols-2 gap-3">
                <FormInput label="Stale Data (ms)" hint="Enter SAFE mode if no ticker data for this long" value={regimeConfig.staleDataMs || 30000} onChange={(v) => handleRegimeChange('staleDataMs', v)} type="number" />
                <FormInput label="Stale Orders (ms)" hint="Flag orders as stale after this duration" value={regimeConfig.staleOrdersMs || 60000} onChange={(v) => handleRegimeChange('staleOrdersMs', v)} type="number" />
                <FormInput label="Max Latency (ms)" hint="Enter SAFE mode if API latency exceeds this" value={regimeConfig.maxLatencyMs || 5000} onChange={(v) => handleRegimeChange('maxLatencyMs', v)} type="number" />
                <FormInput label="Safe Recovery (ms)" hint="Time healthy before exiting SAFE mode" value={regimeConfig.safeRecoveryMs || 60000} onChange={(v) => handleRegimeChange('safeRecoveryMs', v)} type="number" />
                <FormInput label="Max REST Errors" hint="Consecutive API errors before SAFE mode" value={regimeConfig.maxRestErrors || 5} onChange={(v) => handleRegimeChange('maxRestErrors', v)} type="number" />
                <FormInput label="Max Rate Limits" hint="Consecutive rate limits before SAFE mode" value={regimeConfig.maxRateLimits || 3} onChange={(v) => handleRegimeChange('maxRateLimits', v)} type="number" />
              </div>
              <div className="mt-2 text-xs text-gray-400">
                System enters SAFE mode when health thresholds are exceeded. Safe Recovery is time healthy before exiting SAFE.
              </div>
            </SectionCard>
            </fieldset>

            {/* Aggressiveness Presets Editor — full width */}
            {presetsError && !editingPresets && (
              <div role="alert" className="lg:col-span-2 flex items-center gap-3 text-sm text-yellow-400">
                <span>{presetsError}</span>
                <Button variant="secondary" size="xs" onClick={() => loadPresets()}>Retry</Button>
              </div>
            )}
            {editingPresets && (
              <SectionCard title="Aggressiveness Presets" className="lg:col-span-2">
                <div className="text-xs text-gray-400 mb-3">
                  Customize the parameter values applied by each aggressiveness level on the dashboard.
                </div>
                <fieldset disabled={savingPresets} className="contents">
                <div className="space-y-2">
                  {[
                    { id: 'conservative', label: 'Conservative', color: 'text-green-400' },
                    { id: 'moderate', label: 'Moderate', color: 'text-blue-400' },
                    { id: 'aggressive', label: 'Aggressive', color: 'text-yellow-400' },
                    { id: 'maximum', label: 'Maximum', color: 'text-red-400' },
                  ].map(({ id, label, color }) => {
                    const isExpanded = expandedPresets.has(id)
                    const params = editingPresets[id] || {}
                    return (
                      <div key={id} className="bg-gray-800/60 rounded-lg overflow-hidden">
                        <button
                          onClick={() => togglePresetExpanded(id)}
                          className="w-full flex items-center justify-between px-3 py-2 hover:bg-gray-700/50 transition-colors"
                        >
                          <span className={`text-sm font-medium ${color}`}>{label}</span>
                          <span className="text-gray-500 text-xs">{isExpanded ? '▼' : '▶'}</span>
                        </button>
                        {isExpanded && (
                          <div className="px-3 pb-3">
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                              <FormInput label="k Factor" value={params.kFactor} onChange={(v) => handlePresetParamChange(id, 'kFactor', v)} type="number" />
                              <FormInput label="Min Interval (ms)" value={params.minIntervalMs} onChange={(v) => handlePresetParamChange(id, 'minIntervalMs', v)} type="number" />
                              <FormInput label="Max Interval (ms)" value={params.maxIntervalMs} onChange={(v) => handlePresetParamChange(id, 'maxIntervalMs', v)} type="number" />
                              <FormInput label="Entry Offset (bps)" value={params.entryOffsetBps} onChange={(v) => handlePresetParamChange(id, 'entryOffsetBps', v)} type="number" />
                              <FormInput label="Entry Offset Up (bps)" value={params.entryOffsetUpBps} onChange={(v) => handlePresetParamChange(id, 'entryOffsetUpBps', v)} type="number" />
                              <FormInput label="Entry Offset Down (bps)" value={params.entryOffsetDownBps} onChange={(v) => handlePresetParamChange(id, 'entryOffsetDownBps', v)} type="number" />
                              <FormInput label="Order Stale Floor (ms)" value={params.orderStaleMs} onChange={(v) => handlePresetParamChange(id, 'orderStaleMs', v)} type="number" />
                              <FormInput label="Caution Scale" value={params.cautionScale} onChange={(v) => handlePresetParamChange(id, 'cautionScale', v)} type="number" />
                              <FormInput label="Trend Scale" value={params.trendScale} onChange={(v) => handlePresetParamChange(id, 'trendScale', v)} type="number" />
                              <FormInput label="Max Cycle Buys" value={params.maxCycleBuys} onChange={(v) => handlePresetParamChange(id, 'maxCycleBuys', v)} type="number" />
                              <FormInput label="Merge Proximity Scale" hint="0.25–3.0; higher values merge nearby bodies more readily" value={params.mergeProximityScale} onChange={(v) => handlePresetParamChange(id, 'mergeProximityScale', v)} type="number" />
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
                <div className="flex gap-2 mt-3">
                  <Button
                    variant="purple"
                    size="compact"
                    className="font-medium"
                    onClick={handleSavePresets}
                    disabled={savingPresets || !presetsDirty}
                  >
                    {savingPresets ? 'Saving...' : presetsDirty ? 'Save Presets *' : 'Save Presets'}
                  </Button>
                  {presetsDirty && (
                    <Button
                      variant="secondary"
                      size="compact"
                      className="font-medium"
                      onClick={handleResetPresets}
                    >
                      Reset
                    </Button>
                  )}
                </div>
                </fieldset>
              </SectionCard>
            )}
          </div>
        )}

      </div>

      {/* Warning - more compact */}
      <p className="mt-3 text-xs text-gray-400">
        {isRegime
          ? 'Saved settings are applied to the running engine immediately. A Dry Run change takes effect after the engine restarts.'
          : 'Changes take effect on the next run. The bot will not make additional trades this interval if it has already run.'}
      </p>
    </div>
  )
}

export default ConfigEditor
