import { FormInput, FormSelect, SectionCard } from './config/ConfigFormControls'
import { VolatilityClockCard, RegimeScalingCard, EntryModeLadderCard, TakeProfitCard, RegimeDetectionCard, CelestialHierarchyCard, MacroRegimeCard, TpAutoManagementCard, RiskCapsCard, OrderExecutionCard, SafetyTailEventsCard, SystemHealthCard } from './config/RegimeConfigCards'
import { describeConfigSaveError } from '../utils/configSaveError.mjs'
import { apiGet, apiPost, apiPut, apiPatch } from '../utils/apiClient'
import { buildSavePayload } from '../utils/configSavePayload.mjs'
import { INTERVAL_OPTIONS } from '../utils/intervals.mjs'
import { useState, useEffect, useRef, useCallback } from 'react'
import ToggleSwitch from './ToggleSwitch'
import { useNotify, useToast } from './Toast'
import Button from './ui/Button'
import { getBaseCurrency, getQuoteCurrency } from '../App'

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
  // Count of in-flight configuration operations, including restart. Saves and both
  // top-level toggle auto-saves share this one ref so the write paths can
  // never overlap — a slow full save can no longer be raced by a toggle
  // PATCH (or vice versa), which previously let Save submit a PUT containing
  // an unconfirmed optimistic toggle value (#455). It is checked synchronously
  // at the top of every save, toggle and restart handler, so a
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
  const restartNeeded = isRegime && engineRunning === true && typeof engineDryRun === 'boolean' && baselineRef.current?.dryRun !== engineDryRun

  // Sync with initialConfig when not dirty (e.g., server-side refresh). Skip
  // while a save, toggle or restart operation is in
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
        // The acknowledged baseline and onSave's refetch drive the banner.
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
    if (pendingWriteRef.current > 0) return
    pendingWriteRef.current += 1
    setRestarting(true)
    const intendedDryRun = baselineRef.current?.dryRun
    try {
      const stop = await apiPost(`/api/${exchange}/regime/stop${pairQuery}`, undefined, { allowEmpty: true })
      if (!stop.ok) {
        const stopErr = stop.data || {}
        const alreadyStopped = typeof stopErr.error === 'string' && stopErr.error.includes('not running')
        if (!alreadyStopped) {
          // Never start after an unconfirmed stop: the old engine may still trade.
          const reason = stop.status
            ? (stopErr.error || `HTTP ${stop.status}`)
            : 'the server is unreachable'
          notify('error', `Could not stop the engine to apply the change (${reason}). It may still be running with its previous Dry Run setting — retry the restart.`)
          onRestart?.()
          return
        }
      }
      const start = await apiPost(`/api/${exchange}/regime/start${pairQuery}`, undefined, { allowEmpty: true })
      if (start.ok) {
        const refreshed = await apiGet(`/api/${exchange}/regime/status${pairQuery}`)
        const status = refreshed.data?.status
        if (refreshed.ok && status?.isRunning === true && typeof intendedDryRun === 'boolean' && status.isDryRun === intendedDryRun) {
          dismissRestartWarning()
          notify('success', 'Engine restarted — change applied')
        } else {
          warnRestartNeeded('Restart requested, but the running engine could not be confirmed with the saved Dry Run setting. Refresh engine status before trading or retrying.')
        }
        onSave?.()
        onRestart?.()
      } else {
        const reason = start.data?.error || (start.status ? `HTTP ${start.status}` : 'the server is unreachable')
        notify('error', `Engine stopped but did not start again (${reason}) — start it manually from the dashboard.`)
        onRestart?.()
      }
    } finally {
      pendingWriteRef.current -= 1
      setRestarting(false)
    }
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

  // Render-state mirror of pendingWriteRef: true while a save, toggle or
  // restart is in flight. Drives the disabled state of every
  // fund-config control (inputs, selects, both toggles, Save, Reset) so the
  // two write paths can't be interleaved from the UI, while global preset
  // editing (savingPresets/presetsDirty) stays on its own, independent gate.
  const locked = saving || toggleBusy || restarting

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
          <div className="flex flex-wrap items-center gap-3">
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
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-4">
          <h2 className="shrink-0 text-lg font-semibold">Bot Configuration</h2>
          <div className="flex flex-wrap items-start gap-3 w-full min-w-0 md:w-auto md:max-w-lg">
            <div className="min-w-0 flex-1 basis-48">
              <ToggleSwitch
                label="Enabled"
                checked={Boolean(isRegime ? regimeConfig.enabled : config.enabled)}
                onChange={handleToggleEnabled}
                disabled={locked}
                colorOn="bg-green-500"
                hint={isRegime ? 'Shows the fund as Ready in the fund list. Does not start or stop trading; use Start / Stop in the fund header.' : undefined}
              />
            </div>
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
              disabled={locked}
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

              <VolatilityClockCard config={config} regimeConfig={regimeConfig} quoteCurrency={quoteCurrency} handleChange={handleChange} handleRegimeChange={handleRegimeChange} />
              <RegimeScalingCard regimeConfig={regimeConfig} handleRegimeChange={handleRegimeChange} />
              <EntryModeLadderCard regimeConfig={regimeConfig} quoteCurrency={quoteCurrency} handleRegimeChange={handleRegimeChange} />
              <TakeProfitCard regimeConfig={regimeConfig} baseCurrency={baseCurrency} handleRegimeChange={handleRegimeChange} />
              <RegimeDetectionCard regimeConfig={regimeConfig} handleRegimeChange={handleRegimeChange} />
              <CelestialHierarchyCard regimeConfig={regimeConfig} baseCurrency={baseCurrency} handleRegimeChange={handleRegimeChange} />
              <MacroRegimeCard regimeConfig={regimeConfig} handleRegimeChange={handleRegimeChange} />
              <TpAutoManagementCard regimeConfig={regimeConfig} handleRegimeChange={handleRegimeChange} />
              <RiskCapsCard regimeConfig={regimeConfig} baseCurrency={baseCurrency} quoteCurrency={quoteCurrency} handleRegimeChange={handleRegimeChange} />
              <OrderExecutionCard regimeConfig={regimeConfig} handleRegimeChange={handleRegimeChange} />
              <SafetyTailEventsCard regimeConfig={regimeConfig} handleRegimeChange={handleRegimeChange} />
              <SystemHealthCard regimeConfig={regimeConfig} handleRegimeChange={handleRegimeChange} />
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
