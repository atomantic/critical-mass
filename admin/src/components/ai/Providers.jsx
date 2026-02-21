import { useState, useEffect, useRef } from 'react'

const PROVIDER_TYPES = { cli: 'CLI', api: 'API' }

export default function AIProviders() {
  const [providers, setProviders] = useState([])
  const [activeProviderId, setActiveProviderId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingProvider, setEditingProvider] = useState(null)
  const [testResults, setTestResults] = useState({})
  const [runs, setRuns] = useState([])
  const [showRunner, setShowRunner] = useState(false)
  const [runPrompt, setRunPrompt] = useState('')
  const [runningId, setRunningId] = useState(null)
  const [runOutput, setRunOutput] = useState('')
  const [sampleProviders, setSampleProviders] = useState([])
  const [showSamples, setShowSamples] = useState(false)
  const [loadingSamples, setLoadingSamples] = useState(false)
  const [addingSample, setAddingSample] = useState({})
  const pollRef = useRef(null)

  useEffect(() => { loadData() }, [])

  // Clean up polling interval on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  const loadData = async () => {
    setLoading(true)
    const [providersRes, runsRes] = await Promise.all([
      fetch('/api/providers').then(r => r.json()).catch(() => ({ providers: [], activeProvider: null })),
      fetch('/api/runs?limit=20').then(r => r.json()).catch(() => ({ runs: [] }))
    ])
    setProviders(providersRes.providers || [])
    setActiveProviderId(providersRes.activeProvider)
    setRuns(runsRes.runs || [])
    setLoading(false)
  }

  const handleSetActive = async (id) => {
    await fetch('/api/providers/active', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    })
    setActiveProviderId(id)
  }

  const handleTest = async (id) => {
    setTestResults(prev => ({ ...prev, [id]: { testing: true } }))
    const result = await fetch(`/api/providers/${id}/test`, { method: 'POST' })
      .then(r => r.json())
      .catch(err => ({ success: false, error: err.message }))
    setTestResults(prev => ({ ...prev, [id]: result }))
  }

  const handleDelete = async (id) => {
    await fetch(`/api/providers/${id}`, { method: 'DELETE' })
    loadData()
  }

  const handleToggleEnabled = async (provider) => {
    await fetch(`/api/providers/${provider.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...provider, enabled: !provider.enabled })
    })
    loadData()
  }

  const handleRefreshModels = async (id) => {
    await fetch(`/api/providers/${id}/refresh-models`, { method: 'POST' })
    loadData()
  }

  const handleExecuteRun = async () => {
    if (!runPrompt.trim() || !activeProviderId) return
    setRunOutput('')
    const result = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: activeProviderId, prompt: runPrompt })
    }).then(r => r.json()).catch(err => ({ error: err.message }))

    if (result.error) {
      setRunOutput(`Error: ${result.error}`)
      return
    }

    setRunningId(result.runId)
    // Poll for completion
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      const meta = await fetch(`/api/runs/${result.runId}`).then(r => r.json()).catch(() => null)
      if (!meta || meta.endTime) {
        clearInterval(pollRef.current)
        pollRef.current = null
        setRunningId(null)
        if (meta) {
          const output = await fetch(`/api/runs/${result.runId}/output`).then(r => r.text()).catch(() => '')
          setRunOutput(output || meta.error || 'No output')
        }
        loadData()
      }
    }, 2000)
  }

  const handleStopRun = async () => {
    if (runningId) {
      await fetch(`/api/runs/${runningId}/stop`, { method: 'POST' })
      setRunningId(null)
    }
  }

  const handleLoadSamples = async () => {
    setLoadingSamples(true)
    setShowSamples(true)
    const result = await fetch('/api/providers/samples').then(r => r.json()).catch(() => ({ providers: [] }))
    setSampleProviders(result.providers || [])
    setLoadingSamples(false)
  }

  const handleAddSample = async (provider) => {
    setAddingSample(prev => ({ ...prev, [provider.id]: true }))
    await fetch('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(provider)
    })
    setSampleProviders(prev => prev.filter(p => p.id !== provider.id))
    setAddingSample(prev => ({ ...prev, [provider.id]: false }))
    loadData()
  }

  const handleAddAllSamples = async () => {
    for (const provider of sampleProviders) {
      await fetch('/api/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(provider)
      })
    }
    setSampleProviders([])
    loadData()
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading providers...</div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-white">AI Providers</h1>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={handleLoadSamples}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors text-sm"
          >
            {loadingSamples ? 'Loading...' : 'Load Samples'}
          </button>
          <button
            onClick={() => setShowRunner(!showRunner)}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors text-sm"
          >
            {showRunner ? 'Hide Runner' : 'Run Prompt'}
          </button>
          <button
            onClick={() => { setEditingProvider(null); setShowForm(true) }}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors text-sm"
          >
            Add Provider
          </button>
        </div>
      </div>

      {/* Prompt Runner */}
      {showRunner && (
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-4">
          <div className="flex flex-col sm:flex-row gap-2 sm:gap-4">
            <select
              value={activeProviderId || ''}
              onChange={(e) => handleSetActive(e.target.value)}
              className="px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white w-full sm:w-auto"
            >
              <option value="">Select Provider</option>
              {providers.filter(p => p.enabled).map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          <textarea
            value={runPrompt}
            onChange={(e) => setRunPrompt(e.target.value)}
            placeholder="Enter your prompt..."
            rows={3}
            className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white resize-none focus:border-indigo-500 focus:outline-none"
          />

          <div className="flex justify-between items-center">
            <button
              onClick={handleExecuteRun}
              disabled={!runPrompt.trim() || !activeProviderId || runningId}
              className="px-6 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors disabled:opacity-50 text-sm"
            >
              {runningId ? 'Running...' : 'Execute'}
            </button>
            {runningId && (
              <button
                onClick={handleStopRun}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors text-sm"
              >
                Stop
              </button>
            )}
          </div>

          {runOutput && (
            <div className="bg-gray-900 border border-gray-700 rounded-lg p-3 max-h-64 overflow-auto">
              <pre className="text-sm text-gray-300 font-mono whitespace-pre-wrap">{runOutput}</pre>
            </div>
          )}
        </div>
      )}

      {/* Sample Providers */}
      {showSamples && sampleProviders.length > 0 && (
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-white">Available Sample Providers</h2>
            <div className="flex gap-2">
              <button
                onClick={handleAddAllSamples}
                className="px-4 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors text-sm"
              >
                Add All ({sampleProviders.length})
              </button>
              <button
                onClick={() => setShowSamples(false)}
                className="px-3 py-1.5 text-sm text-gray-400 hover:text-white"
              >
                Close
              </button>
            </div>
          </div>
          <div className="grid gap-3">
            {sampleProviders.map(sp => (
              <div key={sp.id} className="bg-gray-900 border border-gray-700 rounded-lg p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-white font-medium">{sp.name}</span>
                    <span className={`text-xs px-2 py-0.5 rounded ${
                      sp.type === 'cli' ? 'bg-blue-500/20 text-blue-400' : 'bg-purple-500/20 text-purple-400'
                    }`}>
                      {PROVIDER_TYPES[sp.type] || sp.type}
                    </span>
                  </div>
                  <div className="text-sm text-gray-400 mt-1 space-y-0.5">
                    {sp.type === 'cli' && (
                      <p className="break-words">Command: <code className="text-gray-300 break-all">{sp.command} {sp.args?.join(' ')}</code></p>
                    )}
                    {sp.type === 'api' && (
                      <p className="break-words">Endpoint: <code className="text-gray-300 break-all">{sp.endpoint}</code></p>
                    )}
                    {sp.models?.length > 0 && (
                      <p className="text-xs">Models: {sp.models.join(', ')}</p>
                    )}
                    {sp.envVars && Object.keys(sp.envVars).length > 0 && (
                      <p className="text-xs">Env: {Object.keys(sp.envVars).join(', ')}</p>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => handleAddSample(sp)}
                  disabled={addingSample[sp.id]}
                  className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors text-sm disabled:opacity-50 flex-shrink-0"
                >
                  {addingSample[sp.id] ? 'Adding...' : 'Add'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {showSamples && sampleProviders.length === 0 && !loadingSamples && (
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 text-center">
          <p className="text-gray-400">All sample providers have already been added.</p>
          <button onClick={() => setShowSamples(false)} className="mt-2 text-sm text-indigo-400 hover:text-indigo-300">Close</button>
        </div>
      )}

      {/* Provider List */}
      <div className="grid gap-4">
        {providers.map(provider => (
          <div
            key={provider.id}
            className={`bg-gray-800 border rounded-xl p-4 ${
              provider.id === activeProviderId ? 'border-indigo-500' : 'border-gray-700'
            }`}
          >
            <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-semibold text-white">{provider.name}</h3>
                  <span className={`text-xs px-2 py-0.5 rounded ${
                    provider.type === 'cli' ? 'bg-blue-500/20 text-blue-400' : 'bg-purple-500/20 text-purple-400'
                  }`}>
                    {PROVIDER_TYPES[provider.type] || provider.type}
                  </span>
                  {provider.id === activeProviderId && (
                    <span className="text-xs px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-400">DEFAULT</span>
                  )}
                  {!provider.enabled && (
                    <span className="text-xs px-2 py-0.5 rounded bg-gray-500/20 text-gray-400">DISABLED</span>
                  )}
                </div>

                <div className="mt-2 text-sm text-gray-400 space-y-1">
                  {provider.type === 'cli' && (
                    <p className="break-words">Command: <code className="text-gray-300 break-all">{provider.command} {provider.args?.join(' ')}</code></p>
                  )}
                  {provider.type === 'api' && (
                    <p className="break-words">Endpoint: <code className="text-gray-300 break-all">{provider.endpoint}</code></p>
                  )}
                  {provider.models?.length > 0 && (
                    <p>Models: {provider.models.slice(0, 3).join(', ')}{provider.models.length > 3 ? ` +${provider.models.length - 3}` : ''}</p>
                  )}
                  {provider.defaultModel && (
                    <p className="break-words">Default: <code className="text-gray-300 break-all">{provider.defaultModel}</code></p>
                  )}
                  {(provider.lightModel || provider.mediumModel || provider.heavyModel) && (
                    <p className="text-xs">
                      Tiers:
                      {provider.lightModel && <span className="ml-1 text-green-400">{provider.lightModel}</span>}
                      {provider.mediumModel && <span className="ml-1 text-yellow-400">{provider.mediumModel}</span>}
                      {provider.heavyModel && <span className="ml-1 text-red-400">{provider.heavyModel}</span>}
                    </p>
                  )}
                </div>

                {testResults[provider.id] && !testResults[provider.id].testing && (
                  <div className={`mt-2 text-sm ${testResults[provider.id].success ? 'text-green-400' : 'text-red-400'}`}>
                    {testResults[provider.id].success
                      ? `Available${testResults[provider.id].version ? ` (${testResults[provider.id].version})` : ''}`
                      : `${testResults[provider.id].error}`
                    }
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => handleTest(provider.id)}
                  disabled={testResults[provider.id]?.testing}
                  className="px-3 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 text-white rounded transition-colors disabled:opacity-50"
                >
                  {testResults[provider.id]?.testing ? 'Testing...' : 'Test'}
                </button>

                {provider.type === 'api' && (
                  <button
                    onClick={() => handleRefreshModels(provider.id)}
                    className="px-3 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 text-white rounded transition-colors"
                  >
                    Refresh
                  </button>
                )}

                <button
                  onClick={() => handleToggleEnabled(provider)}
                  className={`px-3 py-1.5 text-sm rounded transition-colors ${
                    provider.enabled
                      ? 'bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30'
                      : 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                  }`}
                >
                  {provider.enabled ? 'Disable' : 'Enable'}
                </button>

                {provider.id !== activeProviderId && provider.enabled && (
                  <button
                    onClick={() => handleSetActive(provider.id)}
                    className="px-3 py-1.5 text-sm bg-indigo-500/20 text-indigo-400 hover:bg-indigo-500/30 rounded transition-colors"
                  >
                    Set Default
                  </button>
                )}

                <button
                  onClick={() => { setEditingProvider(provider); setShowForm(true) }}
                  className="px-3 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 text-white rounded transition-colors"
                >
                  Edit
                </button>

                <button
                  onClick={() => handleDelete(provider.id)}
                  className="px-3 py-1.5 text-sm bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}

        {providers.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            <p>No providers configured.</p>
            <button
              onClick={handleLoadSamples}
              className="mt-3 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors text-sm"
            >
              Load Sample Providers
            </button>
          </div>
        )}
      </div>

      {/* Recent Runs */}
      {runs.length > 0 && (
        <div className="mt-8">
          <h2 className="text-xl font-bold text-white mb-4">Recent Runs</h2>
          <div className="space-y-2">
            {runs.map(run => (
              <div
                key={run.id}
                className="bg-gray-800 border border-gray-700 rounded-lg p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
              >
                <div className="flex items-start sm:items-center gap-3 min-w-0">
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 mt-1.5 sm:mt-0 ${
                    run.success === true ? 'bg-green-500' :
                    run.success === false ? 'bg-red-500' :
                    'bg-yellow-500 animate-pulse'
                  }`} />
                  <div className="min-w-0">
                    <p className="text-sm text-white truncate">{run.prompt}</p>
                    <p className="text-xs text-gray-500">
                      {run.providerName} &middot; {new Date(run.startTime).toLocaleString()}
                    </p>
                  </div>
                </div>
                <div className="text-sm text-gray-400 flex-shrink-0 pl-5 sm:pl-0">
                  {run.duration ? `${(run.duration / 1000).toFixed(1)}s` : 'Running...'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Provider Form Modal */}
      {showForm && (
        <ProviderForm
          provider={editingProvider}
          onClose={() => { setShowForm(false); setEditingProvider(null) }}
          onSave={() => { setShowForm(false); setEditingProvider(null); loadData() }}
        />
      )}
    </div>
  )
}

function ProviderForm({ provider, onClose, onSave }) {
  const [formData, setFormData] = useState({
    name: provider?.name || '',
    type: provider?.type || 'cli',
    command: provider?.command || '',
    args: provider?.args?.join(' ') || '',
    endpoint: provider?.endpoint || '',
    apiKey: provider?.apiKey || '',
    models: provider?.models || [],
    defaultModel: provider?.defaultModel || '',
    lightModel: provider?.lightModel || '',
    mediumModel: provider?.mediumModel || '',
    heavyModel: provider?.heavyModel || '',
    timeout: provider?.timeout || 300000,
    enabled: provider?.enabled !== false
  })

  const availableModels = formData.models || []

  const handleSubmit = async (e) => {
    e.preventDefault()
    const data = {
      ...formData,
      args: formData.args ? formData.args.split(' ').filter(Boolean) : [],
      timeout: parseInt(formData.timeout)
    }

    if (provider) {
      await fetch(`/api/providers/${provider.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      })
    } else {
      await fetch('/api/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      })
    }
    onSave()
  }

  const ModelSelect = ({ label, color, value, field }) => (
    <div>
      <label className="block text-xs text-gray-400 mb-1">
        <span className={`inline-block w-2 h-2 rounded-full ${color} mr-1`}></span>
        {label}
      </label>
      {availableModels.length > 0 ? (
        <select
          value={value}
          onChange={(e) => setFormData(prev => ({ ...prev, [field]: e.target.value }))}
          className="w-full px-2 py-1.5 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-indigo-500 focus:outline-none"
        >
          <option value="">None</option>
          {availableModels.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => setFormData(prev => ({ ...prev, [field]: e.target.value }))}
          className="w-full px-2 py-1.5 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-indigo-500 focus:outline-none"
        />
      )}
    </div>
  )

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 sm:p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <h2 className="text-xl font-bold text-white mb-4">
          {provider ? 'Edit Provider' : 'Add Provider'}
        </h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Name *</label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
              required
              className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Type *</label>
            <select
              value={formData.type}
              onChange={(e) => setFormData(prev => ({ ...prev, type: e.target.value }))}
              className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white focus:border-indigo-500 focus:outline-none"
            >
              <option value="cli">CLI</option>
              <option value="api">API</option>
            </select>
          </div>

          {formData.type === 'cli' && (
            <>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Command *</label>
                <input
                  type="text"
                  value={formData.command}
                  onChange={(e) => setFormData(prev => ({ ...prev, command: e.target.value }))}
                  placeholder="claude"
                  required={formData.type === 'cli'}
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white focus:border-indigo-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Arguments (space-separated)</label>
                <input
                  type="text"
                  value={formData.args}
                  onChange={(e) => setFormData(prev => ({ ...prev, args: e.target.value }))}
                  placeholder="--print -p"
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white focus:border-indigo-500 focus:outline-none"
                />
              </div>
            </>
          )}

          {formData.type === 'api' && (
            <>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Endpoint *</label>
                <input
                  type="url"
                  value={formData.endpoint}
                  onChange={(e) => setFormData(prev => ({ ...prev, endpoint: e.target.value }))}
                  placeholder="http://localhost:1234/v1"
                  required={formData.type === 'api'}
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white focus:border-indigo-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">API Key</label>
                <input
                  type="password"
                  value={formData.apiKey}
                  onChange={(e) => setFormData(prev => ({ ...prev, apiKey: e.target.value }))}
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white focus:border-indigo-500 focus:outline-none"
                />
              </div>
            </>
          )}

          <div>
            <label className="block text-sm text-gray-400 mb-1">
              Available Models
              {formData.type === 'api' && <span className="text-xs text-gray-500 ml-2">(Use Refresh after saving)</span>}
            </label>
            <textarea
              value={(formData.models || []).join(', ')}
              onChange={(e) => {
                const models = e.target.value.split(',').map(m => m.trim()).filter(Boolean)
                setFormData(prev => ({ ...prev, models }))
              }}
              placeholder="model-1, model-2, model-3"
              rows={2}
              className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white resize-none focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Default Model</label>
            {availableModels.length > 0 ? (
              <select
                value={formData.defaultModel}
                onChange={(e) => setFormData(prev => ({ ...prev, defaultModel: e.target.value }))}
                className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white focus:border-indigo-500 focus:outline-none"
              >
                <option value="">None</option>
                {availableModels.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : (
              <input
                type="text"
                value={formData.defaultModel}
                onChange={(e) => setFormData(prev => ({ ...prev, defaultModel: e.target.value }))}
                placeholder="claude-sonnet-4-6"
                className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white focus:border-indigo-500 focus:outline-none"
              />
            )}
          </div>

          {/* Model Tiers */}
          <div className="border-t border-gray-700 pt-4 mt-4">
            <h4 className="text-sm font-medium text-gray-300 mb-3">Model Tiers</h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <ModelSelect label="Light (fast)" color="bg-green-500" value={formData.lightModel} field="lightModel" />
              <ModelSelect label="Medium (balanced)" color="bg-yellow-500" value={formData.mediumModel} field="mediumModel" />
              <ModelSelect label="Heavy (powerful)" color="bg-red-500" value={formData.heavyModel} field="heavyModel" />
            </div>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Timeout (ms)</label>
            <input
              type="number"
              value={formData.timeout}
              onChange={(e) => setFormData(prev => ({ ...prev, timeout: e.target.value }))}
              className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={formData.enabled}
              onChange={(e) => setFormData(prev => ({ ...prev, enabled: e.target.checked }))}
              className="w-4 h-4 rounded border-gray-700 bg-gray-900"
            />
            <span className="text-sm text-gray-400">Enabled</span>
          </label>

          <div className="flex justify-end gap-3 pt-4">
            <button type="button" onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white">
              Cancel
            </button>
            <button type="submit" className="px-6 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors">
              {provider ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
