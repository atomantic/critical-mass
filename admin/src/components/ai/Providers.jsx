import { useState, useEffect, useRef, useId } from 'react'
import ModalDialog from '../ModalDialog'
import { createRunLifecycle, RUN_NOTICE } from '../../utils/runLifecycle.mjs'

const PROVIDER_TYPES = { cli: 'CLI (unavailable)', api: 'API' }

// A run record without endTime is either live or was interrupted; only the
// per-run metadata (isActive) can tell them apart, so each is looked up.
async function classifyRun(run) {
  if (run.endTime) return 'done'
  const response = await fetch(`/api/runs/${run.id}`).catch(() => null)
  const meta = response?.ok ? await response.json().catch(() => null) : null
  if (!meta) return 'unavailable'
  if (meta.endTime) return 'done'
  return meta.isActive === false ? 'interrupted' : 'active'
}

const RUN_STATUS_LABELS = {
  active: 'Running...',
  interrupted: 'Interrupted',
  unavailable: 'Status unavailable',
  done: 'Finished',
}

async function requireAcceptedResponse(response) {
  if (response.ok) return
  let message = `Request failed (${response.status})`
  try {
    const body = await response.json()
    if (typeof body?.error === 'string' && body.error.trim()) message = body.error
    else if (Array.isArray(body?.errors) && body.errors.length) message = body.errors.join(', ')
  } catch {
    // A non-JSON error still has a useful status for the operator.
  }
  throw new Error(message)
}

export default function AIProviders() {
  const providerSelectId = useId()
  const promptTextareaId = useId()
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
  const [runNotice, setRunNotice] = useState(null)
  const [stopPending, setStopPending] = useState(false)
  const [runStatuses, setRunStatuses] = useState({})
  const [runActionError, setRunActionError] = useState('')
  const [sampleProviders, setSampleProviders] = useState([])
  const [showSamples, setShowSamples] = useState(false)
  const [loadingSamples, setLoadingSamples] = useState(false)
  const [runPending, setRunPending] = useState(false)
  const [mutationPending, setMutationPending] = useState({})
  const [mutationError, setMutationError] = useState('')
  const mutationLocks = useRef(new Set())
  const loadDataRef = useRef(null)
  const reconciledRef = useRef(false)
  const mountedRef = useRef(false)
  const operatorRunActionRef = useRef(false)
  const lifecycleRef = useRef(null)
  if (!lifecycleRef.current) {
    lifecycleRef.current = createRunLifecycle({
      setRunningId,
      setRunOutput,
      setPending: setRunPending,
      setStopPending,
      setRunNotice,
      refreshRuns: () => loadDataRef.current?.(),
    })
  }

  useEffect(() => { loadData() }, [])

  // The lifecycle owner holds every runner timer and in-flight read; unmounting
  // invalidates its generation so no pending continuation can revive polling on
  // a detached view. Server-side work is only cancelled by an explicit Stop.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      lifecycleRef.current.dispose()
    }
  }, [])

  const loadData = async () => {
    setLoading(true)
    const [providersRes, runsRes] = await Promise.all([
      fetch('/api/providers').then(r => r.json()).catch(() => ({ providers: [], activeProvider: null })),
      fetch('/api/runs?limit=20').then(r => r.json()).catch(() => ({ runs: [] }))
    ])
    setProviders(providersRes.providers || [])
    const loadedProviders = providersRes.providers || []
    setActiveProviderId(loadedProviders.some(provider => provider.id === providersRes.activeProvider && provider.type === 'api')
      ? providersRes.activeProvider
      : null)
    const loadedRuns = runsRes.runs || []
    setRuns(loadedRuns)
    setLoading(false)
    await reconcileRuns(loadedRuns)
  }

  // Server-side runs outlive the page. Classify every unfinished record, and on
  // the first load re-attach to the newest live (else interrupted) one so its
  // progress, output and Stop are visible again without creating a second run.
  const reconcileRuns = async (loadedRuns) => {
    const unfinished = loadedRuns.filter(run => !run.endTime)
    const entries = await Promise.all(unfinished.map(async run => [run.id, await classifyRun(run)]))
    setRunStatuses(Object.fromEntries(entries))
    if (reconciledRef.current || !mountedRef.current) return
    reconciledRef.current = true
    // An explicit operator choice made while classification was pending wins.
    if (operatorRunActionRef.current) return
    const outstanding = entries.find(([, status]) => status === 'active')
      || entries.find(([, status]) => status === 'interrupted')
    if (!outstanding) return
    setShowRunner(true)
    lifecycleRef.current.attach(outstanding[0])
  }

  // Keep the lifecycle owner's run-list refresh pointed at the current closure
  // without rebuilding the owner (and losing its generation) on every render.
  useEffect(() => { loadDataRef.current = loadData })

  const handleSetActive = async (id) => {
    await runMutation('active', () => fetch('/api/providers/active', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id })
    }), () => setActiveProviderId(id))
  }

  const runMutation = async (key, request, onSuccess, onFailure) => {
    if (mutationLocks.current.has(key)) return
    mutationLocks.current.add(key)
    setMutationPending(prev => ({ ...prev, [key]: true }))
    setMutationError('')
    try {
      await requireAcceptedResponse(await request())
      onSuccess?.()
    } catch (error) {
      setMutationError(error.message || 'The provider change could not be saved. Please try again.')
      onFailure?.(error)
    } finally {
      mutationLocks.current.delete(key)
      setMutationPending(prev => ({ ...prev, [key]: false }))
    }
  }

  const handleTest = async (id) => {
    setTestResults(prev => ({ ...prev, [id]: { testing: true } }))
    const result = await fetch(`/api/providers/${id}/test`, { method: 'POST' })
      .then(r => r.json())
      .catch(err => ({ success: false, error: err.message }))
    setTestResults(prev => ({ ...prev, [id]: result }))
  }

  const handleDelete = async (id) => {
    await runMutation(`delete:${id}`, () => fetch(`/api/providers/${id}`, { method: 'DELETE' }), loadData)
  }

  const handleToggleEnabled = async (provider) => {
    await runMutation(`enabled:${provider.id}`, () => fetch(`/api/providers/${provider.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...provider, enabled: !provider.enabled })
    }), loadData)
  }

  const handleRefreshModels = async (id) => {
    await runMutation(`refresh:${id}`, () => fetch(`/api/providers/${id}/refresh-models`, { method: 'POST' }), loadData)
  }

  const handleExecuteRun = () => {
    if (!runPrompt.trim() || !activeProviderId) return
    operatorRunActionRef.current = true
    lifecycleRef.current.execute({ providerId: activeProviderId, prompt: runPrompt })
  }

  const handleStopRun = (runId) => {
    operatorRunActionRef.current = true
    lifecycleRef.current.stop(runId)
  }

  const handleAttachRun = (runId) => {
    operatorRunActionRef.current = true
    setRunActionError('')
    setShowRunner(true)
    lifecycleRef.current.attach(runId)
  }

  // Loads the persisted full prompt into the editor. Nothing runs until the
  // operator presses Execute, so a rerun is always an explicit new run.
  const handleRerun = async (runId) => {
    setRunActionError('')
    const response = await fetch(`/api/runs/${runId}/prompt`).catch(() => null)
    if (!response?.ok) {
      setRunActionError(`Could not load the original prompt${response ? ` (HTTP ${response.status})` : ''}.`)
      return
    }
    setRunPrompt(await response.text())
    setShowRunner(true)
  }

  const handleLoadSamples = async () => {
    setLoadingSamples(true)
    setShowSamples(true)
    const result = await fetch('/api/providers/samples').then(r => r.json()).catch(() => ({ providers: [] }))
    setSampleProviders((result.providers || []).filter(provider => provider.type === 'api'))
    setLoadingSamples(false)
  }

  const handleAddSample = async (provider) => {
    if (provider.type !== 'api') return
    if (mutationLocks.current.has('sample-all')) return
    await runMutation(`sample:${provider.id}`, () => fetch('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(provider)
    }), () => { setSampleProviders(prev => prev.filter(p => p.id !== provider.id)); loadData() })
  }

  const handleAddAllSamples = async () => {
    if ([...mutationLocks.current].some(key => key.startsWith('sample:'))) return
    let addedAny = false
    await runMutation('sample-all', async () => {
      for (const provider of sampleProviders.filter(sample => sample.type === 'api')) {
        const response = await fetch('/api/providers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(provider)
        })
        await requireAcceptedResponse(response)
        addedAny = true
        setSampleProviders(prev => prev.filter(sample => sample.id !== provider.id))
      }
      return { ok: true }
    }, () => { setSampleProviders([]); loadData() }, () => { if (addedAny) loadData() })
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

      {mutationError && <p role="alert" className="text-sm text-red-400">{mutationError}</p>}
      {runActionError && <p role="alert" className="text-sm text-red-400">{runActionError}</p>}

      {/* Prompt Runner */}
      {showRunner && (
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-4">
          <div className="flex flex-col sm:flex-row gap-2 sm:gap-4">
            <select
              id={providerSelectId}
              aria-label="Select Provider"
              value={activeProviderId || ''}
              disabled={Boolean(mutationPending.active)}
              onChange={(e) => handleSetActive(e.target.value)}
              className="px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white w-full sm:w-auto"
            >
              <option value="">Select Provider</option>
              {providers.filter(p => p.enabled && p.type === 'api').map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          <textarea
            id={promptTextareaId}
            aria-label="Prompt"
            value={runPrompt}
            onChange={(e) => setRunPrompt(e.target.value)}
            placeholder="Enter your prompt..."
            rows={3}
            className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white resize-none focus:border-indigo-500 focus:outline-hidden"
          />

          <div className="flex justify-between items-center">
            <button
              onClick={handleExecuteRun}
              disabled={!runPrompt.trim() || !activeProviderId || !!runningId || runPending}
              className="px-6 py-2 bg-green-800 hover:bg-green-900 text-white rounded-lg transition-colors disabled:opacity-50 text-sm"
            >
              {runningId || runPending ? 'Running...' : 'Execute'}
            </button>
            {runningId && (
              <button
                onClick={() => handleStopRun()}
                disabled={stopPending}
                className="px-4 py-2 bg-red-700 hover:bg-red-800 text-white rounded-lg transition-colors text-sm disabled:opacity-50"
              >
                {stopPending ? 'Stopping...' : runNotice?.kind === RUN_NOTICE.STOP ? 'Retry Stop' : 'Stop'}
              </button>
            )}
          </div>

          {runningId && (
            <p className="text-xs text-gray-400 font-mono truncate">
              <span className="inline-block w-2 h-2 rounded-full bg-yellow-500 animate-pulse mr-2" />
              Run {runningId} is in progress on the server
            </p>
          )}

          {runNotice && (
            <div role="alert" className="flex flex-col sm:flex-row sm:items-center gap-2 text-sm text-red-400">
              <span>{runNotice.message}</span>
              {runNotice.kind === RUN_NOTICE.READ && (
                <button
                  onClick={() => lifecycleRef.current.refresh()}
                  className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white rounded-sm text-sm shrink-0"
                >
                  Retry status
                </button>
              )}
            </div>
          )}

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
                disabled={Boolean(mutationPending['sample-all'] || Object.keys(mutationPending).some(key => key.startsWith('sample:') && mutationPending[key]))}
                className="px-4 py-1.5 bg-green-800 hover:bg-green-900 text-white rounded-lg transition-colors text-sm"
              >
                {mutationPending['sample-all'] ? 'Adding...' : `Add All (${sampleProviders.length})`}
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
                      <p className="wrap-break-word">Command: <code className="text-gray-300 break-all">{sp.command} {sp.args?.join(' ')}</code></p>
                    )}
                    {sp.type === 'api' && (
                      <p className="wrap-break-word">Endpoint: <code className="text-gray-300 break-all">{sp.endpoint}</code></p>
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
                  disabled={Boolean(mutationPending[`sample:${sp.id}`] || mutationPending['sample-all'])}
                  className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors text-sm disabled:opacity-50 shrink-0"
                >
                  {mutationPending[`sample:${sp.id}`] ? 'Adding...' : 'Add'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {showSamples && sampleProviders.length === 0 && !loadingSamples && (
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 text-center">
          <p className="text-gray-400">No supported API sample providers are available.</p>
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
                    <span className="text-xs px-2 py-0.5 rounded-sm bg-indigo-500/20 text-indigo-400">DEFAULT</span>
                  )}
                  {provider.type === 'cli' && (
                    <span className="text-xs px-2 py-0.5 rounded-sm bg-yellow-500/20 text-yellow-300">UNAVAILABLE</span>
                  )}
                  {provider.type === 'api' && !provider.enabled && (
                    <span className="text-xs px-2 py-0.5 rounded-sm bg-gray-500/20 text-gray-400">DISABLED</span>
                  )}
                </div>

                <div className="mt-2 text-sm text-gray-400 space-y-1">
                  {provider.type === 'cli' && (
                    <p role="status">CLI providers are unsupported and cannot be tested, enabled, or used to run prompts. Edit this provider to convert it to an API configuration, or delete it.</p>
                  )}
                  {provider.type === 'api' && (
                    <p className="wrap-break-word">Endpoint: <code className="text-gray-300 break-all">{provider.endpoint}</code></p>
                  )}
                  {provider.models?.length > 0 && (
                    <p>Models: {provider.models.slice(0, 3).join(', ')}{provider.models.length > 3 ? ` +${provider.models.length - 3}` : ''}</p>
                  )}
                  {provider.defaultModel && (
                    <p className="wrap-break-word">Default: <code className="text-gray-300 break-all">{provider.defaultModel}</code></p>
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
                {provider.type === 'api' && (
                  <button
                    onClick={() => handleTest(provider.id)}
                    disabled={testResults[provider.id]?.testing}
                    className="px-3 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 text-white rounded-sm transition-colors disabled:opacity-50"
                  >
                    {testResults[provider.id]?.testing ? 'Testing...' : 'Test'}
                  </button>
                )}

                {provider.type === 'api' && (
                  <button
                    onClick={() => handleRefreshModels(provider.id)}
                    disabled={Boolean(mutationPending[`refresh:${provider.id}`])}
                    className="px-3 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 text-white rounded-sm transition-colors"
                  >
                    Refresh
                  </button>
                )}

                {provider.type === 'api' && (
                  <button
                    onClick={() => handleToggleEnabled(provider)}
                    disabled={Boolean(mutationPending[`enabled:${provider.id}`])}
                    className={`px-3 py-1.5 text-sm rounded transition-colors ${
                      provider.enabled
                        ? 'bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30'
                        : 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                    }`}
                  >
                    {provider.enabled ? 'Disable' : 'Enable'}
                  </button>
                )}

                {provider.type === 'api' && provider.id !== activeProviderId && provider.enabled && (
                  <button
                    onClick={() => handleSetActive(provider.id)}
                    disabled={Boolean(mutationPending.active)}
                    className="px-3 py-1.5 text-sm bg-indigo-500/20 text-indigo-400 hover:bg-indigo-500/30 rounded-sm transition-colors"
                  >
                    Set Default
                  </button>
                )}

                <button
                  onClick={() => { setEditingProvider(provider); setShowForm(true) }}
                  className="px-3 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 text-white rounded-sm transition-colors"
                >
                  Edit
                </button>

                <button
                  onClick={() => handleDelete(provider.id)}
                  disabled={Boolean(mutationPending[`delete:${provider.id}`])}
                  className="px-3 py-1.5 text-sm bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded-sm transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}

        {providers.length === 0 && (
          <div className="text-center py-12 text-gray-400">
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
            {runs.map(run => {
              const status = run.endTime ? 'done' : runStatuses[run.id]
              const attached = runningId === run.id
              return (
                <div
                  key={run.id}
                  className="bg-gray-800 border border-gray-700 rounded-lg p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                >
                  <div className="flex items-start sm:items-center gap-3 min-w-0">
                    <span className={`w-2 h-2 rounded-full shrink-0 mt-1.5 sm:mt-0 ${
                      run.success === true ? 'bg-green-500' :
                      run.success === false || status === 'interrupted' ? 'bg-red-500' :
                      status === 'unavailable' ? 'bg-gray-500' :
                      'bg-yellow-500 animate-pulse'
                    }`} />
                    <div className="min-w-0">
                      <p className="text-sm text-white truncate">{run.prompt}</p>
                      <p className="text-xs text-gray-400">
                        {run.providerName} &middot; {new Date(run.startTime).toLocaleString()}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 shrink-0 pl-5 sm:pl-0">
                    <span className={`text-sm ${status === 'interrupted' ? 'text-red-400' : 'text-gray-400'}`}>
                      {run.duration ? `${(run.duration / 1000).toFixed(1)}s` : (RUN_STATUS_LABELS[status] || 'Checking...')}
                    </span>
                    <button
                      onClick={() => handleAttachRun(run.id)}
                      disabled={attached}
                      className="px-3 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 text-white rounded-sm transition-colors disabled:opacity-50"
                    >
                      {status === 'active' ? (attached ? 'Attached' : 'Attach') : 'View'}
                    </button>
                    {status === 'active' && (
                      <button
                        onClick={() => handleStopRun(run.id)}
                        disabled={stopPending}
                        className="px-3 py-1.5 text-sm bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded-sm transition-colors disabled:opacity-50"
                      >
                        Stop
                      </button>
                    )}
                    {status !== 'active' && status !== undefined && (
                      <button
                        onClick={() => handleRerun(run.id)}
                        title="Load the full original prompt into the runner; nothing runs until Execute"
                        className="px-3 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 text-white rounded-sm transition-colors"
                      >
                        Rerun
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
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
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const pendingLock = useRef(false)
  const [formData, setFormData] = useState({
    name: provider?.name || '',
    type: 'api',
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

  // Local state for textarea input to avoid premature parsing on each keystroke
  const [modelsText, setModelsText] = useState((provider?.models || []).join(', '))

  // Sync modelsText when provider changes (e.g., switching between providers in modal)
  useEffect(() => {
    setModelsText((provider?.models || []).join(', '))
  }, [provider?.id])

  const availableModels = formData.models || []

  const parseModelsText = (text) => {
    return text.split(',').map(m => m.trim()).filter(Boolean)
  }

  const handleModelsBlur = () => {
    const models = parseModelsText(modelsText)
    setFormData(prev => ({ ...prev, models }))
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (pendingLock.current) return
    pendingLock.current = true
    setPending(true)
    setError('')
    // Parse modelsText in case the user hasn't blurred from the textarea yet
    const models = parseModelsText(modelsText)
    const data = {
      ...formData,
      models,
      timeout: parseInt(formData.timeout)
    }

    try {
      const response = provider
        ? await fetch(`/api/providers/${provider.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
        : await fetch('/api/providers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      await requireAcceptedResponse(response)
      onSave()
    } catch (submitError) {
      setError(submitError.message || 'The provider could not be saved. Please try again.')
    } finally {
      pendingLock.current = false
      setPending(false)
    }
  }

  const nameInputId = useId()
  const headingId = useId()
  const endpointInputId = useId()
  const apiKeyInputId = useId()
  const availableModelsId = useId()
  const defaultModelId = useId()
  const timeoutInputId = useId()
  const enabledCheckboxId = useId()

  const ModelSelect = ({ label, color, value, field }) => {
    const fieldId = useId()
    return (
    <div>
      <label htmlFor={fieldId} className="block text-xs text-gray-400 mb-1">
        <span className={`inline-block w-2 h-2 rounded-full ${color} mr-1`}></span>
        {label}
      </label>
      {availableModels.length > 0 ? (
        <select
          id={fieldId}
          value={value}
          onChange={(e) => setFormData(prev => ({ ...prev, [field]: e.target.value }))}
          className="w-full px-2 py-1.5 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-indigo-500 focus:outline-hidden"
        >
          <option value="">None</option>
          {availableModels.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      ) : (
        <input
          id={fieldId}
          type="text"
          value={value}
          onChange={(e) => setFormData(prev => ({ ...prev, [field]: e.target.value }))}
          className="w-full px-2 py-1.5 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-indigo-500 focus:outline-hidden"
        />
      )}
    </div>
  )

  }
  return (
    <ModalDialog onClose={onClose} labelledBy={headingId} maxWidthClassName="max-w-lg">
      <div>
        <h2 id={headingId} className="text-xl font-bold text-white mb-4">
          {provider ? 'Edit Provider' : 'Add Provider'}
        </h2>
        {provider?.type === 'cli' && (
          <p role="status" className="mb-4 text-sm text-yellow-300">
            This legacy CLI provider is unavailable. Enter an API endpoint and save to convert it, or cancel and delete it.
          </p>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
          <div>
            <label htmlFor={nameInputId} className="block text-sm text-gray-400 mb-1">Name *</label>
            <input
              id={nameInputId}
              autoFocus
              type="text"
              value={formData.name}
              onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
              required
              className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white focus:border-indigo-500 focus:outline-hidden"
            />
          </div>

          <div>
            <span className="block text-sm text-gray-400 mb-1">Type</span>
            <span className="text-sm text-white">API</span>
          </div>

          <>
              <div>
                <label htmlFor={endpointInputId} className="block text-sm text-gray-400 mb-1">Endpoint *</label>
                <input
                  id={endpointInputId}
                  type="url"
                  value={formData.endpoint}
                  onChange={(e) => setFormData(prev => ({ ...prev, endpoint: e.target.value }))}
                  placeholder="http://localhost:1234/v1"
                  required={formData.type === 'api'}
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white focus:border-indigo-500 focus:outline-hidden"
                />
              </div>
              <div>
                <label htmlFor={apiKeyInputId} className="block text-sm text-gray-400 mb-1">API Key</label>
                <input
                  id={apiKeyInputId}
                  type="password"
                  value={formData.apiKey}
                  onChange={(e) => setFormData(prev => ({ ...prev, apiKey: e.target.value }))}
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white focus:border-indigo-500 focus:outline-hidden"
                />
              </div>
          </>

          <div>
            <label htmlFor={availableModelsId} className="block text-sm text-gray-400 mb-1">
              Available Models
              {formData.type === 'api' && <span className="text-xs text-gray-400 ml-2">(Use Refresh after saving)</span>}
            </label>
            <textarea
              id={availableModelsId}
              value={modelsText}
              onChange={(e) => setModelsText(e.target.value)}
              onBlur={handleModelsBlur}
              placeholder="model-1, model-2, model-3"
              rows={2}
              className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white resize-none focus:border-indigo-500 focus:outline-hidden"
            />
          </div>

          <div>
            <label htmlFor={defaultModelId} className="block text-sm text-gray-400 mb-1">Default Model</label>
            {availableModels.length > 0 ? (
              <select
                id={defaultModelId}
                value={formData.defaultModel}
                onChange={(e) => setFormData(prev => ({ ...prev, defaultModel: e.target.value }))}
                className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white focus:border-indigo-500 focus:outline-hidden"
              >
                <option value="">None</option>
                {availableModels.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : (
              <input
                id={defaultModelId}
                type="text"
                value={formData.defaultModel}
                onChange={(e) => setFormData(prev => ({ ...prev, defaultModel: e.target.value }))}
                placeholder="claude-sonnet-4-6"
                className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white focus:border-indigo-500 focus:outline-hidden"
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
            <label htmlFor={timeoutInputId} className="block text-sm text-gray-400 mb-1">Timeout (ms)</label>
            <input
              id={timeoutInputId}
              type="number"
              value={formData.timeout}
              onChange={(e) => setFormData(prev => ({ ...prev, timeout: e.target.value }))}
              className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white focus:border-indigo-500 focus:outline-hidden"
            />
          </div>

          <label htmlFor={enabledCheckboxId} className="flex items-center gap-2">
            <input
              id={enabledCheckboxId}
              type="checkbox"
              checked={formData.enabled}
              onChange={(e) => setFormData(prev => ({ ...prev, enabled: e.target.checked }))}
              className="w-4 h-4 rounded-sm border-gray-700 bg-gray-900"
            />
            <span className="text-sm text-gray-400">Enabled</span>
          </label>

          <div className="flex justify-end gap-3 pt-4">
            <button type="button" onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white">
              Cancel
            </button>
            <button type="submit" disabled={pending} className="px-6 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors disabled:opacity-50">
              {pending ? 'Saving...' : provider ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </ModalDialog>
  )
}
