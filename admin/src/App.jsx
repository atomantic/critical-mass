import { Component, useState, useEffect, useLayoutEffect, useRef, lazy, Suspense } from 'react'
import { Routes, Route, Link, NavLink, useLocation, useNavigate, Navigate } from './lib/router'
import ExchangeSelector from './components/ExchangeSelector'
import AddFundModal from './components/AddFundModal'
import Button from './components/ui/Button'
import RetryBanner from './components/ui/RetryBanner'
import ModalDialog from './components/ModalDialog'

// Top-level section links, rendered in both the desktop bar and the mobile menu.
const SECTION_LINKS = [
  { to: '/', label: 'Funds', end: true },
  { to: '/notifications', label: 'Notifications' },
  { to: '/backups', label: 'Backups' },
  { to: '/systems', label: 'Systems' },
  { to: '/updown', label: 'UpDown' },
  { to: '/sentinel', label: 'Sentinel' },
  { to: '/ai', label: 'AI Providers' },
  { to: '/gateway', label: 'Gateway' },
]

const Dashboard = lazy(() => import('./components/Dashboard'))
const ConfigEditor = lazy(() => import('./components/ConfigEditor'))
const TransactionsDCA = lazy(() => import('./components/TransactionsDCA'))
const TransactionsRegime = lazy(() => import('./components/TransactionsRegime'))
const ChartsDCA = lazy(() => import('./components/ChartsDCA'))
const ChartsRegime = lazy(() => import('./components/ChartsRegime'))
const CostBasisDCA = lazy(() => import('./components/CostBasisDCA'))
const CostBasisRegime = lazy(() => import('./components/CostBasisRegime'))
const Backtest = lazy(() => import('./components/Backtest'))
const Optimizer = lazy(() => import('./components/Optimizer'))
const Overview = lazy(() => import('./components/Overview'))
const KeysConfig = lazy(() => import('./components/KeysConfig'))
const NotificationsConfig = lazy(() => import('./components/NotificationsConfig'))
const BackupRestore = lazy(() => import('./components/BackupRestore'))
const RegimeDashboard = lazy(() => import('./components/RegimeDashboard'))
const Systems = lazy(() => import('./components/Systems'))
const AIProviders = lazy(() => import('./components/ai/Providers'))
const LogViewer = lazy(() => import('./components/LogViewer'))
const GatewayAccess = lazy(() => import('./components/GatewayAccess'))
const UpDownDashboard = lazy(() => import('./components/updown/Dashboard'))
const ScorecardAnalysis = lazy(() => import('./components/updown/ScorecardAnalysis'))
const SentinelDashboard = lazy(() => import('./components/sentinel/Dashboard'))
import AlertBanner from './components/sentinel/AlertBanner'
import { ToastProvider, useToast, tradeEventToToast } from './components/Toast'
import { useTradeEvents, useRealtimeConnection } from './hooks/useTradeEvents'
import { pairQuery as buildPairQuery } from './utils/api'
import { apiGet, apiPost, describeMutationFailure } from './utils/apiClient'
import usePolling from './hooks/usePolling'

// Extract quote currency from product ID (e.g., "BTC-USDC" -> "USDC", "CRO_USD" -> "USD", "BTCUSD" -> "USD")
export function getQuoteCurrency(productId) {
  if (!productId) return 'USDC'
  if (productId.includes('-')) {
    return productId.split('-')[1]
  }
  if (productId.includes('_')) {
    return productId.split('_')[1]
  }
  // Gemini format: BTCUSD - extract quote by removing known quote suffixes
  const upper = productId.toUpperCase()
  if (upper.endsWith('USDC')) return 'USDC'
  if (upper.endsWith('USDT')) return 'USDT'
  if (upper.endsWith('USD')) return 'USD'
  const match = upper.match(/^(.+?)(EUR|GBP|SGD|BTC|ETH)$/)
  if (match) return match[2]
  return 'USD'
}

// Extract base currency from product ID (e.g., "BTC-USDC" -> "BTC", "CRO_USD" -> "CRO", "BTCUSD" -> "BTC", "ETHUSD" -> "ETH")
export function getBaseCurrency(productId) {
  if (!productId) return 'BTC'
  if (productId.includes('-')) {
    return productId.split('-')[0]
  }
  if (productId.includes('_')) {
    return productId.split('_')[0]
  }
  // Gemini format: BTCUSD - extract base by removing known quote suffixes
  const upper = productId.toUpperCase()
  if (upper.endsWith('USDC')) return upper.slice(0, -4)
  if (upper.endsWith('USDT')) return upper.slice(0, -4)
  if (upper.endsWith('USD')) return upper.slice(0, -3)
  const match = upper.match(/^(.+?)(EUR|GBP|SGD|BTC|ETH)$/)
  if (match) return match[1]
  return upper
}

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

class RouteErrorBoundary extends Component {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3 text-center" role="alert">
        <p className="text-gray-300">This page could not be loaded.</p>
        <Button className="font-medium" onClick={() => window.location.reload()}>
          Reload page
        </Button>
      </div>
    )
  }
}

function RouteLoadingFallback() {
  return (
    <div className="flex items-center justify-center h-64" role="status" aria-live="polite">
      <div className="text-gray-400">Loading...</div>
    </div>
  )
}

// Component that listens to trade events and shows toasts
function TradeEventListener() {
  const { addToast } = useToast()
  const { latestEvent } = useTradeEvents()

  useEffect(() => {
    if (latestEvent) {
      // Only show toasts for significant events (skip info-level like price checks)
      const significantTypes = ['buy_filled', 'sell_placed', 'order_filled', 'complete', 'error', 'skipped']
      if (significantTypes.includes(latestEvent.type)) {
        addToast(tradeEventToToast(latestEvent))
      }
    }
  }, [latestEvent, addToast])

  return null
}

function AppContent() {
  const location = useLocation()
  const navigate = useNavigate()
  const { addToast } = useToast()

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
  const [addFundDialogOpen, setAddFundDialogOpen] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const mainContentRef = useRef(null)
  const mobileDestinationRef = useRef(null)

  const handleMobileSection = (event, to) => {
    // Match Link's same-window activation rules. Modified clicks keep both
    // their native browser behavior and the current menu/focus position.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return
    mobileDestinationRef.current = to
    setMobileMenuOpen(false)
  }

  useLayoutEffect(() => {
    if (mobileMenuOpen || mobileDestinationRef.current === null) return
    const destination = mobileDestinationRef.current
    mobileDestinationRef.current = null
    if (destination === location.pathname + location.search + location.hash) {
      // The destination's content or Suspense loading region has committed.
      // Focus the persistent landmark once; lazy completion and polls must
      // leave the operator's subsequent focus choices alone.
      mainContentRef.current?.focus()
    }
  }, [location, mobileMenuOpen])
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

    return () => {
      summaryRequestRef.current.controller?.abort()
      statusRequestRef.current.controller?.abort()
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
      if (!isCurrent()) return
      if (!result.ok) {
        // No reply read (network failure or a non-JSON 2xx page): the gateway is unreachable.
        const unreadable = result.status === 0 || (result.status < 400 && result.data === null)
        setError(unreadable
          ? `Could not reach the gateway to load ${currentExchange}/${currentPair}.`
          : `Could not load ${currentExchange}/${currentPair}: ${result.data?.error || `HTTP ${result.status}`}`)
        setLoading(false)
        return
      }
      const data = result.data
      setSummarySnapshot({ fund: reqFund, data })
      setLoading(false)

      // Also refresh exchanges list to update badges (enabled/dryRun status)
      fetchExchanges()
    } catch (err) {
      if (err?.name !== 'AbortError') throw err
    } finally {
      if (summaryRequestRef.current.controller === controller) summaryRequestRef.current.controller = null
    }
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
  useEffect(() => {
    fetchExchanges(true)
  }, [])

  // Remember the last visited exchange so non-exchange pages (Overview) can build tab links
  useEffect(() => {
    if (urlExchange && urlExchange !== lastExchange) setLastExchange(urlExchange)
  }, [urlExchange, lastExchange])

  usePolling(fetchData, 30000, { enabled: Boolean(currentExchange), deps: [currentExchange, currentPair] })

  // Fetch regime status when on regime strategy
  const pollRegime = currentStrategy === 'regime' && Boolean(currentExchange)
  useEffect(() => {
    if (!pollRegime) setRegimeRunning(false)
  }, [pollRegime])
  usePolling(fetchRegimeStatus, 5000, { enabled: pollRegime, deps: [currentExchange, currentPair, currentStrategy] })

  // Get the current sub-path (tab) without the exchange/pair prefix
  const getSubPath = () => {
    if (!urlExchange || !urlPair) return location.pathname
    return location.pathname.replace(`/${urlExchange}/${urlPair}`, '') || ''
  }

  const isActiveTab = (tabPath) => {
    const subPath = getSubPath()
    if (tabPath === '') return subPath === '' || subPath === '/'
    return subPath.startsWith(tabPath)
  }

  // Check if on overview page
  const isOverview = location.pathname === '/'

  // Check if on AI pages
  const isAI = location.pathname.startsWith('/ai')

  // Check if on UpDown pages
  const isUpDown = location.pathname.startsWith('/updown')

  // Check if on Sentinel pages
  const isSentinel = location.pathname.startsWith('/sentinel')

  // Check if on Gateway logs page
  const isGateway = location.pathname.startsWith('/gateway')

  // Build full path with exchange and pair prefix
  const buildPath = (tabPath) => `/${currentExchange}/${currentPair}${tabPath}`

  return (
    <div className="min-h-dvh">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:top-2 focus:left-2 focus:px-4 focus:py-2 focus:rounded-sm focus:bg-blue-600 focus:text-white"
        >
          Skip to main content
        </a>
        {/* Header */}
        <header className="bg-gray-800 border-b border-gray-700">
          <div className="max-w-[95%] xl:max-w-[1400px] 2xl:max-w-[1800px] 3xl:max-w-[2000px] mx-auto px-4 2xl:px-6 py-2 md:py-4">
            <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-2 xl:gap-3">
              {/* Top row: Title + Exchange selector */}
              <div className="flex items-center justify-between">
                <Link to="/" className="text-lg md:text-2xl font-bold text-white hover:text-gray-200 flex items-center gap-2 whitespace-nowrap min-w-0 shrink">
                  <svg viewBox="0 0 32 32" className="w-6 h-6 md:w-8 md:h-8 shrink-0" aria-hidden="true">
                    {/* Outer orbit ring */}
                    <ellipse cx="16" cy="16" rx="14" ry="5" fill="none" stroke="#6366f1" strokeWidth="0.8" opacity="0.5" transform="rotate(-20 16 16)" />
                    {/* Middle orbit ring */}
                    <ellipse cx="16" cy="16" rx="10" ry="4" fill="none" stroke="#818cf8" strokeWidth="0.8" opacity="0.6" transform="rotate(25 16 16)" />
                    {/* Core glow */}
                    <circle cx="16" cy="16" r="5" fill="url(#cmCoreGlow)" />
                    {/* Bright core */}
                    <circle cx="16" cy="16" r="2.5" fill="#e0e7ff" />
                    {/* Orbiting body */}
                    <circle cx="27" cy="12" r="1.5" fill="#a5b4fc" />
                    <defs>
                      <radialGradient id="cmCoreGlow">
                        <stop offset="0%" stopColor="#c7d2fe" />
                        <stop offset="60%" stopColor="#6366f1" />
                        <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
                      </radialGradient>
                    </defs>
                  </svg>
                  Critical Mass
                </Link>
                <div className="flex items-center gap-1.5 xl:hidden shrink-0">
                  {/* Hamburger menu button for mobile */}
                  <button
                    onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                    className="min-h-11 min-w-11 p-2 text-gray-400 hover:text-white transition-colors inline-flex items-center justify-center"
                    aria-label="Toggle menu"
                  >
                    {mobileMenuOpen ? (
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    ) : (
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>

              {/* Bottom row on mobile / Right side on desktop */}
              <nav aria-label="Sections" className="hidden xl:flex items-center justify-end gap-4">
                {SECTION_LINKS.map(({ to, label, end }) => (
                  <NavLink
                    key={to}
                    to={to}
                    end={end}
                    className={({ isActive }) => `min-h-11 inline-flex items-center px-2 xl:px-3 py-1.5 text-xs xl:text-sm hover:text-white transition-colors whitespace-nowrap ${isActive ? 'text-white underline underline-offset-4 decoration-blue-500' : 'text-gray-400'}`}
                  >
                    {label}
                  </NavLink>
                ))}
              </nav>
            </div>

            {/* Mobile menu dropdown */}
            {mobileMenuOpen && (
              <nav aria-label="Sections" className="xl:hidden mt-2 pt-2 border-t border-gray-700 flex flex-col gap-1">
                {SECTION_LINKS.map(({ to, label, end }) => (
                  <NavLink
                    key={to}
                    to={to}
                    end={end}
                    onClick={(event) => handleMobileSection(event, to)}
                    className={({ isActive }) => `min-h-11 px-3 py-2 text-sm hover:text-white hover:bg-gray-700 rounded-sm transition-colors flex items-center ${isActive ? 'text-white bg-gray-700' : 'text-gray-400'}`}
                  >
                    {label}
                  </NavLink>
                ))}
              </nav>
            )}
          </div>
        </header>

        {/* Exchange sub-nav (hidden on overview and AI pages) */}
        {!isOverview && !isAI && !isUpDown && !isSentinel && !isGateway && (
          <nav aria-label="Fund views" className="bg-gray-800 border-b border-gray-700">
            <div className="max-w-[95%] xl:max-w-[1400px] 2xl:max-w-[1800px] 3xl:max-w-[2000px] mx-auto px-4 2xl:px-6">
              <div className="flex flex-col xl:flex-row xl:items-center gap-0 xl:gap-2">
                <div className="flex w-full xl:w-auto gap-1 overflow-x-auto min-w-0">
                  {!fundsUnavailable && tabs.map(tab => (
                    <Link
                      key={tab.path}
                      to={buildPath(tab.path)}
                      aria-current={isActiveTab(tab.path) ? 'page' : undefined}
                      className={`px-3 sm:px-4 py-2.5 sm:py-3 text-xs sm:text-sm font-medium transition-colors whitespace-nowrap ${
                        isActiveTab(tab.path)
                          ? 'text-white border-b-2 border-blue-500'
                          : 'text-gray-400 hover:text-white'
                      }`}
                    >
                      {tab.name}
                    </Link>
                  ))}
                </div>
                <div className="flex items-center gap-2 md:gap-3 flex-wrap max-w-full px-3 md:px-0 py-1.5 shrink-0 xl:ml-auto">
                  {fundsUnavailable ? (
                    <div role="alert" className="flex items-center gap-2 text-xs md:text-sm text-red-300">
                      <span>Could not load funds ({exchangesError})</span>
                      <Button variant="secondary" size="sm" onClick={retryExchanges}>
                        Retry
                      </Button>
                    </div>
                  ) : (
                    <ExchangeSelector
                      currentExchange={currentExchange}
                      currentPair={currentPair}
                      exchanges={exchanges}
                      onChange={handleExchangeChange}
                      onRefresh={retryExchanges}
                      onAddFund={() => setAddFundDialogOpen(true)}
                    />
                  )}
                {!fundsUnavailable && currentStrategy === 'regime' && regimeRunning !== null && (<>

                    {regimeDryRun && (
                      <span className="px-1.5 md:px-2 py-0.5 md:py-1 bg-purple-900/50 border border-purple-500 text-purple-400 text-2xs md:text-xs font-medium rounded-sm">
                        DRY-RUN
                      </span>
                    )}
                    {regimeLifecycle === 'draining' && (
                      <span className="px-1.5 md:px-2 py-0.5 md:py-1 bg-yellow-900/50 border border-yellow-500 text-yellow-300 text-2xs md:text-xs font-medium rounded-sm animate-pulse" title="Draining: blocking new entries; will close after current cycle's TP fills.">
                        DRAINING
                      </span>
                    )}
                    {regimeLifecycle === 'closed' && (
                      <span className="px-1.5 md:px-2 py-0.5 md:py-1 bg-red-900/50 border border-red-500 text-red-300 text-2xs md:text-xs font-medium rounded-sm" title="Fund is closed. Click Reopen to reactivate.">
                        CLOSED
                      </span>
                    )}
                    <div className="flex items-center gap-1 md:gap-1.5 text-xs md:text-sm">
                      <span className={`w-1.5 md:w-2 h-1.5 md:h-2 rounded-full ${regimeRunning ? 'bg-green-500 animate-pulse' : 'bg-gray-500'}`} />
                      <span className={regimeRunning ? 'text-green-400' : 'text-gray-400'}>
                        {regimeRunning ? 'Running' : 'Stopped'}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 md:gap-1.5 text-xs md:text-sm">
                      <span className={`w-1.5 md:w-2 h-1.5 md:h-2 rounded-full ${wsConnected ? 'bg-blue-500' : 'bg-red-500'}`} />
                      <span className={wsConnected ? 'text-blue-400' : 'text-red-400'}>
                        {wsConnected ? 'Live' : 'Offline'}
                      </span>
                    </div>
                    {regimeRunning ? (
                      <>
                        {regimeDryRun && (
                          <Button
                            variant="purple"
                            size="responsive-xs"
                            onClick={handleResetDryRun}
                            disabled={resetting}
                            title="Reset dry-run state"
                          >
                            {resetting ? '...' : 'Reset'}
                          </Button>
                        )}
                        {regimeLifecycle === 'active' && (
                          <Button
                            variant="warning"
                            size="responsive"
                            className="font-medium"
                            onClick={openCloseFundDialog}
                            disabled={closing}
                            title="Block new entries; auto-close after current cycle's TP fills"
                          >
                            {closing ? '...' : 'Close Fund'}
                          </Button>
                        )}
                        <Button
                          variant="destructive"
                          size="responsive"
                          className="font-medium"
                          onClick={handleStopRegime}
                          disabled={stopping}
                        >
                          {stopping ? '...' : 'Stop'}
                        </Button>
                      </>
                    ) : regimeLifecycle === 'closed' ? (
                      <Button
                        size="responsive"
                        className="font-medium"
                        onClick={openReopenFundDialog}
                        disabled={reopening}
                        title="Reopen fund (does not restart the engine)"
                      >
                        {reopening ? '...' : 'Reopen'}
                      </Button>
                    ) : (
                      <Button
                        variant="success"
                        size="responsive"
                        className="font-medium"
                        onClick={handleStartRegime}
                        disabled={starting}
                      >
                        {starting ? '...' : 'Start'}
                      </Button>
                    )}
                </>)}
                </div>
              </div>
            </div>
          </nav>
        )}

        {/* Global Alert Banner */}
        <AlertBanner />

        {/* Close Fund confirmation dialog */}
        {closeFundDialogOpen && (
          <ModalDialog
            onClose={() => setCloseFundDialogOpen(false)}
            dismissible={!closing}
            labelledBy="close-fund-title"
            describedBy="close-fund-description"
          >
            <h3 id="close-fund-title" className="text-white text-lg font-medium mb-3">
              Close <span className="font-mono text-yellow-400">{currentExchange}/{currentPair}</span>?
            </h3>
            <p id="close-fund-description" className="text-gray-300 text-sm mb-2">
              This blocks all new entries immediately. Existing take-profit orders
              will remain in place, and the fund will close automatically
              after the current cycle's TP fills.
            </p>
            <p className="text-gray-400 text-xs mb-4">
              You can reopen the fund later, but it will not auto-resume on engine restart.
            </p>
            <div className="mb-4">
              <label htmlFor="close-fund-reason" className="block text-xs uppercase tracking-wider text-gray-400 mb-1">
                Reason (optional)
              </label>
              <input
                id="close-fund-reason"
                type="text"
                value={closeFundReason}
                onChange={(e) => setCloseFundReason(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submitCloseFund()}
                placeholder="e.g. winding down for tax season"
                className="w-full bg-gray-900 border border-gray-700 rounded-sm px-3 py-2 text-white text-sm focus:border-yellow-500 focus:outline-hidden"
                disabled={closing}
              />
            </div>
            <div className="flex justify-end gap-3">
              <Button variant="cancel"
                onClick={() => setCloseFundDialogOpen(false)}
                disabled={closing}
                autoFocus
              >
                Cancel
              </Button>
              <Button variant="warning"
                onClick={submitCloseFund}
                disabled={closing}
              >
                {closing ? 'Closing...' : 'Close Fund'}
              </Button>
            </div>
          </ModalDialog>
        )}

        {/* Add Fund modal (triggered from ExchangeSelector dropdown) */}
        <AddFundModal
          open={addFundDialogOpen}
          onClose={() => setAddFundDialogOpen(false)}
          exchanges={exchanges}
          onCreated={async ({ exchange, pair }) => {
            const refreshed = await fetchExchanges()
            navigate(`/${exchange}/${pair}/config`)
            addToast({
              type: 'success',
              title: `Fund created: ${exchange}/${pair}`,
              message: 'Review the config, then press Start in the fund header to begin trading.',
            })
            if (!refreshed) {
              addToast({
                type: 'warning',
                title: 'Fund list not refreshed',
                message: `${exchange}/${pair} was created, but the fund list could not be reloaded. Do not create it again; use Refresh Exchanges.`,
              })
            }
          }}
        />

        {/* Reopen Fund confirmation dialog */}
        {reopenFundDialogOpen && (
          <ModalDialog
            onClose={() => setReopenFundDialogOpen(false)}
            dismissible={!reopening}
            labelledBy="reopen-fund-title"
            describedBy="reopen-fund-description"
          >
            <h3 id="reopen-fund-title" className="text-white text-lg font-medium mb-3">
              Reopen <span className="font-mono text-blue-400">{currentExchange}/{currentPair}</span>?
            </h3>
            <p id="reopen-fund-description" className="text-gray-300 text-sm mb-2">
              This restores the fund's lifecycle to <span className="text-green-400">active</span> so the
              regime engine can run again.
            </p>
            <p className="text-gray-400 text-xs mb-4">
              Reopening does <strong>not</strong> restart the engine. After confirming, click
              <span className="font-mono text-green-400"> Start </span>
              to resume trading.
            </p>
            <div className="flex justify-end gap-3">
              <Button variant="cancel"
                onClick={() => setReopenFundDialogOpen(false)}
                disabled={reopening}
                autoFocus
              >
                Cancel
              </Button>
              <Button
                onClick={submitReopenFund}
                disabled={reopening}
              >
                {reopening ? 'Reopening...' : 'Reopen Fund'}
              </Button>
            </div>
          </ModalDialog>
        )}

        {/* Reset Dry-Run confirmation dialog */}
        {resetDryRunConfirm && (
          <ModalDialog
            onClose={() => setResetDryRunConfirm(false)}
            dismissible={!resetting}
            labelledBy="reset-dry-run-title"
            describedBy="reset-dry-run-description"
          >
            <h3 id="reset-dry-run-title" className="text-white text-lg font-medium mb-3">Reset Dry-Run State</h3>
            <p id="reset-dry-run-description" className="text-gray-300 text-sm mb-4">
              Clear simulated trading history for <span className="font-mono text-purple-400">{currentExchange}/{currentPair}</span>?
            </p>
            <p className="text-gray-400 text-xs mb-4">
              This wipes the in-memory dry-run history. Live positions and fills are not affected.
            </p>
            <div className="flex justify-end gap-3">
              <Button variant="cancel"
                onClick={() => setResetDryRunConfirm(false)}
                disabled={resetting}
                autoFocus
              >
                Cancel
              </Button>
              <Button variant="purple"
                onClick={handleExecuteResetDryRun}
                disabled={resetting}
              >
                {resetting ? 'Resetting…' : 'Reset Dry-Run'}
              </Button>
            </div>
          </ModalDialog>
        )}

        {/* Main Content */}
        <main ref={mainContentRef} id="main-content" tabIndex={-1} className="max-w-[95%] xl:max-w-[1400px] 2xl:max-w-[1800px] 3xl:max-w-[2000px] mx-auto px-4 2xl:px-6 py-6 focus:outline-hidden">
          {currentStrategy === 'regime' && statusError && (
            <RetryBanner message={statusError} onRetry={fetchRegimeStatus} retryLabel="Retry engine status" />
          )}
          {error && (!isActiveTab('/config') || summary?.config) && (
            <RetryBanner message={error} onRetry={fetchData} />
          )}

          {loading && !summary && !isActiveTab('/config') && !isOverview && !isAI && !isUpDown && !isSentinel && !isGateway ? (
            <RouteLoadingFallback />
          ) : (
            <RouteErrorBoundary key={location.pathname}>
              <Suspense fallback={<RouteLoadingFallback />}>
                <Routes>
              {/* Overview dashboard at root */}
              <Route path="/" element={<Overview />} />

              {/* Pair-based routes - strategy determined from exchange config.
                  The `key` includes both exchange and pair so React unmounts
                  and remounts the dashboard whenever the user navigates to a
                  different fund — this guarantees fresh state and re-fetched
                  data instead of stale data from the previous fund. */}
              <Route path="/:exchange/:pair" element={
                currentStrategy === 'regime'
                  ? <RegimeDashboard key={`${currentExchange}-${currentPair}`} exchange={currentExchange} pair={currentPair} />
                  : <Dashboard key={`${currentExchange}-${currentPair}`} summary={summary} onRefresh={fetchData} exchange={currentExchange} pair={currentPair} />
              } />
              <Route path="/:exchange/:pair/cost-basis" element={
                currentStrategy === 'regime'
                  ? <CostBasisRegime key={`${currentExchange}-${currentPair}`} exchange={currentExchange} pair={currentPair} />
                  : <CostBasisDCA key={`${currentExchange}-${currentPair}`} summary={summary} quoteCurrency={getQuoteCurrency(summary?.config?.productId)} exchange={currentExchange} pair={currentPair} />
              } />
              <Route path="/:exchange/:pair/transactions" element={
                currentStrategy === 'regime'
                  ? <TransactionsRegime key={`${currentExchange}-${currentPair}`} exchange={currentExchange} pair={currentPair} />
                  : <TransactionsDCA transactions={summary?.transactions} baseCurrency={getBaseCurrency(summary?.config?.productId)} quoteCurrency={getQuoteCurrency(summary?.config?.productId)} />
              } />
              <Route path="/:exchange/:pair/charts" element={
                currentStrategy === 'regime'
                  ? <ChartsRegime key={`${currentExchange}-${currentPair}`} exchange={currentExchange} pair={currentPair} />
                  : <ChartsDCA summary={summary} quoteCurrency={getQuoteCurrency(summary?.config?.productId)} />
              } />
              <Route path="/:exchange/:pair/config" element={<ConfigEditor key={`${currentExchange}-${currentPair}`} config={summary?.config} loadError={error || (!loading && !summary?.config ? 'Configuration is unavailable' : null)} onRetry={fetchData} onSave={fetchData} exchange={currentExchange} pair={currentPair} strategy={currentStrategy} engineRunning={regimeRunning} engineDryRun={regimeDryRun} onRestart={fetchRegimeStatus} />} />

              {/* DCA-only routes (backtest, optimizer) */}
              {simpleDcaEnabled && currentStrategy !== 'regime' && <>
              <Route path="/:exchange/:pair/backtest" element={<Backtest key={`${currentExchange}:${currentPair}`} summary={summary} exchange={currentExchange} pair={currentPair} quoteCurrency={getQuoteCurrency(summary?.config?.productId)} />} />
              <Route path="/:exchange/:pair/optimizer" element={<Optimizer key={`${currentExchange}:${currentPair}`} exchange={currentExchange} pair={currentPair} />} />
              </>}

              {/* API Keys - in sub-nav tabs */}
              <Route path="/:exchange/:pair/keys" element={<KeysConfig key={currentExchange} exchange={currentExchange} funds={exchanges.filter(e => e.name === currentExchange)} onSave={fetchExchanges} />} />

              {/* PM2 Logs - per exchange engine */}
              <Route path="/:exchange/:pair/logs" element={<LogViewer processName={`critical-mass-${currentExchange}`} />} />

              {/* Notifications - global (not exchange-specific) */}
              <Route path="/notifications" element={<NotificationsConfig />} />

              {/* Backups - global (not exchange-specific) */}
              <Route path="/backups" element={<BackupRestore />} />

              {/* Systems - debug showcase of all celestial body types */}
              <Route path="/systems" element={<Systems />} />

              {/* AI Provider management */}
              <Route path="/ai" element={<AIProviders />} />

              {/* UpDown BTC perp-long dashboard */}
              <Route path="/updown/analysis" element={<ScorecardAnalysis />} />
              <Route path="/updown" element={<UpDownDashboard />} />

              {/* Sentinel news monitor */}
              <Route path="/sentinel" element={<SentinelDashboard />} />

              {/* Gateway access + logs */}
              <Route path="/gateway" element={<GatewayAccess />} />
              <Route path="/gateway/logs" element={<LogViewer processName="critical-mass" />} />

              {/* Legacy route - redirect /:exchange (without pair) to /:exchange/:pair */}
              <Route path="/:exchange" element={<Navigate to={`/${currentExchange}/${currentPair}`} replace />} />

              {/* Catch invalid routes - redirect to current exchange/pair */}
              <Route path="*" element={<Navigate to={`/${currentExchange}/${currentPair}`} replace />} />
                </Routes>
              </Suspense>
            </RouteErrorBoundary>
          )}
        </main>
      </div>
  )
}

function App() {
  return (
    <ToastProvider>
      <TradeEventListener />
      <AppContent />
    </ToastProvider>
  )
}

export default App
