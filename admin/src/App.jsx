import { useState, useEffect, lazy, Suspense } from 'react'
import { Routes, Route, Link, useLocation, useNavigate, Navigate } from 'react-router-dom'
import Dashboard from './components/Dashboard'
import ConfigEditor from './components/ConfigEditor'
import TransactionsDCA from './components/TransactionsDCA'
import TransactionsRegime from './components/TransactionsRegime'
import ChartsDCA from './components/ChartsDCA'
import ChartsRegime from './components/ChartsRegime'
import CostBasisDCA from './components/CostBasisDCA'
import CostBasisRegime from './components/CostBasisRegime'
import Backtest from './components/Backtest'
import Optimizer from './components/Optimizer'
import Overview from './components/Overview'
import ExchangeSelector from './components/ExchangeSelector'
import AddFundModal from './components/AddFundModal'
import KeysConfig from './components/KeysConfig'
import NotificationsConfig from './components/NotificationsConfig'
import BackupRestore from './components/BackupRestore'
import RegimeDashboard from './components/RegimeDashboard'
const Systems = lazy(() => import('./components/Systems'))
const AIProviders = lazy(() => import('./components/ai/Providers'))
const LogViewer = lazy(() => import('./components/LogViewer'))
const UpDownDashboard = lazy(() => import('./components/updown/Dashboard'))
const ScorecardAnalysis = lazy(() => import('./components/updown/ScorecardAnalysis'))
const SentinelDashboard = lazy(() => import('./components/sentinel/Dashboard'))
import AlertBanner from './components/sentinel/AlertBanner'
import { ToastProvider, useToast, tradeEventToToast } from './components/Toast'
import { useTradeEvents, useRegimeEvents } from './hooks/useTradeEvents'

// Extract quote currency from product ID (e.g., "BTC-USDC" -> "USDC", "CRO_USD" -> "USD", "BTCUSD" -> "USD")
export function getQuoteCurrency(productId) {
  if (!productId) return 'USDC'
  if (productId.includes('-')) {
    return productId.split('-')[1]
  }
  if (productId.includes('_')) {
    return productId.split('_')[1]
  }
  // For Gemini-style (BTCUSD), strip BTC prefix
  return productId.replace(/^BTC/, '') || 'USD'
}

// Extract base currency from product ID (e.g., "BTC-USDC" -> "BTC", "CRO_USD" -> "CRO", "BTCUSD" -> "BTC")
export function getBaseCurrency(productId) {
  if (!productId) return 'BTC'
  if (productId.includes('-')) {
    return productId.split('-')[0]
  }
  if (productId.includes('_')) {
    return productId.split('_')[0]
  }
  // For Gemini-style (BTCUSD), assume BTC prefix
  return 'BTC'
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
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [regimeRunning, setRegimeRunning] = useState(false)
  const [regimeDryRun, setRegimeDryRun] = useState(false)
  const [regimeLifecycle, setRegimeLifecycle] = useState('active')
  const [stopping, setStopping] = useState(false)
  const [starting, setStarting] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [closing, setClosing] = useState(false)
  const [reopening, setReopening] = useState(false)
  const [closeFundDialogOpen, setCloseFundDialogOpen] = useState(false)
  const [closeFundReason, setCloseFundReason] = useState('')
  const [reopenFundDialogOpen, setReopenFundDialogOpen] = useState(false)
  const [addFundDialogOpen, setAddFundDialogOpen] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [simpleDcaEnabled, setSimpleDcaEnabled] = useState(false)

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

  // WebSocket connection for regime strategy
  const { connected: wsConnected } = useRegimeEvents(currentStrategy === 'regime' ? currentExchange : null)

  // Get tabs based on current strategy
  const tabs = getTabsForStrategy(currentStrategy)

  // Fetch list of configured exchanges
  const fetchExchanges = async (autoSelect = false) => {
    const res = await fetch('/api/exchanges')
    if (res.ok) {
      const data = await res.json()
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
    }
  }

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

  // Build the ?pair= query string for the active fund. Used by every API
  // call below so the gateway routes target the correct fund instead of the
  // exchange's default pair.
  const pairQuery = () => `?pair=${encodeURIComponent(currentPair)}`

  const fetchData = async () => {
    setLoading(true)
    setError(null)
    const res = await fetch(`/api/${currentExchange}/summary${pairQuery()}`)
    if (!res.ok) {
      setError('Failed to fetch data')
      setLoading(false)
      return
    }
    const data = await res.json()
    setSummary(data)
    setLoading(false)

    // Also refresh exchanges list to update badges (enabled/dryRun status)
    fetchExchanges()
  }

  // Fetch regime status (for header controls)
  const fetchRegimeStatus = async () => {
    if (currentStrategy !== 'regime') return
    const res = await fetch(`/api/${currentExchange}/regime/status${pairQuery()}`)
    if (res.ok) {
      const data = await res.json()
      setRegimeRunning(data.status?.isRunning || false)
      setRegimeDryRun(data.status?.isDryRun || false)
      setRegimeLifecycle(data.status?.lifecycle?.lifecycle || 'active')
    }
  }

  // Start regime engine
  const handleStartRegime = async () => {
    setStarting(true)
    const res = await fetch(`/api/${currentExchange}/regime/start${pairQuery()}`, { method: 'POST' })
    if (res.ok) {
      setRegimeRunning(true)
      fetchRegimeStatus()
    } else {
      const err = await res.json().catch(() => ({}))
      addToast({ type: 'error', title: 'Failed to start regime engine', message: err.error || 'Unknown error' })
    }
    setStarting(false)
  }

  // Stop regime engine
  const handleStopRegime = async () => {
    setStopping(true)
    const res = await fetch(`/api/${currentExchange}/regime/stop${pairQuery()}`, { method: 'POST' })
    if (res.ok) {
      setRegimeRunning(false)
    }
    setStopping(false)
  }

  // Open the Close Fund confirmation dialog
  const openCloseFundDialog = () => {
    setCloseFundReason('')
    setCloseFundDialogOpen(true)
  }

  // Submit close — drain current cycle, then auto-stop
  const submitCloseFund = async () => {
    setClosing(true)
    const res = await fetch(`/api/${currentExchange}/regime/close${pairQuery()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: closeFundReason || undefined }),
    })
    if (res.ok) {
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
      const err = await res.json().catch(() => ({}))
      addToast({ type: 'error', title: 'Failed to close fund', message: err.error || 'Unknown error' })
    }
    setClosing(false)
  }

  // Open the Reopen confirmation dialog
  const openReopenFundDialog = () => {
    setReopenFundDialogOpen(true)
  }

  // Submit reopen — lifecycle 'closed' → 'active'. Does NOT restart the engine.
  const submitReopenFund = async () => {
    setReopening(true)
    const res = await fetch(`/api/${currentExchange}/regime/reopen${pairQuery()}`, { method: 'POST' })
    if (res.ok) {
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
      const err = await res.json().catch(() => ({}))
      addToast({ type: 'error', title: 'Failed to reopen fund', message: err.error || 'Unknown error' })
    }
    setReopening(false)
  }

  // Reset dry-run state
  const handleResetDryRun = async () => {
    setResetting(true)
    await fetch(`/api/${currentExchange}/regime/dry-run/reset${pairQuery()}`, { method: 'POST' })
    setResetting(false)
  }

  // Initial load of exchanges (with auto-select on first load)
  useEffect(() => {
    fetchExchanges(true)
  }, [])

  // Remember the last visited exchange so non-exchange pages (Overview) can build tab links
  useEffect(() => {
    if (urlExchange && urlExchange !== lastExchange) setLastExchange(urlExchange)
  }, [urlExchange, lastExchange])

  // Fetch data when exchange changes
  useEffect(() => {
    if (currentExchange) {
      fetchData()
      // Set up auto-refresh
      const interval = setInterval(fetchData, 30000)
      return () => clearInterval(interval)
    }
  }, [currentExchange])

  // Fetch regime status when on regime strategy
  useEffect(() => {
    if (currentStrategy === 'regime' && currentExchange) {
      fetchRegimeStatus()
      const interval = setInterval(fetchRegimeStatus, 5000)
      return () => clearInterval(interval)
    } else {
      setRegimeRunning(false)
    }
  }, [currentExchange, currentStrategy])

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
    <div className="min-h-screen">
        {/* Header */}
        <header className="bg-gray-800 border-b border-gray-700">
          <div className="max-w-[95%] xl:max-w-[1400px] 2xl:max-w-[1800px] 3xl:max-w-[2000px] mx-auto px-4 2xl:px-6 py-2 md:py-4">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 md:gap-3">
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
                <div className="flex items-center gap-1.5 md:hidden shrink-0">
                  {/* Hamburger menu button for mobile */}
                  <button
                    onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                    className="p-2 text-gray-400 hover:text-white transition-colors"
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
              <div className="flex items-center justify-between md:justify-end gap-1.5 md:gap-4">
                <Link
                  to="/"
                  className="hidden md:block px-2 lg:px-3 py-1.5 text-xs lg:text-sm text-gray-400 hover:text-white transition-colors whitespace-nowrap"
                >
                  DCA
                </Link>
                <Link
                  to="/notifications"
                  className="hidden md:block px-2 lg:px-3 py-1.5 text-xs lg:text-sm text-gray-400 hover:text-white transition-colors whitespace-nowrap"
                >
                  Notifications
                </Link>
                <Link
                  to="/backups"
                  className="hidden md:block px-2 lg:px-3 py-1.5 text-xs lg:text-sm text-gray-400 hover:text-white transition-colors whitespace-nowrap"
                >
                  Backups
                </Link>
                <Link
                  to="/systems"
                  className="hidden md:block px-2 lg:px-3 py-1.5 text-xs lg:text-sm text-gray-400 hover:text-white transition-colors whitespace-nowrap"
                >
                  Systems
                </Link>
                <Link
                  to="/updown"
                  className="hidden md:block px-2 lg:px-3 py-1.5 text-xs lg:text-sm text-gray-400 hover:text-white transition-colors whitespace-nowrap"
                >
                  UpDown
                </Link>
                <Link
                  to="/sentinel"
                  className="hidden md:block px-2 lg:px-3 py-1.5 text-xs lg:text-sm text-gray-400 hover:text-white transition-colors whitespace-nowrap"
                >
                  Sentinel
                </Link>
                <Link
                  to="/ai"
                  className="hidden md:block px-2 lg:px-3 py-1.5 text-xs lg:text-sm text-gray-400 hover:text-white transition-colors whitespace-nowrap"
                >
                  AI
                </Link>
                <Link
                  to="/gateway/logs"
                  className="hidden md:block px-2 lg:px-3 py-1.5 text-xs lg:text-sm text-gray-400 hover:text-white transition-colors whitespace-nowrap"
                >
                  Gateway
                </Link>
              </div>
            </div>

            {/* Mobile menu dropdown */}
            {mobileMenuOpen && (
              <div className="md:hidden mt-2 pt-2 border-t border-gray-700 flex flex-col gap-1">
                <Link
                  to="/"
                  onClick={() => setMobileMenuOpen(false)}
                  className="px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
                >
                  DCA
                </Link>
                <Link
                  to="/notifications"
                  onClick={() => setMobileMenuOpen(false)}
                  className="px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
                >
                  Notifications
                </Link>
                <Link
                  to="/backups"
                  onClick={() => setMobileMenuOpen(false)}
                  className="px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
                >
                  Backups
                </Link>
                <Link
                  to="/systems"
                  onClick={() => setMobileMenuOpen(false)}
                  className="px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
                >
                  Systems
                </Link>
                <Link
                  to="/updown"
                  onClick={() => setMobileMenuOpen(false)}
                  className="px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
                >
                  UpDown
                </Link>
                <Link
                  to="/sentinel"
                  onClick={() => setMobileMenuOpen(false)}
                  className="px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
                >
                  Sentinel
                </Link>
                <Link
                  to="/ai"
                  onClick={() => setMobileMenuOpen(false)}
                  className="px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
                >
                  AI Providers
                </Link>
                <Link
                  to="/gateway/logs"
                  onClick={() => setMobileMenuOpen(false)}
                  className="px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
                >
                  Gateway
                </Link>
              </div>
            )}
          </div>
        </header>

        {/* Exchange sub-nav (hidden on overview and AI pages) */}
        {!isOverview && !isAI && !isUpDown && !isSentinel && !isGateway && (
          <nav className="bg-gray-800 border-b border-gray-700">
            <div className="max-w-[95%] xl:max-w-[1400px] 2xl:max-w-[1800px] 3xl:max-w-[2000px] mx-auto px-4 2xl:px-6">
              <div className="flex flex-col md:flex-row md:items-center gap-0 md:gap-2">
                <div className="flex gap-1 overflow-x-auto min-w-0">
                  {tabs.map(tab => (
                    <Link
                      key={tab.path}
                      to={buildPath(tab.path)}
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
                <div className="flex items-center gap-2 md:gap-3 flex-wrap px-3 md:px-0 py-1.5 shrink-0 md:ml-auto">
                  <ExchangeSelector
                    currentExchange={currentExchange}
                    currentPair={currentPair}
                    exchanges={exchanges}
                    onChange={handleExchangeChange}
                    onRefresh={fetchExchanges}
                    onAddFund={() => setAddFundDialogOpen(true)}
                  />
                {currentStrategy === 'regime' && (<>

                    {regimeDryRun && (
                      <span className="px-1.5 md:px-2 py-0.5 md:py-1 bg-purple-900/50 border border-purple-500 text-purple-400 text-[10px] md:text-xs font-medium rounded">
                        DRY-RUN
                      </span>
                    )}
                    {regimeLifecycle === 'draining' && (
                      <span className="px-1.5 md:px-2 py-0.5 md:py-1 bg-yellow-900/50 border border-yellow-500 text-yellow-300 text-[10px] md:text-xs font-medium rounded animate-pulse" title="Draining: blocking new entries; will close after current cycle's TP fills.">
                        DRAINING
                      </span>
                    )}
                    {regimeLifecycle === 'closed' && (
                      <span className="px-1.5 md:px-2 py-0.5 md:py-1 bg-red-900/50 border border-red-500 text-red-300 text-[10px] md:text-xs font-medium rounded" title="Fund is closed. Click Reopen to reactivate.">
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
                          <button
                            onClick={handleResetDryRun}
                            disabled={resetting}
                            className="px-1.5 md:px-2 py-0.5 md:py-1 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-800 rounded text-[10px] md:text-xs transition-colors"
                            title="Reset dry-run state"
                          >
                            {resetting ? '...' : 'Reset'}
                          </button>
                        )}
                        {regimeLifecycle === 'active' && (
                          <button
                            onClick={openCloseFundDialog}
                            disabled={closing}
                            className="px-2 md:px-3 py-1 md:py-1.5 bg-yellow-600 hover:bg-yellow-700 disabled:bg-yellow-800 rounded text-xs md:text-sm font-medium transition-colors"
                            title="Block new entries; auto-close after current cycle's TP fills"
                          >
                            {closing ? '...' : 'Close Fund'}
                          </button>
                        )}
                        <button
                          onClick={handleStopRegime}
                          disabled={stopping}
                          className="px-2 md:px-3 py-1 md:py-1.5 bg-red-600 hover:bg-red-700 disabled:bg-red-800 rounded text-xs md:text-sm font-medium transition-colors"
                        >
                          {stopping ? '...' : 'Stop'}
                        </button>
                      </>
                    ) : regimeLifecycle === 'closed' ? (
                      <button
                        onClick={openReopenFundDialog}
                        disabled={reopening}
                        className="px-2 md:px-3 py-1 md:py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 rounded text-xs md:text-sm font-medium transition-colors"
                        title="Reopen fund (does not restart the engine)"
                      >
                        {reopening ? '...' : 'Reopen'}
                      </button>
                    ) : (
                      <button
                        onClick={handleStartRegime}
                        disabled={starting}
                        className="px-2 md:px-3 py-1 md:py-1.5 bg-green-600 hover:bg-green-700 disabled:bg-green-800 rounded text-xs md:text-sm font-medium transition-colors"
                      >
                        {starting ? '...' : 'Start'}
                      </button>
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
          <div
            className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
            onClick={() => !closing && setCloseFundDialogOpen(false)}
          >
            <div
              className="bg-gray-800 border border-gray-600 rounded-lg p-6 max-w-md mx-4 w-full"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-white text-lg font-medium mb-3">
                Close <span className="font-mono text-yellow-400">{currentExchange}/{currentPair}</span>?
              </h3>
              <p className="text-gray-300 text-sm mb-2">
                This blocks all new entries immediately. The fund's existing take-profit
                order(s) will remain in place, and the fund will close automatically
                after the current cycle's TP fills.
              </p>
              <p className="text-gray-500 text-xs mb-4">
                You can reopen the fund later, but it will not auto-resume on engine restart.
              </p>
              <div className="mb-4">
                <label className="block text-xs uppercase tracking-wider text-gray-400 mb-1">
                  Reason (optional)
                </label>
                <input
                  type="text"
                  value={closeFundReason}
                  onChange={(e) => setCloseFundReason(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submitCloseFund()}
                  placeholder="e.g. winding down for tax season"
                  className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:border-yellow-500 focus:outline-none"
                  disabled={closing}
                  autoFocus
                />
              </div>
              <div className="flex justify-end gap-3">
                <button
                  className="px-4 py-2 text-sm text-gray-400 hover:text-white bg-gray-700 hover:bg-gray-600 rounded transition-colors disabled:opacity-50"
                  onClick={() => setCloseFundDialogOpen(false)}
                  disabled={closing}
                >
                  Cancel
                </button>
                <button
                  className="px-4 py-2 text-sm text-white bg-yellow-600 hover:bg-yellow-500 rounded transition-colors disabled:opacity-50"
                  onClick={submitCloseFund}
                  disabled={closing}
                >
                  {closing ? 'Closing...' : 'Close Fund'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Add Fund modal (triggered from ExchangeSelector dropdown) */}
        <AddFundModal
          open={addFundDialogOpen}
          onClose={() => setAddFundDialogOpen(false)}
          exchanges={exchanges}
          onCreated={async ({ exchange, pair }) => {
            await fetchExchanges()
            navigate(`/${exchange}/${pair}/config`)
            addToast({
              type: 'success',
              title: `Fund created: ${exchange}/${pair}`,
              message: 'Review the regime config and enable the fund when ready.',
            })
          }}
        />

        {/* Reopen Fund confirmation dialog */}
        {reopenFundDialogOpen && (
          <div
            className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
            onClick={() => !reopening && setReopenFundDialogOpen(false)}
          >
            <div
              className="bg-gray-800 border border-gray-600 rounded-lg p-6 max-w-md mx-4 w-full"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-white text-lg font-medium mb-3">
                Reopen <span className="font-mono text-blue-400">{currentExchange}/{currentPair}</span>?
              </h3>
              <p className="text-gray-300 text-sm mb-2">
                This restores the fund's lifecycle to <span className="text-green-400">active</span> so the
                regime engine can run again.
              </p>
              <p className="text-gray-500 text-xs mb-4">
                Reopening does <strong>not</strong> restart the engine. After confirming, click
                <span className="font-mono text-green-400"> Start </span>
                to resume trading.
              </p>
              <div className="flex justify-end gap-3">
                <button
                  className="px-4 py-2 text-sm text-gray-400 hover:text-white bg-gray-700 hover:bg-gray-600 rounded transition-colors disabled:opacity-50"
                  onClick={() => setReopenFundDialogOpen(false)}
                  disabled={reopening}
                >
                  Cancel
                </button>
                <button
                  className="px-4 py-2 text-sm text-white bg-blue-600 hover:bg-blue-500 rounded transition-colors disabled:opacity-50"
                  onClick={submitReopenFund}
                  disabled={reopening}
                >
                  {reopening ? 'Reopening...' : 'Reopen Fund'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Main Content */}
        <main className="max-w-[95%] xl:max-w-[1400px] 2xl:max-w-[1800px] 3xl:max-w-[2000px] mx-auto px-4 2xl:px-6 py-6">
          {error && (
            <div className="mb-4 p-4 bg-red-900/50 border border-red-700 rounded-lg text-red-200">
              Error: {error}
            </div>
          )}

          {loading && !summary && !isOverview && !isAI && !isUpDown && !isSentinel && !isGateway ? (
            <div className="flex items-center justify-center h-64">
              <div className="text-gray-400">Loading...</div>
            </div>
          ) : (
            <Routes>
              {/* Overview dashboard at root */}
              <Route path="/" element={<Overview />} />

              {/* Pair-based routes - strategy determined from exchange config */}
              <Route path="/:exchange/:pair" element={
                currentStrategy === 'regime'
                  ? <RegimeDashboard exchange={currentExchange} pair={currentPair} />
                  : <Dashboard summary={summary} onRefresh={fetchData} exchange={currentExchange} pair={currentPair} />
              } />
              <Route path="/:exchange/:pair/cost-basis" element={
                currentStrategy === 'regime'
                  ? <CostBasisRegime exchange={currentExchange} pair={currentPair} />
                  : <CostBasisDCA summary={summary} quoteCurrency={getQuoteCurrency(summary?.config?.productId)} />
              } />
              <Route path="/:exchange/:pair/transactions" element={
                currentStrategy === 'regime'
                  ? <TransactionsRegime exchange={currentExchange} pair={currentPair} />
                  : <TransactionsDCA transactions={summary?.transactions} baseCurrency={getBaseCurrency(summary?.config?.productId)} quoteCurrency={getQuoteCurrency(summary?.config?.productId)} />
              } />
              <Route path="/:exchange/:pair/charts" element={
                currentStrategy === 'regime'
                  ? <ChartsRegime exchange={currentExchange} pair={currentPair} />
                  : <ChartsDCA summary={summary} quoteCurrency={getQuoteCurrency(summary?.config?.productId)} />
              } />
              <Route path="/:exchange/:pair/config" element={<ConfigEditor config={summary?.config} onSave={fetchData} exchange={currentExchange} pair={currentPair} strategy={currentStrategy} />} />

              {/* DCA-only routes (backtest, optimizer) */}
              {simpleDcaEnabled && currentStrategy !== 'regime' && <>
              <Route path="/:exchange/:pair/backtest" element={<Backtest summary={summary} exchange={currentExchange} quoteCurrency={getQuoteCurrency(summary?.config?.productId)} />} />
              <Route path="/:exchange/:pair/optimizer" element={<Optimizer exchange={currentExchange} />} />
              </>}

              {/* API Keys - in sub-nav tabs */}
              <Route path="/:exchange/:pair/keys" element={<KeysConfig exchange={currentExchange} onSave={fetchExchanges} />} />

              {/* PM2 Logs - per exchange engine */}
              <Route path="/:exchange/:pair/logs" element={<Suspense fallback={<div className="text-gray-400">Loading...</div>}><LogViewer processName={`critical-mass-${currentExchange}`} /></Suspense>} />

              {/* Notifications - global (not exchange-specific) */}
              <Route path="/notifications" element={<NotificationsConfig />} />

              {/* Backups - global (not exchange-specific) */}
              <Route path="/backups" element={<BackupRestore />} />

              {/* Systems - debug showcase of all celestial body types */}
              <Route path="/systems" element={<Suspense fallback={<div className="text-gray-400">Loading...</div>}><Systems /></Suspense>} />

              {/* AI Provider management */}
              <Route path="/ai" element={<Suspense fallback={<div className="text-gray-400">Loading...</div>}><AIProviders /></Suspense>} />

              {/* UpDown BTC Options dashboard */}
              <Route path="/updown/analysis" element={<Suspense fallback={<div className="text-gray-400">Loading...</div>}><ScorecardAnalysis /></Suspense>} />
              <Route path="/updown" element={<Suspense fallback={<div className="text-gray-400">Loading...</div>}><UpDownDashboard /></Suspense>} />

              {/* Sentinel news monitor */}
              <Route path="/sentinel" element={<Suspense fallback={<div className="text-gray-400">Loading...</div>}><SentinelDashboard /></Suspense>} />

              {/* Gateway logs */}
              <Route path="/gateway/logs" element={<Suspense fallback={<div className="text-gray-400">Loading...</div>}><LogViewer processName="critical-mass" /></Suspense>} />

              {/* Legacy route - redirect /:exchange (without pair) to /:exchange/:pair */}
              <Route path="/:exchange" element={<Navigate to={`/${currentExchange}/${currentPair}`} replace />} />

              {/* Catch invalid routes - redirect to current exchange/pair */}
              <Route path="*" element={<Navigate to={`/${currentExchange}/${currentPair}`} replace />} />
            </Routes>
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
