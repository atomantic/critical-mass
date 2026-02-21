import { useState, useEffect, useRef, useCallback } from 'react'
import { FileText, Save, Camera, Upload, Check, X, Loader2 } from 'lucide-react'

const LS_PROVIDER_KEY = 'updown-screenshot-provider'
const LS_MODEL_KEY = 'updown-screenshot-model'

export default function ContractSetup({ initialContract, onPositionSet }) {
  const [expiry, setExpiry] = useState('')
  const [target, setTarget] = useState('')
  const [stop, setStop] = useState('')
  const [range, setRange] = useState('500')
  const [direction, setDirection] = useState('Up')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  // Screenshot AI state
  const [providers, setProviders] = useState([])
  const [selectedProvider, setSelectedProvider] = useState(() => localStorage.getItem(LS_PROVIDER_KEY) || '')
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem(LS_MODEL_KEY) || '')
  const [analyzing, setAnalyzing] = useState(false)
  const [preview, setPreview] = useState(null) // extracted data from AI
  const [screenshotError, setScreenshotError] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef(null)
  const dropZoneRef = useRef(null)

  useEffect(() => {
    if (!initialContract) return
    // Expiry is stored as ms timestamp; display as ISO string for the user
    const expiryVal = initialContract.expiry
    if (typeof expiryVal === 'number' && expiryVal > 0) {
      setExpiry(new Date(expiryVal).toISOString())
    } else {
      setExpiry(expiryVal || '')
    }
    setTarget(initialContract.target?.toString() || '')
    setStop(initialContract.stop?.toString() || '')
    setRange(initialContract.range?.toString() || '500')
    const dir = initialContract.direction || ''
    setDirection(dir ? dir.charAt(0).toUpperCase() + dir.slice(1) : 'Up')
  }, [initialContract])

  // Fetch available AI providers
  useEffect(() => {
    fetch('/api/updown/providers')
      .then(r => r.json())
      .then(data => {
        if (data.success) setProviders(data.providers)
      })
      .catch(() => {})
  }, [])

  // Persist provider/model selection
  useEffect(() => {
    if (selectedProvider) localStorage.setItem(LS_PROVIDER_KEY, selectedProvider)
  }, [selectedProvider])
  useEffect(() => {
    if (selectedModel) localStorage.setItem(LS_MODEL_KEY, selectedModel)
  }, [selectedModel])

  // Auto-select model when provider changes
  useEffect(() => {
    const p = providers.find(p => p.id === selectedProvider)
    if (!p) return
    // Keep current model if it belongs to this provider
    if (p.models?.includes(selectedModel)) return
    setSelectedModel(p.defaultModel || p.models?.[0] || '')
  }, [selectedProvider, providers])

  const handleSave = async () => {
    setSaving(true)
    setSaved(false)
    const res = await fetch('/api/updown/contract', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expiry,
        target: parseFloat(target),
        stop: parseFloat(stop),
        range: parseInt(range, 10),
        direction: direction.toLowerCase(),
      }),
    })
    if (res.ok) {
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    }
    setSaving(false)
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

    setAnalyzing(true)
    setScreenshotError('')
    setPreview(null)

    const params = new URLSearchParams({ providerId: selectedProvider })
    if (selectedModel) params.set('model', selectedModel)

    const res = await fetch(`/api/updown/screenshot?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type },
      body: file,
    }).catch(err => {
      setScreenshotError(`Request failed: ${err.message}`)
      setAnalyzing(false)
      return null
    })
    if (!res) return

    const data = await res.json().catch(() => null)
    setAnalyzing(false)

    if (!res.ok || !data?.success) {
      setScreenshotError(data?.error || `Server error ${res.status}`)
      return
    }

    setPreview(data.extracted)
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
    const d = preview
    if (!d) return
    setPreview(null)
    setScreenshotError('')

    const screenType = d.screenType || 'select'
    const dir = d.direction || direction

    // Update contract form fields and save (all screen types can have contract-relevant data)
    const hasContractData = d.target || d.stop || d.range || d.expiryISO
    if (screenType === 'select' || screenType === 'order' || hasContractData) {
      if (d.direction) setDirection(d.direction)
      if (d.range) setRange(d.range.toString())
      if (d.target) setTarget(d.target.toString())
      if (d.stop) setStop(d.stop.toString())
      if (d.expiryISO) setExpiry(d.expiryISO)

      setSaving(true)
      setSaved(false)
      const res = await fetch('/api/updown/contract', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expiry: d.expiryISO || expiry,
          target: d.target ?? parseFloat(target),
          stop: d.stop ?? parseFloat(stop),
          range: d.range ?? parseInt(range, 10),
          direction: (dir).toLowerCase(),
        }),
      })
      if (res.ok) {
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      } else {
        setScreenshotError('Failed to save contract')
      }
      setSaving(false)
    }

    // For order and position screens, also set the position
    if (screenType === 'order' || screenType === 'position') {
      const entryPrice = screenType === 'order' ? d.contractPrice : d.entryPrice
      if (!entryPrice || !dir) {
        setScreenshotError('Missing entry price or direction for position')
        return
      }
      const posRes = await fetch('/api/updown/position', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entryPrice,
          contracts: d.contracts || 1,
          direction: dir.toLowerCase(),
        }),
      })
      if (!posRes.ok) {
        setScreenshotError('Failed to save position')
        return
      }
      onPositionSet?.()
    }
  }

  const currentProviderModels = providers.find(p => p.id === selectedProvider)?.models || []

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
          <span className="text-xs font-medium text-purple-400">Screenshot Import</span>
        </div>

        {/* Provider / Model selectors */}
        <div className="grid grid-cols-2 gap-2">
          <select
            value={selectedProvider}
            onChange={e => setSelectedProvider(e.target.value)}
            className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-purple-500"
          >
            <option value="">Provider...</option>
            {providers.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <select
            value={selectedModel}
            onChange={e => setSelectedModel(e.target.value)}
            disabled={!currentProviderModels.length}
            className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-purple-500 disabled:opacity-50"
          >
            <option value="">Model...</option>
            {currentProviderModels.map(m => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>

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
          <div className="text-xs text-red-400 bg-red-900/20 rounded px-2 py-1">
            {screenshotError}
          </div>
        )}

        {/* Preview overlay */}
        {preview && (
          <div className="bg-gray-900 border border-purple-500/50 rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-medium text-purple-400">Extracted Values</span>
              {preview.screenType && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
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
                  <span className={`font-medium ${preview.unrealizedPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {preview.unrealizedPnl >= 0 ? '+' : ''}${preview.unrealizedPnl.toLocaleString()}
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
              <button
                onClick={applyPreview}
                className="flex-1 py-1.5 bg-purple-600 hover:bg-purple-700 rounded text-xs font-medium transition-colors flex items-center justify-center gap-1"
              >
                <Check size={12} /> Apply
              </button>
              <button
                onClick={() => setPreview(null)}
                className="flex-1 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs font-medium transition-colors flex items-center justify-center gap-1"
              >
                <X size={12} /> Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-gray-700 pt-3 space-y-3">
        <div>
          <label className="text-xs text-gray-400 block mb-1">Expiry (ISO / date-time)</label>
          <input
            type="text"
            value={expiry}
            onChange={e => setExpiry(e.target.value)}
            placeholder="2026-02-21T00:00:00Z"
            className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-400 block mb-1">Target Price ($)</label>
            <input
              type="number"
              value={target}
              onChange={e => setTarget(e.target.value)}
              placeholder="100000"
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Stop Price ($)</label>
            <input
              type="number"
              value={stop}
              onChange={e => setStop(e.target.value)}
              placeholder="95000"
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-400 block mb-1">Range</label>
            <select
              value={range}
              onChange={e => setRange(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
            >
              <option value="500">$500</option>
              <option value="2000">$2,000</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Direction</label>
            <div className="flex gap-2">
              <button
                onClick={() => setDirection('Up')}
                className={`flex-1 py-1.5 rounded text-sm font-medium transition-colors ${
                  direction === 'Up'
                    ? 'bg-green-600 text-white'
                    : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                }`}
              >
                Up
              </button>
              <button
                onClick={() => setDirection('Down')}
                className={`flex-1 py-1.5 rounded text-sm font-medium transition-colors ${
                  direction === 'Down'
                    ? 'bg-red-600 text-white'
                    : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                }`}
              >
                Down
              </button>
            </div>
          </div>
        </div>

        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 rounded text-sm font-medium transition-colors flex items-center justify-center gap-2"
        >
          <Save size={14} />
          {saving ? 'Saving...' : saved ? 'Saved' : 'Save Contract'}
        </button>
      </div>
    </div>
  )
}
