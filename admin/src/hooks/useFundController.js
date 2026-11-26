import { useState, useEffect, useEffectEvent, useLayoutEffect, useRef } from 'react'
import { useRealtimeConnection } from './useTradeEvents'
import useRegimeStateEvents from './useRegimeStateEvents'
import useRealtimeRefresh from './useRealtimeRefresh'
import { pairQuery as buildPairQuery } from '../utils/api'
import { apiGet, apiPost, describeMutationFailure } from '../utils/apiClient'

// Strategy-aware tab configuration
const getTabsForStrategy = (strategy) => {
  const commonTabs = [
    { name: 'Dashboard', path: '' },
    { name: 'Cost Basis', path: '/cost-basis' },
    { name: 'Transactions', path: '/transactions' },
    { name: 'Charts', path: '/charts' },
    { name: 'Config', path: '/config' },
    { name: 'API Keys', path: '/keys' },
    { name: 'Logs', path: '/logs' },
  ]

  if (strategy === 'regime') {
    // Regime strategy: no backtest/optimizer
    return commonTabs
  }

  // DCA strategies get backtest and optimizer
  return [
    ...commonTabs.slice(0, 4), // Dashboard, Cost Basis, Transactions, Charts
    { name: 'Backtest', path: '/backtest' },
    { name: 'Optimizer', path: '/optimizer' },
    ...commonTabs.slice(4), // Config, API Keys
  ]
}

// Valid exchange names
const VALID_EXCHANGES = ['coinbase', 'gemini', 'cryptocom']

// Fund list, summary, regime status, action fencing and lifecycle actions for the
// fund shown by the current route. Everything is derived from `location`.
export default function useFundController({ location, navigate, addToast }) {
  // Extract exchange and pair from URL path (e.g., /coinbase/BTC-USDC/config -> coinbase, BTC-USDC)
  const pathParts = location.pathname.split('/').filter(Boolean)
  const urlExchange = VALID_EXCHANGES.includes(pathParts[0]) ? pathParts[0] : null
  const urlPair = urlExchange && pathParts[1] ? pathParts[1] : null

  // currentExchange/currentStrategy/currentPair are DERIVED from URL (with state fallback
  // for non-exchange pages). Using local state caused a one-render lag during navigation:
  // the route would briefly mount the wrong dashboard with stale data before the state
  // catches up to the URL.
  const [lastExchange, setLastExchange] = useState(urlExchange || 'coinbase')
  const currentExchange = urlExchange || lastExchange
  const [exchanges, setExchanges] = useState([])
  const [summarySnapshot, setSummarySnapshot] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [regimeRunning, setRegimeRunning] = useState(null)
  const [regimeDryRun, setRegimeDryRun] = useState(null)
  const [regimeLifecycle, setRegimeLifecycle] = useState(null)
  const [statusError, setStatusError] = useState(null)
  const [stopping, setStopping] = useState(false)
  const [starting, setStarting] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [resetDryRunConfirm, setResetDryRunConfirm] = useState(false)
  const [closing, setClosing] = useState(false)
  const [reopening, setReopening] = useState(false)
  const [closeFundDialogOpen, setCloseFundDialogOpen] = useState(false)
  const [closeFundReason, setCloseFundReason] = useState('')
  const [reopenFundDialogOpen, setReopenFundDialogOpen] = useState(false)
  const [simpleDcaEnabled, setSimpleDcaEnabled] = useState(false)
  // Fund list load state. Until the list has loaded once, strategy/badge
  // defaults are guesses, so a failed load must not render default-derived
  // fund controls (see fundsUnavailable below).
  const [exchangesLoaded, setExchangesLoaded] = useState(false)
  const [exchangesError, setExchangesError] = useState(null)

  // The exchanges array now contains one entry per (exchange, pair) fund.
  // Look up the fund matching both the current exchange AND pair from the URL.
  // Falls back to the first entry on this exchange if the pair is missing
  // (e.g. on initial load before urlPair is set).
  const currentExchangeConfig = exchanges?.find(
    (e) => e.name === currentExchange && (urlPair ? e.pair === urlPair : true)
  ) || exchanges?.find((e) => e.name === currentExchange)
  const resolveStrategy = (config) =>
    !simpleDcaEnabled || config?.strategy === 'regime' ? 'regime' : 'dca'
  const currentStrategy = resolveStrategy(currentExchangeConfig)
  const currentPair = urlPair || currentExchangeConfig?.productId || 'BTC-USDC'

  // Only /:exchange/:pair routes belong to a fund. Every other page (Overview,
  // Backups, Notifications, Systems, ...) is global: it must not fetch fund
  // data, wait on it, or show fund-only banners and controls. currentExchange /
  // currentPair above are guesses off these routes, never a reason to fetch.
  const isFundRoute = Boolean(urlExchange && urlPair)
  const urlFund = isFundRoute
    ? exchanges.find((e) => e.name === urlExchange && (e.pair ?? e.productId)?.toUpperCase() === urlPair.toUpperCase())
    : undefined
  // Fund data is read only once the fund list has loaded and names this fund,
  // so a mistyped or removed fund never costs a request (the gateway answers
  // an unknown fund with 400) and strategy is known before any status read.
  const fundReady = isFundRoute && exchangesLoaded && Boolean(urlFund)
  const fundMissing = isFundRoute && exchangesLoaded && !urlFund
  const awaitingFundList = isFundRoute && !exchangesLoaded && !exchangesError

  // Get the current sub-path (tab) without the exchange/pair prefix
  const getSubPath = () => {
    if (!isFundRoute) return location.pathname
    return location.pathname.replace(`/${urlExchange}/${urlPair}`, '') || ''
  }

  const isActiveTab = (tabPath) => {
    const subPath = getSubPath()
    if (tabPath === '') return subPath === '' || subPath === '/'
    return subPath.startsWith(tabPath)
  }

  // The summary feeds DCA dashboards and, for regime funds, only the Config
  // tab (regime dashboards read their own endpoints). buildFundSummary walks
  // the whole fill ledger, so a regime fund skips it everywhere else.
  const summaryWanted = fundReady && (currentStrategy !== 'regime' || isActiveTab('/config'))
  const pollRegime = fundReady && currentStrategy === 'regime'

  // Committed navigation and request generations. These refs are only advanced
  // in event handlers or layout effects: an abandoned concurrent render must
  // never invalidate requests belonging to the still-committed screen.
  const selectedFund = `${currentExchange}::${currentPair}`
  // A new route must never render (or seed an editor with) another fund's data,
  // even on the first render before the navigation layout effect runs.
  const summary = summarySnapshot?.fund === selectedFund ? summarySnapshot.data : null
  const committedFundRef = useRef(selectedFund)
  const actionFenceRef = useRef({ navigationGeneration: 0, actionGeneration: 0 })
  const summaryRequestRef = useRef({ generation: 0, controller: null })
  const statusRequestRef = useRef({ generation: 0, controller: null })

  const invalidateStatusRead = () => {
    statusRequestRef.current.generation += 1
    statusRequestRef.current.controller?.abort()
    statusRequestRef.current.controller = null
  }

  useLayoutEffect(() => {
    if (committedFundRef.current !== selectedFund) {
      committedFundRef.current = selectedFund
      actionFenceRef.current.navigationGeneration += 1
      actionFenceRef.current.actionGeneration += 1

      summaryRequestRef.current.generation += 1
      summaryRequestRef.current.controller?.abort()
      summaryRequestRef.current.controller = null
      invalidateStatusRead()
      setSummarySnapshot(null)
      setLoading(true)
      setError(null)
      setRegimeRunning(null)
      setRegimeDryRun(null)
      setRegimeLifecycle(null)
      setStatusError(null)
      setCloseFundDialogOpen(false)
      setReopenFundDialogOpen(false)
      setResetDryRunConfirm(false)

      setStarting(false)
      setStopping(false)
      setClosing(false)
      setReopening(false)
      setResetting(false)
    }

    const summaryRequest = summaryRequestRef.current
    const statusRequest = statusRequestRef.current
    return () => {
      summaryRequest.controller?.abort()
      statusRequest.controller?.abort()
    }
  }, [selectedFund])

  const beginFundAction = (setPending) => {
    // A control result is authoritative over any status read begun before it.
    // This specifically prevents an old Start refresh from overwriting a Stop.
    invalidateStatusRead()
    const token = {
      navigationGeneration: actionFenceRef.current.navigationGeneration,
      actionGeneration: ++actionFenceRef.current.actionGeneration,
    }
    // A newer action owns the controls now. Clear flags left by any superseded
    // request before marking this action pending.
    setStarting(false)
    setStopping(false)
    setClosing(false)
    setReopening(false)
    setResetting(false)
    setPending(true)
    return token
  }
  const isCurrentFundAction = (token) =>
    actionFenceRef.current.navigationGeneration === token.navigationGeneration &&
    actionFenceRef.current.actionGeneration === token.actionGeneration

  // WebSocket connection for regime strategy
  const wsConnected = useRealtimeConnection()

  // Get tabs based on current strategy
  const tabs = getTabsForStrategy(currentStrategy)

  // Fetch list of configured exchanges
  // Resolves true when the list loaded, false when it did not (never rejects).
  const fetchExchanges = async (autoSelect = false) => {
    const result = await apiGet('/api/exchanges')
    if (!result.ok) {
      setExchangesError(result.status >= 400 ? `Gateway returned ${result.status}` : result.error)
      return false
    }
    const data = result.data
    setExchangesError(null)
    setExchangesLoaded(true)
    setExchanges(data.exchanges || [])
    setSimpleDcaEnabled(data.simpleDcaEnabled ?? false)
    // Only auto-select exchange on initial load if not already in URL
    // On root "/" (overview page), just set defaults without navigating away
    if (autoSelect && !urlExchange) {
      const enabled = data.exchanges?.find(e => e.enabled || e.regimeEnabled)
      const first = data.exchanges?.[0]
      const targetExchange = enabled?.name || first?.name || 'coinbase'
      const exchangeConfig = enabled || first
      const targetPair = exchangeConfig?.productId || 'BTC-USDC'
      setLastExchange(targetExchange)
      // Don't redirect away from non-exchange pages (overview, notifications, etc.)
      const nonExchangePaths = ['/', '/updown', '/sentinel', '/gateway', '/notifications', '/backups', '/systems', '/ai']
      const isNonExchangePage = nonExchangePaths.some(p => location.pathname === p || location.pathname.startsWith(p + '/'))
      if (!isNonExchangePage) {
        navigate(`/${targetExchange}/${targetPair}`, { replace: true })
      }
    } else if (autoSelect && urlExchange && !urlPair) {
      // URL has exchange but no pair - redirect to pair path
      const exchangeConfig = data.exchanges?.find(e => e.name === urlExchange)
      const targetPair = exchangeConfig?.productId || 'BTC-USDC'
      navigate(`/${urlExchange}/${targetPair}`, { replace: true })
    }
    return true
  }

  // Manual refresh/retry: surface a failure instead of staying silent.
  const retryExchanges = async () => {
    const loaded = await fetchExchanges(!exchangesLoaded)
    if (!loaded) {
      addToast({ type: 'error', title: 'Could not load funds', message: 'The fund list is still unavailable. Try again shortly.' })
    }
  }
  const fundsUnavailable = !!exchangesError && !exchangesLoaded

  // Handle exchange change from selector - update URL with pair
  const handleExchangeChange = (newExchange, newPair) => {
    const newStrategy = resolveStrategy(exchanges?.find(e => e.name === newExchange))
    setLastExchange(newExchange)
    // Preserve the current tab subpath only if it exists in the new strategy's tab list
    const currentTab = pathParts[2] || ''
    const newTabs = getTabsForStrategy(newStrategy)
    const tabValid = currentTab === '' || newTabs.some(t => t.path === `/${currentTab}`)
    navigate(`/${newExchange}/${newPair}${tabValid && currentTab ? `/${currentTab}` : ''}`)
  }

  const pairQuery = () => buildPairQuery(currentPair)

  const fetchData = async () => {
    // Capture the fund identity at request time. If the user switches funds
    // while this request is in flight, a slow response must not overwrite the
    // newer fund's summary (stale data shown for up to 30s, and ConfigEditor
    // would adopt the wrong baseline) (#111).
    const reqFund = `${currentExchange}::${currentPair}`
    const navigationGeneration = actionFenceRef.current.navigationGeneration
    const controller = new AbortController()
    summaryRequestRef.current.controller?.abort()
    const requestGeneration = ++summaryRequestRef.current.generation
    summaryRequestRef.current.controller = controller
    setLoading(true)
    setError(null)
    const isCurrent = () =>
      committedFundRef.current === reqFund &&
      actionFenceRef.current.navigationGeneration === navigationGeneration &&
      summaryRequestRef.current.generation === requestGeneration
    try {
      const result = await apiGet(`/api/${currentExchange}/summary${pairQuery()}`, { signal: controller.signal })
      if (!isCurrent()) return false
      if (!result.ok) {
        // No reply read (network failure or a non-JSON 2xx page): the gateway is unreachable.
        const unreadable = result.status === 0 || (result.status < 400 && result.data === null)
        setError(unreadable
          ? `Could not reach the gateway to load ${currentExchange}/${currentPair}.`
          : `Could not load ${currentExchange}/${currentPair}: ${result.data?.error || `HTTP ${result.status}`}`)
        setLoading(false)
        return false
      }
      const data = result.data
      setSummarySnapshot({ fund: reqFund, data })
      setLoading(false)
      return true
    } catch (err) {
      if (err?.name !== 'AbortError') throw err
      return false
    } finally {
      if (summaryRequestRef.current.controller === controller) summaryRequestRef.current.controller = null
    }
  }

  // After an operator-driven change (config save, DCA action) the fund's badges
  // (enabled/dry-run) may have moved too, so re-read the fund list. Background
  // refreshes do not: they would cost a second request per summary read.
  const refreshFund = async () => {
    if (await fetchData()) fetchExchanges()
  }

  // Fetch regime status (for header controls)
  const fetchRegimeStatus = async () => {
    if (currentStrategy !== 'regime') return
    const reqFund = `${currentExchange}::${currentPair}`
    const navigationGeneration = actionFenceRef.current.navigationGeneration
    const controller = new AbortController()
    statusRequestRef.current.controller?.abort()
    const requestGeneration = ++statusRequestRef.current.generation
    statusRequestRef.current.controller = controller
    const isCurrent = () =>
      committedFundRef.current === reqFund &&
      actionFenceRef.current.navigationGeneration === navigationGeneration &&
      statusRequestRef.current.generation === requestGeneration
    try {
      const result = await apiGet(`/api/${currentExchange}/regime/status${pairQuery()}`, { signal: controller.signal })
      if (!isCurrent()) return
      const data = result.data
      if (!result.ok || typeof data?.status?.isRunning !== 'boolean') {
        setRegimeRunning(null)
        setRegimeDryRun(null)
        setRegimeLifecycle(null)
        setStatusError('Failed to fetch engine status')
        return
      }
      if (data.engineDown === true || data.status.engineDown === true) {
        setRegimeRunning(null)
        setRegimeDryRun(null)
        setRegimeLifecycle(null)
        setStatusError('Engine unreachable')
        return
      }
      setStatusError(null)
      setRegimeRunning(data.status?.isRunning || false)
      setRegimeDryRun(data.status?.isDryRun || false)
      setRegimeLifecycle(data.status?.lifecycle?.lifecycle || 'active')
    } catch (err) {
      if (err?.name !== 'AbortError') throw err
    } finally {
      if (statusRequestRef.current.controller === controller) statusRequestRef.current.controller = null
    }
  }

  // Start regime engine
  const handleStartRegime = async () => {
    const actionGeneration = beginFundAction(setStarting)
    try {
      const result = await apiPost(`/api/${currentExchange}/regime/start${pairQuery()}`, undefined, { allowEmpty: true })
      if (!isCurrentFundAction(actionGeneration)) return
      if (result.ok) {
        invalidateStatusRead()
        setRegimeRunning(true)
        fetchRegimeStatus()
      } else {
        addToast({ type: 'error', title: 'Failed to start regime engine', message: describeMutationFailure(result) })
      }
    } finally {
      if (isCurrentFundAction(actionGeneration)) setStarting(false)
    }
  }

  // Stop regime engine
  const handleStopRegime = async () => {
    const actionGeneration = beginFundAction(setStopping)
    try {
      const result = await apiPost(`/api/${currentExchange}/regime/stop${pairQuery()}`, undefined, { allowEmpty: true })
      if (!isCurrentFundAction(actionGeneration)) return
      if (result.ok) {
        invalidateStatusRead()
        setRegimeRunning(false)
      } else {
        addToast({ type: 'error', title: 'Failed to stop regime engine', message: describeMutationFailure(result) })
      }
    } finally {
      if (isCurrentFundAction(actionGeneration)) setStopping(false)
    }
  }

  // Open the Close Fund confirmation dialog
  const openCloseFundDialog = () => {
    setCloseFundReason('')
    setCloseFundDialogOpen(true)
  }

  // Submit close — drain current cycle, then auto-stop
  const submitCloseFund = async () => {
    const actionGeneration = beginFundAction(setClosing)
    try {
      const result = await apiPost(`/api/${currentExchange}/regime/close${pairQuery()}`, { reason: closeFundReason || undefined }, { allowEmpty: true })
      if (!isCurrentFundAction(actionGeneration)) return
      if (result.ok) {
        invalidateStatusRead()
        setRegimeLifecycle('draining')
        setCloseFundDialogOpen(false)
        fetchRegimeStatus()
        fetchExchanges()
        addToast({
          type: 'success',
          title: `Draining ${currentExchange}/${currentPair}`,
          message: 'New entries blocked. Fund will close after the current cycle\'s TP fills.',
        })
      } else {
        addToast({ type: 'error', title: 'Failed to close fund', message: describeMutationFailure(result) })
      }
    } finally {
      if (isCurrentFundAction(actionGeneration)) setClosing(false)
    }
  }

  // Open the Reopen confirmation dialog
  const openReopenFundDialog = () => {
    setReopenFundDialogOpen(true)
  }

  // Submit reopen — lifecycle 'closed' → 'active'. Does NOT restart the engine.
  const submitReopenFund = async () => {
    const actionGeneration = beginFundAction(setReopening)
    try {
      const result = await apiPost(`/api/${currentExchange}/regime/reopen${pairQuery()}`, undefined, { allowEmpty: true })
      if (!isCurrentFundAction(actionGeneration)) return
      if (result.ok) {
        invalidateStatusRead()
        setRegimeLifecycle('active')
        setReopenFundDialogOpen(false)
        fetchRegimeStatus()
        fetchExchanges()
        addToast({
          type: 'success',
          title: `Reopened ${currentExchange}/${currentPair}`,
          message: 'Fund lifecycle restored to active. Click Start to resume trading.',
        })
      } else {
        addToast({ type: 'error', title: 'Failed to reopen fund', message: describeMutationFailure(result) })
      }
    } finally {
      if (isCurrentFundAction(actionGeneration)) setReopening(false)
    }
  }

  // Reset dry-run state
  const handleResetDryRun = () => {
    setResetDryRunConfirm(true)
  }

  const handleExecuteResetDryRun = async () => {
    const actionGeneration = beginFundAction(setResetting)
    try {
      const result = await apiPost(`/api/${currentExchange}/regime/dry-run/reset${pairQuery()}`, undefined, { allowEmpty: true })
      if (!isCurrentFundAction(actionGeneration)) return
      if (result.ok) {
        invalidateStatusRead()
      } else {
        addToast({ type: 'error', title: 'Failed to reset dry-run state', message: describeMutationFailure(result) })
      }
    } finally {
      if (isCurrentFundAction(actionGeneration)) {
        setResetting(false)
        setResetDryRunConfirm(false)
      }
    }
  }

  // Initial load of exchanges (with auto-select on first load)
  const loadInitialExchanges = useEffectEvent(() => fetchExchanges(true))
  useEffect(() => {
    loadInitialExchanges()
  }, [])

  // Remember the last visited exchange so non-exchange pages (Overview) can build tab links
  useEffect(() => {
    if (urlExchange && urlExchange !== lastExchange) setLastExchange(urlExchange)
  }, [urlExchange, lastExchange])

  // Summary: one read per fund, then re-read when the gateway reports order,
  // cycle, engine-state or trade activity for it (#1880).
  useEffect(() => {
    if (summaryWanted) fetchData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summaryWanted, currentExchange, currentPair])
  useRealtimeRefresh({
    events: ['regime:changed', 'regime:state', 'trade:event'],
    filter: (event) => event?.exchange === currentExchange && (!event.pair || !currentPair || event.pair === currentPair),
    enabled: summaryWanted,
    minIntervalMs: 5000,
    onRefresh: fetchData,
  })

  // Fetch regime status when on regime strategy
  useEffect(() => {
    if (pollRegime) return
    if (currentStrategy !== 'regime') {
      setRegimeRunning(false)
      return
    }
    // A regime fund whose status is not being read (a global page, or the fund
    // list not naming it yet): its last status is no longer tracked, so a read
    // still in flight must not land and the header must not trust it.
    invalidateStatusRead()
    setRegimeRunning(null)
    setRegimeDryRun(null)
    setRegimeLifecycle(null)
    setStatusError(null)
  }, [pollRegime, currentStrategy])
  // One read per fund, then pushed `regime:state` events; reconciled on socket
  // reconnect and tab visibility instead of a timer (#1878).
  useEffect(() => {
    if (pollRegime) fetchRegimeStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollRegime, currentExchange, currentPair, currentStrategy])
  useRegimeStateEvents({
    exchange: currentExchange,
    pair: currentPair,
    enabled: pollRegime,
    onState: (state) => {
      // An event can land between a fund switch and the hook re-subscribing.
      if (committedFundRef.current !== `${state.exchange}::${state.pair || currentPair}`) return
      // The pushed state is newer than any read still in flight.
      invalidateStatusRead()
      if (state.engineDown === true) {
        setRegimeRunning(null)
        setRegimeDryRun(null)
        setRegimeLifecycle(null)
        setStatusError('Engine unreachable')
        return
      }
      setStatusError(null)
      setRegimeRunning(state.isRunning)
      setRegimeDryRun(Boolean(state.isDryRun))
      setRegimeLifecycle(state.lifecycle || 'active')
    },
    onReconcile: fetchRegimeStatus,
  })

  // Build full path with exchange and pair prefix
  const buildPath = (tabPath) => `/${currentExchange}/${currentPair}${tabPath}`

  return {
    // Route / fund identity
    urlExchange, urlPair, isFundRoute, currentExchange, currentPair, currentStrategy,
    exchanges, simpleDcaEnabled, fundsUnavailable, exchangesError, awaitingFundList, fundMissing,
    // Summary and status
    summary, loading, error, summaryWanted, pollRegime,
    regimeRunning, regimeDryRun, regimeLifecycle, statusError, wsConnected,
    // Tabs
    tabs, isActiveTab, buildPath,
    // Reads
    fetchExchanges, retryExchanges, fetchData, refreshFund, fetchRegimeStatus, handleExchangeChange,
    // Lifecycle actions and their dialog state
    starting, stopping, resetting, closing, reopening,
    closeFundDialogOpen, setCloseFundDialogOpen, closeFundReason, setCloseFundReason,
    reopenFundDialogOpen, setReopenFundDialogOpen, resetDryRunConfirm, setResetDryRunConfirm,
    handleStartRegime, handleStopRegime, openCloseFundDialog, submitCloseFund,
    openReopenFundDialog, submitReopenFund, handleResetDryRun, handleExecuteResetDryRun,
  }
}
