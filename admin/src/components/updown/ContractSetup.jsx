import Button from '../ui/Button'
import { useState, useEffect, useRef, useCallback, useId } from 'react'
import { FileText, Save, Camera, Upload, Check, X, Loader2 } from '../icons'
import { createRequestOwner } from '../../utils/requestOwner.mjs'
import { apiGet, apiPut, apiRequest, describeMutationFailure } from '../../utils/apiClient'
import { pnlColorClass, signedPrefix } from '../../utils/pnlFormat.mjs'

const LS_PROVIDER_KEY = 'updown-screenshot-provider'
const LS_MODEL_KEY = 'updown-screenshot-model'

function normalizeContract(c) {
  if (!c) return null
  let expiry = ''
  if (typeof c.expiry === 'number' && c.expiry > 0) {
    expiry = new Date(c.expiry).toISOString()
  } else if (c.expiry) {
    const d = new Date(c.expiry)
    expiry = !isNaN(d.getTime()) ? d.toISOString() : c.expiry.toString()
  }
  const dir = c.direction || ''
  const direction = dir ? dir.charAt(0).toUpperCase() + dir.slice(1).toLowerCase() : 'Up'
  const parseNumStr = (val) => {
    if (val == null || val === '') return ''
    const num = parseFloat(val)
    return !isNaN(num) ? num.toString() : val.toString()
  }
  return {
    expiry,
    target: parseNumStr(c.target),
    stop: parseNumStr(c.stop),
    range: parseNumStr(c.range) || '500',
    direction,
  }
}

function areContractsEqual(a, b) {
  if (!a && !b) return true
  if (!a || !b) return false
  const na = normalizeContract(a)
  const nb = normalizeContract(b)
  return (
    na.expiry === nb.expiry &&
    na.target === nb.target &&
    na.stop === nb.stop &&
    na.range === nb.range &&
    na.direction === nb.direction
  )
}

function contractKey(c) {
  if (!c) return ''
  const norm = normalizeContract(c)
  return `${norm.expiry}-${norm.target}-${norm.stop}-${norm.range}-${norm.direction}`
}

function getContractRevision(c) {
  if (!c || typeof c !== 'object') return null
  for (const prop of ['version', 'revision', 'rev', 'updatedAt', 'timestamp', 'seq']) {
    const val = c[prop]
    if (val != null) {
      const num = Number(val)
      return !isNaN(num) ? num : val
    }
  }
  return null
}

export default function ContractSetup({ initialContract }) {
  const providerSelectId = useId()
  const modelSelectId = useId()
  const expiryId = useId()
  const targetId = useId()
  const stopId = useId()
  const rangeId = useId()

  const init = normalizeContract(initialContract) || {
    expiry: '',
    target: '',
    stop: '',
    range: '500',
    direction: 'Up',
  }

  const [expiry, setExpiry] = useState(init.expiry)
  const [target, setTarget] = useState(init.target)
  const [stop, setStop] = useState(init.stop)
  const [range, setRange] = useState(init.range)
  const [direction, setDirection] = useState(init.direction)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState('')

  // Write serialization guard: ensures Save and screenshot Apply writes cannot overlap
  const writeLockRef = useRef(false)

  // Revision & baseline tracking
  const baselineRef = useRef(init)
  const draftRef = useRef({ ...init })
  const draftRevisionRef = useRef(0)
  const confirmedRevisionRef = useRef(0)
  const prevContractRef = useRef(initialContract ? contractKey(initialContract) : null)
  const lastObservedServerKeyRef = useRef(initialContract ? contractKey(initialContract) : null)
  const lastObservedServerRevRef = useRef(getContractRevision(initialContract))
  const confirmedRevRef = useRef(getContractRevision(initialContract))
  const dirtyObservedKeysRef = useRef(new Set())
  const stalePreSaveKeysRef = useRef(new Set())
  const awaitingServerAckRef = useRef(false)

  // One "Saved" timer: an earlier save's timer must not clear a later save's confirmation.
  const savedTimerRef = useRef(null)
  const showSaved = () => {
    clearTimeout(savedTimerRef.current)
    setSaved(true)
    savedTimerRef.current = setTimeout(() => setSaved(false), 2000)
  }
  useEffect(() => () => clearTimeout(savedTimerRef.current), [])

  const markDraftEdit = () => {
    draftRevisionRef.current += 1
    clearTimeout(savedTimerRef.current)
    setSaved(false)
  }

  const handleExpiryChange = (val) => {
    markDraftEdit()
    setExpiry(val)
    draftRef.current.expiry = val
  }
  const handleTargetChange = (val) => {
    markDraftEdit()
    setTarget(val)
    draftRef.current.target = val
  }
  const handleStopChange = (val) => {
    markDraftEdit()
    setStop(val)
    draftRef.current.stop = val
  }
  const handleRangeChange = (val) => {
    markDraftEdit()
    setRange(val)
    draftRef.current.range = val
  }
  const handleDirectionChange = (val) => {
    if (draftRef.current.direction !== val) {
      markDraftEdit()
      setDirection(val)
      draftRef.current.direction = val
    }
  }

  // Screenshot AI state
  const [providers, setProviders] = useState(null) // null = not loaded
  const [providersError, setProvidersError] = useState('')
  const [selectedProvider, setSelectedProvider] = useState(() => localStorage.getItem(LS_PROVIDER_KEY) || '')
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem(LS_MODEL_KEY) || '')
  const [analyzing, setAnalyzing] = useState(false)
  const [preview, setPreview] = useState(null) // extracted data from AI
  const [screenshotError, setScreenshotError] = useState('')
  const [screenshotNotice, setScreenshotNotice] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef(null)
  const dropZoneRef = useRef(null)
  const screenshotRequestOwner = useRef(null)
  if (!screenshotRequestOwner.current) screenshotRequestOwner.current = createRequestOwner()

  const prevContextRef = useRef({ provider: selectedProvider, model: selectedModel })
  const initialModelPopulatedRef = useRef(!selectedProvider || Boolean(selectedModel))

  useEffect(() => () => screenshotRequestOwner.current.invalidate(), [])
  useEffect(() => {
    const isFirstRender =
      prevContextRef.current.provider === selectedProvider &&
      prevContextRef.current.model === selectedModel
    if (isFirstRender) return

    const providerChanged = prevContextRef.current.provider !== selectedProvider
    const modelChanged = prevContextRef.current.model !== selectedModel
    prevContextRef.current = { provider: selectedProvider, model: selectedModel }

    if (!providerChanged && modelChanged && !initialModelPopulatedRef.current) {
      initialModelPopulatedRef.current = true
      return
    }
    initialModelPopulatedRef.current = true

    screenshotRequestOwner.current.invalidate()
    setAnalyzing(false)
    setPreview(null)
    setScreenshotError('')
  }, [selectedProvider, selectedModel])

  // Only update form when the server-side contract actually changes and draft is pristine with no active write
  useEffect(() => {
    if (!initialContract) return
    const key = contractKey(initialContract)
    const rev = getContractRevision(initialContract)
    lastObservedServerKeyRef.current = key
    if (rev != null) {
      lastObservedServerRevRef.current = rev
    }

    // Check if write owns the contract or draft is dirty (not pristine)
    const isWriting = writeLockRef.current
    const isPristine = areContractsEqual(draftRef.current, baselineRef.current)

    if (isWriting || !isPristine) {
      // Record keys observed while dirty or writing so they can be treated as pre-save
      dirtyObservedKeysRef.current.add(key)
      return
    }

    // If we are awaiting status acknowledgement of our save, handle stale pre-save polls vs subsequent updates
    if (awaitingServerAckRef.current) {
      if (rev != null && confirmedRevRef.current != null) {
        if (rev <= confirmedRevRef.current) {
          // Stale pre-save response by revision metadata: drop it
          return
        }
        // Newer revision from server (external update or acknowledgement)
        stalePreSaveKeysRef.current.clear()
        awaitingServerAckRef.current = false
      } else if (stalePreSaveKeysRef.current.has(key)) {
        // Stale pre-save poll by ordering: drop once to allow subsequent restoration
        stalePreSaveKeysRef.current.delete(key)
        return
      } else {
        // Received the saved contract or a superseding update
        stalePreSaveKeysRef.current.clear()
        awaitingServerAckRef.current = false
      }
    }

    if (prevContractRef.current === key) return
    prevContractRef.current = key
    if (rev != null) {
      confirmedRevRef.current = rev
    }

    const normalized = normalizeContract(initialContract)
    baselineRef.current = normalized
    draftRef.current = { ...normalized }
    setExpiry(normalized.expiry)
    setTarget(normalized.target)
    setStop(normalized.stop)
    setRange(normalized.range)
    setDirection(normalized.direction)
  }, [initialContract])

  // Fetch available AI providers
  const loadProviders = useCallback(async () => {
    setProvidersError('')
    const result = await apiGet('/api/updown/providers')
    if (result.ok) setProviders(result.data.providers || [])
    else setProvidersError(`Could not load AI providers (${result.error}).`)
  }, [])
  useEffect(() => { loadProviders() }, [loadProviders])

  // Persist provider/model selection
  useEffect(() => {
    if (selectedProvider) localStorage.setItem(LS_PROVIDER_KEY, selectedProvider)
  }, [selectedProvider])
  useEffect(() => {
    if (selectedModel) localStorage.setItem(LS_MODEL_KEY, selectedModel)
  }, [selectedModel])

  // Auto-select model when provider changes
  useEffect(() => {
    const p = providers?.find(p => p.id === selectedProvider)
    if (!p) return
    // Keep current model if it belongs to this provider
    if (p.models?.includes(selectedModel)) return
    setSelectedModel(p.defaultModel || p.models?.[0] || '')
  }, [selectedProvider, providers])

  /** PUT the contract; any failure lands in saveError beside the Save button. */
  const saveContract = async (contract, draftSnapshot) => {
    if (writeLockRef.current) return false
    writeLockRef.current = true

    const submittedRevision = draftRevisionRef.current
    const submittedSnapshot = draftSnapshot ? { ...draftSnapshot } : { ...draftRef.current }

    setSaving(true)
    setSaved(false)
    setSaveError('')

    let result
    try {
      result = await apiPut('/api/updown/contract', contract)
    } finally {
      writeLockRef.current = false
      setSaving(false)
    }

    if (!result.ok) {
      setSaveError(describeMutationFailure(result, 'Failed to save contract'))
      return false
    }

    // Advance baseline to the submitted/confirmed snapshot
    const nextKey = contractKey(submittedSnapshot)
    const nextRev = getContractRevision(submittedSnapshot)

    stalePreSaveKeysRef.current.clear()
    if (prevContractRef.current && prevContractRef.current !== nextKey) {
      stalePreSaveKeysRef.current.add(prevContractRef.current)
    }
    if (lastObservedServerKeyRef.current && lastObservedServerKeyRef.current !== nextKey) {
      stalePreSaveKeysRef.current.add(lastObservedServerKeyRef.current)
    }
    for (const k of dirtyObservedKeysRef.current) {
      if (k !== nextKey) {
        stalePreSaveKeysRef.current.add(k)
      }
    }
    dirtyObservedKeysRef.current.clear()

    const serverRev =
      getContractRevision(result?.data?.contract) ??
      getContractRevision(result?.data) ??
      nextRev ??
      lastObservedServerRevRef.current

    confirmedRevRef.current = serverRev
    awaitingServerAckRef.current = stalePreSaveKeysRef.current.size > 0 || (confirmedRevRef.current != null)

    baselineRef.current = normalizeContract(submittedSnapshot)
    confirmedRevisionRef.current = submittedRevision
    prevContractRef.current = nextKey

    // Show Saved only for the current confirmed draft; if newer edits exist, retain them and present them as unsaved
    const hasNewerEdits =
      draftRevisionRef.current !== submittedRevision ||
      !areContractsEqual(draftRef.current, submittedSnapshot)

    if (!hasNewerEdits) {
      showSaved()
    }

    return true
  }

  const handleSave = () => {
    if (writeLockRef.current) return false
    const draftSnapshot = { ...draftRef.current }
    return saveContract({
      expiry: draftSnapshot.expiry,
      target: parseFloat(draftSnapshot.target),
      stop: parseFloat(draftSnapshot.stop),
      range: parseInt(draftSnapshot.range, 10),
      direction: draftSnapshot.direction.toLowerCase(),
    }, draftSnapshot)
  }

  const analyzeScreenshot = useCallback(async (file) => {
    if (!selectedProvider) {
      setScreenshotError('Select an AI provider first')
      return
    }
    if (!file?.type?.startsWith('image/')) {
      setScreenshotError('File must be an image')
      return
    }
    if (file.size > 20 * 1024 * 1024) {
      setScreenshotError('Image too large (max 20MB)')
      return
    }

    const owner = screenshotRequestOwner.current
    const token = owner.claim()
    setAnalyzing(true)
    setScreenshotError('')
    setScreenshotNotice('')
    setPreview(null)

    const params = new URLSearchParams({ providerId: selectedProvider })
    if (selectedModel) params.set('model', selectedModel)

    // A superseded request aborts; its AbortError is the owner's cue to stay silent.
    const result = await apiRequest('POST', `/api/updown/screenshot?${params}`, {
      rawBody: file,
      contentType: file.type,
      signal: owner.getSignal(),
    }).catch(() => null)
    if (!owner.owns(token) || !result) return
    setAnalyzing(false)

    if (!result.ok) {
      setScreenshotError(result.status === 0 ? `Request failed: ${result.error}` : result.error)
      return
    }

    setPreview(result.data.extracted)
  }, [selectedProvider, selectedModel])

  // Drag & drop handlers
  const onDragOver = useCallback((e) => { e.preventDefault(); setDragOver(true) }, [])
  const onDragLeave = useCallback(() => setDragOver(false), [])
  const onDrop = useCallback((e) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer?.files?.[0]
    if (file) analyzeScreenshot(file)
  }, [analyzeScreenshot])

  // Paste handler
  useEffect(() => {
    const el = dropZoneRef.current
    if (!el) return
    const handlePaste = (e) => {
      const items = e.clipboardData?.items
      if (!items) return
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault()
          analyzeScreenshot(item.getAsFile())
          return
        }
      }
    }
    el.addEventListener('paste', handlePaste)
    return () => el.removeEventListener('paste', handlePaste)
  }, [analyzeScreenshot])

  const applyPreview = async () => {
    if (writeLockRef.current) return
    const d = preview
    if (!d) return
    setPreview(null)
    setScreenshotError('')

    const screenType = d.screenType || 'select'
    const dir = d.direction || draftRef.current.direction

    // Update contract form fields and save (all screen types can have contract-relevant data)
    const hasContractData = d.target != null || d.stop != null || d.range != null || Boolean(d.expiryISO)
    if (screenType === 'select' || screenType === 'order' || hasContractData) {
      markDraftEdit()

      const nextTarget = d.target != null ? d.target.toString() : draftRef.current.target
      const nextStop = d.stop != null ? d.stop.toString() : draftRef.current.stop
      const nextRange = d.range != null ? d.range.toString() : draftRef.current.range
      const nextExpiry = d.expiryISO || draftRef.current.expiry
      const nextDirection = d.direction
        ? d.direction.charAt(0).toUpperCase() + d.direction.slice(1).toLowerCase()
        : draftRef.current.direction

      if (d.direction) setDirection(nextDirection)
      if (d.range != null) setRange(nextRange)
      if (d.target != null) setTarget(nextTarget)
      if (d.stop != null) setStop(nextStop)
      if (d.expiryISO) setExpiry(nextExpiry)

      draftRef.current = {
        expiry: nextExpiry,
        target: nextTarget,
        stop: nextStop,
        range: nextRange,
        direction: nextDirection,
      }

      // The form already shows the extracted values, so on failure Save Contract
      // retries exactly what Apply tried to save.
      const ok = await saveContract({
        expiry: nextExpiry,
        target: d.target ?? parseFloat(nextTarget),
        stop: d.stop ?? parseFloat(nextStop),
        range: d.range ?? parseInt(nextRange, 10),
        direction: (dir).toLowerCase(),
      }, draftRef.current)
      if (!ok) setScreenshotError('Extracted values were applied to the form but not saved — see the error below Save Contract.')
    }

    // Crypto.com screenshots contain option premiums, not BTC perp entry
    // prices. Never feed those values into the 0.01-BTC perp tracker.
    if (screenType === 'order' || screenType === 'position') {
      setScreenshotNotice('Option details applied to the contract only. Option premiums were not imported into the BTC perp tracker.')
    }
  }

  const currentProviderModels = providers?.find(p => p.id === selectedProvider)?.models || []

  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700" ref={dropZoneRef} tabIndex={-1}>
      <div className="flex items-center gap-2 mb-3">
        <FileText size={16} className="text-blue-400" />
        <h3 className="text-sm font-semibold">Contract Setup</h3>
      </div>

      {/* Screenshot AI Section */}
      <div className="mb-4 space-y-2">
        <div className="flex items-center gap-2 mb-1">
          <Camera size={14} className="text-purple-400" />
          <span className="text-xs font-medium text-purple-400">Crypto.com Option Screenshot</span>
        </div>

        {/* Provider / Model selectors */}
        <div className="grid grid-cols-2 gap-2">
          <select
            id={providerSelectId}
            aria-label="AI Provider"
            value={selectedProvider}
            onChange={e => setSelectedProvider(e.target.value)}
            className="bg-gray-900 border border-gray-700 rounded-sm px-2 py-1 text-xs text-white focus:outline-hidden focus:border-purple-500"
          >
            <option value="">Provider...</option>
            {(providers || []).map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <select
            id={modelSelectId}
            aria-label="AI Model"
            value={selectedModel}
            onChange={e => setSelectedModel(e.target.value)}
            disabled={!currentProviderModels.length}
            className="bg-gray-900 border border-gray-700 rounded-sm px-2 py-1 text-xs text-white focus:outline-hidden focus:border-purple-500 disabled:opacity-50"
          >
            <option value="">Model...</option>
            {currentProviderModels.map(m => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
        {providersError ? (
          <div role="alert" className="text-xs text-red-400 bg-red-900/20 rounded-sm px-2 py-1">
            {providersError}
            <Button type="button" onClick={loadProviders} variant="link" size="inline" className="ml-2 underline">Retry</Button>
          </div>
        ) : providers?.length === 0 && (
          <div className="text-xs text-gray-400">No enabled API providers. Add one on the AI Providers page to read screenshots.</div>
        )}

        {/* Drop zone */}
        <div
          onClick={() => fileInputRef.current?.click()}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          className={`border-2 border-dashed rounded-lg p-3 text-center cursor-pointer transition-colors ${
            dragOver
              ? 'border-purple-400 bg-purple-900/20'
              : analyzing
                ? 'border-yellow-500/50 bg-yellow-900/10'
                : 'border-gray-600 hover:border-gray-500 hover:bg-gray-700/30'
          }`}
        >
          {analyzing ? (
            <div className="flex items-center justify-center gap-2 text-yellow-400">
              <Loader2 size={16} className="animate-spin" />
              <span className="text-xs">Analyzing screenshot...</span>
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2 text-gray-400">
              <Upload size={14} />
              <span className="text-xs">Drop, paste, or click to upload screenshot</span>
            </div>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={e => {
            const file = e.target.files?.[0]
            if (file) analyzeScreenshot(file)
            e.target.value = ''
          }}
        />

        {/* Error display */}
        {screenshotError && (
          <div className="text-xs text-red-400 bg-red-900/20 rounded-sm px-2 py-1">
            {screenshotError}
          </div>
        )}
        {screenshotNotice && (
          <div className="text-xs text-blue-300 bg-blue-900/20 border border-blue-700/40 rounded-sm p-2" role="status">
            {screenshotNotice}
          </div>
        )}

        {/* Preview overlay */}
        {preview && (
          <div className="bg-gray-900 border border-purple-500/50 rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-medium text-purple-400">Extracted Values</span>
              {preview.screenType && (
                <span className={`text-2xs px-1.5 py-0.5 rounded font-medium ${
                  preview.screenType === 'select' ? 'bg-blue-900/50 text-blue-400' :
                  preview.screenType === 'order' ? 'bg-yellow-900/50 text-yellow-400' :
                  'bg-green-900/50 text-green-400'
                }`}>
                  {preview.screenType === 'select' ? 'Select Screen' : preview.screenType === 'order' ? 'Order Screen' : 'Position Screen'}
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              {preview.direction && (
                <div className="flex justify-between">
                  <span className="text-gray-400">Direction</span>
                  <span className={`font-medium ${preview.direction === 'Up' ? 'text-green-400' : 'text-red-400'}`}>{preview.direction}</span>
                </div>
              )}
              {/* Select screen fields */}
              {preview.screenType !== 'position' && preview.range && (
                <div className="flex justify-between">
                  <span className="text-gray-400">Range</span>
                  <span className="text-white font-medium">${preview.range}</span>
                </div>
              )}
              {preview.screenType !== 'position' && preview.target && (
                <div className="flex justify-between">
                  <span className="text-gray-400">Target</span>
                  <span className="text-green-400 font-medium">${preview.target.toLocaleString()}</span>
                </div>
              )}
              {preview.screenType !== 'position' && preview.stop && (
                <div className="flex justify-between">
                  <span className="text-gray-400">Stop</span>
                  <span className="text-red-400 font-medium">${preview.stop.toLocaleString()}</span>
                </div>
              )}
              {preview.currentPrice && (
                <div className="flex justify-between">
                  <span className="text-gray-400">BTC Price</span>
                  <span className="text-white font-medium">${preview.currentPrice.toLocaleString()}</span>
                </div>
              )}
              {preview.expiresIn && (
                <div className="flex justify-between">
                  <span className="text-gray-400">Expires</span>
                  <span className="text-white font-medium">{preview.expiresIn}</span>
                </div>
              )}
              {/* Select screen: string maxProfit/maxLoss */}
              {preview.screenType === 'select' && preview.maxProfit && (
                <div className="flex justify-between">
                  <span className="text-gray-400">Max Profit</span>
                  <span className="text-green-400 font-medium">{preview.maxProfit}</span>
                </div>
              )}
              {preview.screenType === 'select' && preview.maxLoss && (
                <div className="flex justify-between">
                  <span className="text-gray-400">Max Loss</span>
                  <span className="text-red-400 font-medium">{preview.maxLoss}</span>
                </div>
              )}
              {/* Order screen fields */}
              {preview.screenType === 'order' && preview.contractPrice && (
                <div className="flex justify-between">
                  <span className="text-gray-400">Contract Price</span>
                  <span className="text-white font-medium">${preview.contractPrice.toLocaleString()}</span>
                </div>
              )}
              {preview.screenType === 'order' && preview.contracts && (
                <div className="flex justify-between">
                  <span className="text-gray-400">Contracts</span>
                  <span className="text-white font-medium">{preview.contracts}</span>
                </div>
              )}
              {preview.screenType === 'order' && preview.maxProfitAmount != null && (
                <div className="flex justify-between">
                  <span className="text-gray-400">Max Profit</span>
                  <span className="text-green-400 font-medium">${preview.maxProfitAmount.toLocaleString()}</span>
                </div>
              )}
              {preview.screenType === 'order' && preview.maxLossAmount != null && (
                <div className="flex justify-between">
                  <span className="text-gray-400">Max Loss</span>
                  <span className="text-red-400 font-medium">${preview.maxLossAmount.toLocaleString()}</span>
                </div>
              )}
              {preview.screenType === 'order' && preview.youPay != null && (
                <div className="flex justify-between">
                  <span className="text-gray-400">You Pay</span>
                  <span className="text-yellow-400 font-medium">${preview.youPay.toLocaleString()}</span>
                </div>
              )}
              {/* Position screen fields */}
              {preview.screenType === 'position' && preview.entryPrice && (
                <div className="flex justify-between">
                  <span className="text-gray-400">Entry Price</span>
                  <span className="text-white font-medium">${preview.entryPrice.toLocaleString()}</span>
                </div>
              )}
              {preview.screenType === 'position' && preview.priceToClose != null && (
                <div className="flex justify-between">
                  <span className="text-gray-400">Price to Close</span>
                  <span className="text-white font-medium">${preview.priceToClose.toLocaleString()}</span>
                </div>
              )}
              {preview.screenType === 'position' && preview.unrealizedPnl != null && (
                <div className="flex justify-between">
                  <span className="text-gray-400">Unrealized P&L</span>
                  <span className={`font-medium ${pnlColorClass(preview.unrealizedPnl)}`}>
                    {signedPrefix(preview.unrealizedPnl)}${preview.unrealizedPnl.toLocaleString()}
                  </span>
                </div>
              )}
              {preview.screenType === 'position' && preview.contracts && (
                <div className="flex justify-between">
                  <span className="text-gray-400">Contracts</span>
                  <span className="text-white font-medium">{preview.contracts}</span>
                </div>
              )}
              {preview.screenType === 'position' && preview.expiresOn && (
                <div className="flex justify-between col-span-2">
                  <span className="text-gray-400">Expires on</span>
                  <span className="text-white font-medium">{preview.expiresOn}</span>
                </div>
              )}
            </div>
            <div className="flex gap-2 pt-1">
              <Button
                onClick={applyPreview}
                disabled={saving}
                variant="purple" size="compact-xs" className="flex-1 font-medium gap-1"
              >
                <Check size={12} /> Apply
              </Button>
              <Button
                onClick={() => setPreview(null)}
                variant="secondary" size="compact-xs" className="flex-1 font-medium gap-1"
              >
                <X size={12} /> Cancel
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-gray-700 pt-3 space-y-3">
        <div>
          <label htmlFor={expiryId} className="text-xs text-gray-400 block mb-1">Expiry (ISO / date-time)</label>
          <input
            id={expiryId}
            type="text"
            value={expiry}
            onChange={e => handleExpiryChange(e.target.value)}
            placeholder="2026-02-21T00:00:00Z"
            className="w-full bg-gray-900 border border-gray-700 rounded-sm px-3 py-1.5 text-sm text-white placeholder-gray-400 focus:outline-hidden focus:border-blue-500"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={targetId} className="text-xs text-gray-400 block mb-1">Target Price ($)</label>
            <input
              id={targetId}
              type="number"
              value={target}
              onChange={e => handleTargetChange(e.target.value)}
              placeholder="100000"
              className="w-full bg-gray-900 border border-gray-700 rounded-sm px-3 py-1.5 text-sm text-white placeholder-gray-400 focus:outline-hidden focus:border-blue-500"
            />
          </div>
          <div>
            <label htmlFor={stopId} className="text-xs text-gray-400 block mb-1">Stop Price ($)</label>
            <input
              id={stopId}
              type="number"
              value={stop}
              onChange={e => handleStopChange(e.target.value)}
              placeholder="95000"
              className="w-full bg-gray-900 border border-gray-700 rounded-sm px-3 py-1.5 text-sm text-white placeholder-gray-400 focus:outline-hidden focus:border-blue-500"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={rangeId} className="text-xs text-gray-400 block mb-1">Range</label>
            <select
              id={rangeId}
              value={range}
              onChange={e => handleRangeChange(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded-sm px-3 py-1.5 text-sm text-white focus:outline-hidden focus:border-blue-500"
            >
              <option value="500">$500</option>
              <option value="2000">$2,000</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Direction</label>
            <div className="flex gap-2">
              <Button
                onClick={() => handleDirectionChange('Up')}
                variant={direction === 'Up' ? 'success' : 'secondary'} size="compact" className="flex-1 font-medium"
              >
                Up
              </Button>
              <Button
                onClick={() => handleDirectionChange('Down')}
                variant={direction === 'Down' ? 'destructive' : 'secondary'} size="compact" className="flex-1 font-medium"
              >
                Down
              </Button>
            </div>
          </div>
        </div>

        <Button
          onClick={handleSave}
          disabled={saving}
          variant="primary" size="md" className="w-full font-medium gap-2"
        >
          <Save size={14} />
          {saving ? 'Saving...' : saved ? 'Saved' : 'Save Contract'}
        </Button>
        {saveError && <div className="text-xs text-red-400" role="alert">{saveError}</div>}
      </div>
    </div>
  )
}
