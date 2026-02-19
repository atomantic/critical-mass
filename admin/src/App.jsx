import { useState, useEffect, createContext, useContext, lazy, Suspense } from 'react'
import { Routes, Route, Link, useLocation, useNavigate, useParams, Navigate } from 'react-router-dom'
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
import KeysConfig from './components/KeysConfig'
import NotificationsConfig from './components/NotificationsConfig'
import BackupRestore from './components/BackupRestore'
import RegimeDashboard from './components/RegimeDashboard'
const Systems = lazy(() => import('./components/Systems'))
const KalshiDashboard = lazy(() => import('./components/kalshi/Dashboard'))
const KalshiConfig = lazy(() => import('./components/kalshi/Config'))
const KalshiGeneralConfig = lazy(() => import('./components/kalshi/GeneralConfig'))
const KalshiKeysConfig = lazy(() => import('./components/kalshi/KeysConfig'))
const KalshiRiskConfig = lazy(() => import('./components/kalshi/RiskConfig'))
const KalshiStrategiesConfig = lazy(() => import('./components/kalshi/StrategiesConfig'))
const KalshiMarketDetail = lazy(() => import('./components/kalshi/MarketDetail'))
const KalshiPositions = lazy(() => import('./components/kalshi/Positions'))
const AIProviders = lazy(() => import('./components/ai/Providers'))
const HedgeDashboard = lazy(() => import('./components/hedge/Dashboard'))
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

// Exchange context for sharing current exchange and strategy across components
export const ExchangeContext = createContext({
  exchange: 'coinbase',
  strategy: 'dca',
  setExchange: () => {},
  setStrategy: () => {},
  exchanges: [],
})

export const useExchange = () => useContext(ExchangeContext)

// Strategy-aware tab configuration
const getTabsForStrategy = (strategy) => {
  const commonTabs = [
    { name: 'Dashboard', path: '' },
    { name: 'Cost Basis', path: '/cost-basis' },
    { name: 'Transactions', path: '/transactions' },
    { name: 'Charts', path: '/charts' },
    { name: 'Config', path: '/config' },
    { name: 'API Keys', path: '/keys' },
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

  // Extract exchange and pair from URL path (e.g., /coinbase/BTC-USDC/config -> coinbase, BTC-USDC)
  const pathParts = location.pathname.split('/').filter(Boolean)
  const urlExchange = VALID_EXCHANGES.includes(pathParts[0]) ? pathParts[0] : null
  const urlPair = urlExchange && pathParts[1] ? pathParts[1] : null

  const [currentExchange, setCurrentExchange] = useState(urlExchange || 'coinbase')
  const [currentStrategy, setCurrentStrategy] = useState('regime')
  const [exchanges, setExchanges] = useState([])
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [regimeRunning, setRegimeRunning] = useState(false)
  const [regimeDryRun, setRegimeDryRun] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [starting, setStarting] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [simpleDcaEnabled, setSimpleDcaEnabled] = useState(false)

  // WebSocket connection for regime strategy
  const { connected: wsConnected } = useRegimeEvents(currentStrategy === 'regime' ? currentExchange : null)

  // Derive current pair from exchange config or URL
  const currentPair = exchanges?.find(e => e.name === currentExchange)?.productId || urlPair || 'BTC-USDC'

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
        const targetStrategy = exchangeConfig?.strategy === 'regime' ? 'regime' : 'dca'
        const targetPair = exchangeConfig?.productId || 'BTC-USDC'
        setCurrentExchange(targetExchange)
        setCurrentStrategy(targetStrategy)
        // Don't redirect away from non-exchange pages (overview, kalshi, notifications, etc.)
        const nonExchangePaths = ['/', '/kalshi', '/hedge', '/notifications', '/backups', '/systems', '/ai']
        const isNonExchangePage = nonExchangePaths.some(p => location.pathname === p || location.pathname.startsWith(p + '/'))
        if (!isNonExchangePage) {
          navigate(`/${targetExchange}/${targetPair}`, { replace: true })
        }
      } else if (autoSelect && urlExchange && !urlPair) {
        // URL has exchange but no pair - redirect to pair path
        const exchangeConfig = data.exchanges?.find(e => e.name === urlExchange)
        const targetStrategy = exchangeConfig?.strategy === 'regime' ? 'regime' : 'dca'
        const targetPair = exchangeConfig?.productId || 'BTC-USDC'
        setCurrentExchange(urlExchange)
        setCurrentStrategy(targetStrategy)
        navigate(`/${urlExchange}/${targetPair}`, { replace: true })
      } else if (autoSelect && urlExchange && urlPair) {
        // URL already has exchange and pair - derive strategy from config
        setCurrentExchange(urlExchange)
        const exchangeConfig = data.exchanges?.find(e => e.name === urlExchange)
        const targetStrategy = exchangeConfig?.strategy === 'regime' ? 'regime' : 'dca'
        setCurrentStrategy(targetStrategy)
      }
    }
  }

  // Handle exchange change from selector - update URL with pair
  const handleExchangeChange = (newExchange, newPair) => {
    const exchangeConfig = exchanges?.find(e => e.name === newExchange)
    const newStrategy = exchangeConfig?.strategy === 'regime' ? 'regime' : 'dca'
    setCurrentExchange(newExchange)
    setCurrentStrategy(newStrategy)
    // Navigate to new exchange/pair, preserving current tab if valid
    const currentTab = pathParts[2] || ''
    const newTabs = getTabsForStrategy(newStrategy)
    const tabValid = currentTab === '' || newTabs.some(t => t.path === `/${currentTab}`)
    navigate(`/${newExchange}/${newPair}${tabValid && currentTab ? `/${currentTab}` : ''}`)
  }

  const fetchData = async () => {
    setLoading(true)
    setError(null)
    const res = await fetch(`/api/${currentExchange}/summary`)
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
    const res = await fetch(`/api/${currentExchange}/regime/status`)
    if (res.ok) {
      const data = await res.json()
      setRegimeRunning(data.status?.isRunning || false)
      setRegimeDryRun(data.status?.isDryRun || false)
    }
  }

  // Start regime engine
  const handleStartRegime = async () => {
    setStarting(true)
    const res = await fetch(`/api/${currentExchange}/regime/start`, { method: 'POST' })
    if (res.ok) {
      setRegimeRunning(true)
      fetchRegimeStatus()
    }
    setStarting(false)
  }

  // Stop regime engine
  const handleStopRegime = async () => {
    setStopping(true)
    const res = await fetch(`/api/${currentExchange}/regime/stop`, { method: 'POST' })
    if (res.ok) {
      setRegimeRunning(false)
    }
    setStopping(false)
  }

  // Reset dry-run state
  const handleResetDryRun = async () => {
    setResetting(true)
    await fetch(`/api/${currentExchange}/regime/dry-run/reset`, { method: 'POST' })
    setResetting(false)
  }

  // Initial load of exchanges (with auto-select on first load)
  useEffect(() => {
    fetchExchanges(true)
  }, [])

  // Sync exchange from URL when it changes, derive strategy from config
  useEffect(() => {
    if (urlExchange && urlExchange !== currentExchange) {
      setCurrentExchange(urlExchange)
      const exchangeConfig = exchanges?.find(e => e.name === urlExchange)
      if (exchangeConfig) {
        setCurrentStrategy(exchangeConfig.strategy === 'regime' ? 'regime' : 'dca')
      }
    }
  }, [urlExchange, urlPair])

  // Auto-redirect away from DCA when simpleDcaEnabled is false (only on exchange pages)
  useEffect(() => {
    if (!simpleDcaEnabled && currentStrategy === 'dca' && urlExchange) {
      setCurrentStrategy('regime')
      navigate(`/${currentExchange}/${currentPair}`, { replace: true })
    }
  }, [simpleDcaEnabled, currentStrategy, currentExchange, currentPair, urlExchange])

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

  // Check if on Kalshi pages (independent of exchange-based routing)
  const isKalshi = location.pathname.startsWith('/kalshi')

  // Check if on AI pages
  const isAI = location.pathname.startsWith('/ai')

  // Check if on Hedge pages
  const isHedge = location.pathname.startsWith('/hedge')

  // Build full path with exchange and pair prefix
  const buildPath = (tabPath) => `/${currentExchange}/${currentPair}${tabPath}`

  return (
    <ExchangeContext.Provider value={{
      exchange: currentExchange,
      strategy: currentStrategy,
      setExchange: setCurrentExchange,
      setStrategy: setCurrentStrategy,
      exchanges
    }}>
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
                  to="/kalshi"
                  className="hidden md:block px-2 lg:px-3 py-1.5 text-xs lg:text-sm text-gray-400 hover:text-white transition-colors whitespace-nowrap"
                >
                  Kalshi
                </Link>
                <Link
                  to="/hedge"
                  className="hidden md:block px-2 lg:px-3 py-1.5 text-xs lg:text-sm text-gray-400 hover:text-white transition-colors whitespace-nowrap"
                >
                  Hedge
                </Link>
                <Link
                  to="/ai"
                  className="hidden md:block px-2 lg:px-3 py-1.5 text-xs lg:text-sm text-gray-400 hover:text-white transition-colors whitespace-nowrap"
                >
                  AI
                </Link>
              </div>
            </div>

            {/* Mobile menu dropdown */}
            {mobileMenuOpen && (
              <div className="md:hidden mt-2 pt-2 border-t border-gray-700 flex flex-col gap-1">
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
                  to="/kalshi"
                  onClick={() => setMobileMenuOpen(false)}
                  className="px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
                >
                  Kalshi
                </Link>
                <Link
                  to="/hedge"
                  onClick={() => setMobileMenuOpen(false)}
                  className="px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
                >
                  Hedge
                </Link>
                <Link
                  to="/ai"
                  onClick={() => setMobileMenuOpen(false)}
                  className="px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
                >
                  AI Providers
                </Link>
              </div>
            )}
          </div>
        </header>

        {/* Exchange sub-nav (hidden on overview, Kalshi, and AI pages) */}
        {!isOverview && !isKalshi && !isAI && !isHedge && (
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
                    exchanges={exchanges}
                    onChange={handleExchangeChange}
                    onRefresh={fetchExchanges}
                  />
                {currentStrategy === 'regime' && (<>

                    {regimeDryRun && (
                      <span className="px-1.5 md:px-2 py-0.5 md:py-1 bg-purple-900/50 border border-purple-500 text-purple-400 text-[10px] md:text-xs font-medium rounded">
                        DRY-RUN
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
                        <button
                          onClick={handleStopRegime}
                          disabled={stopping}
                          className="px-2 md:px-3 py-1 md:py-1.5 bg-red-600 hover:bg-red-700 disabled:bg-red-800 rounded text-xs md:text-sm font-medium transition-colors"
                        >
                          {stopping ? '...' : 'Stop'}
                        </button>
                      </>
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

        {/* Kalshi sub-nav (shown on /kalshi/* pages) */}
        {isKalshi && (
          <nav className="bg-gray-800 border-b border-gray-700 overflow-x-auto">
            <div className="max-w-[95%] xl:max-w-[1400px] 2xl:max-w-[1800px] 3xl:max-w-[2000px] mx-auto px-4 2xl:px-6">
              <div className="flex gap-1 min-w-max">
                <Link
                  to="/kalshi"
                  className={`px-3 sm:px-4 py-2.5 sm:py-3 text-xs sm:text-sm font-medium transition-colors whitespace-nowrap ${
                    location.pathname === '/kalshi'
                      ? 'text-white border-b-2 border-blue-500'
                      : 'text-gray-400 hover:text-white'
                  }`}
                >
                  Dashboard
                </Link>
                <Link
                  to="/kalshi/positions"
                  className={`px-3 sm:px-4 py-2.5 sm:py-3 text-xs sm:text-sm font-medium transition-colors whitespace-nowrap ${
                    location.pathname.startsWith('/kalshi/positions')
                      ? 'text-white border-b-2 border-blue-500'
                      : 'text-gray-400 hover:text-white'
                  }`}
                >
                  Positions
                </Link>
                <Link
                  to="/kalshi/config"
                  className={`px-3 sm:px-4 py-2.5 sm:py-3 text-xs sm:text-sm font-medium transition-colors whitespace-nowrap ${
                    location.pathname.startsWith('/kalshi/config')
                      ? 'text-white border-b-2 border-blue-500'
                      : 'text-gray-400 hover:text-white'
                  }`}
                >
                  Config
                </Link>
              </div>
            </div>
          </nav>
        )}

        {/* Hedge sub-nav (shown on /hedge/* pages) */}
        {isHedge && (
          <nav className="bg-gray-800 border-b border-gray-700 overflow-x-auto">
            <div className="max-w-[95%] xl:max-w-[1400px] 2xl:max-w-[1800px] 3xl:max-w-[2000px] mx-auto px-4 2xl:px-6">
              <div className="flex gap-1 min-w-max">
                <Link
                  to="/hedge"
                  className={`px-3 sm:px-4 py-2.5 sm:py-3 text-xs sm:text-sm font-medium transition-colors whitespace-nowrap ${
                    location.pathname === '/hedge'
                      ? 'text-white border-b-2 border-blue-500'
                      : 'text-gray-400 hover:text-white'
                  }`}
                >
                  Dashboard
                </Link>
              </div>
            </div>
          </nav>
        )}

        {/* Main Content */}
        <main className="max-w-[95%] xl:max-w-[1400px] 2xl:max-w-[1800px] 3xl:max-w-[2000px] mx-auto px-4 2xl:px-6 py-6">
          {error && (
            <div className="mb-4 p-4 bg-red-900/50 border border-red-700 rounded-lg text-red-200">
              Error: {error}
            </div>
          )}

          {loading && !summary && !isOverview && !isKalshi && !isAI && !isHedge ? (
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
                  ? <RegimeDashboard exchange={currentExchange} />
                  : <Dashboard summary={summary} onRefresh={fetchData} exchange={currentExchange} />
              } />
              <Route path="/:exchange/:pair/cost-basis" element={
                currentStrategy === 'regime'
                  ? <CostBasisRegime exchange={currentExchange} />
                  : <CostBasisDCA summary={summary} quoteCurrency={getQuoteCurrency(summary?.config?.productId)} />
              } />
              <Route path="/:exchange/:pair/transactions" element={
                currentStrategy === 'regime'
                  ? <TransactionsRegime exchange={currentExchange} />
                  : <TransactionsDCA transactions={summary?.transactions} baseCurrency={getBaseCurrency(summary?.config?.productId)} quoteCurrency={getQuoteCurrency(summary?.config?.productId)} />
              } />
              <Route path="/:exchange/:pair/charts" element={
                currentStrategy === 'regime'
                  ? <ChartsRegime exchange={currentExchange} />
                  : <ChartsDCA summary={summary} quoteCurrency={getQuoteCurrency(summary?.config?.productId)} />
              } />
              <Route path="/:exchange/:pair/config" element={<ConfigEditor config={summary?.config} onSave={fetchData} exchange={currentExchange} strategy={currentStrategy} />} />

              {/* DCA-only routes (backtest, optimizer) */}
              {simpleDcaEnabled && currentStrategy !== 'regime' && <>
              <Route path="/:exchange/:pair/backtest" element={<Backtest summary={summary} exchange={currentExchange} quoteCurrency={getQuoteCurrency(summary?.config?.productId)} />} />
              <Route path="/:exchange/:pair/optimizer" element={<Optimizer exchange={currentExchange} />} />
              </>}

              {/* API Keys - in sub-nav tabs */}
              <Route path="/:exchange/:pair/keys" element={<KeysConfig exchange={currentExchange} onSave={fetchExchanges} />} />

              {/* Notifications - global (not exchange-specific) */}
              <Route path="/notifications" element={<NotificationsConfig />} />

              {/* Backups - global (not exchange-specific) */}
              <Route path="/backups" element={<BackupRestore />} />

              {/* Systems - debug showcase of all celestial body types */}
              <Route path="/systems" element={<Suspense fallback={<div className="text-gray-400">Loading...</div>}><Systems /></Suspense>} />

              {/* Kalshi prediction market routes */}
              <Route path="/kalshi" element={<Suspense fallback={<div className="text-gray-400">Loading...</div>}><KalshiDashboard /></Suspense>} />
              <Route path="/kalshi/markets/:ticker" element={<Suspense fallback={<div className="text-gray-400">Loading...</div>}><KalshiMarketDetail /></Suspense>} />
              <Route path="/kalshi/positions" element={<Suspense fallback={<div className="text-gray-400">Loading...</div>}><KalshiPositions /></Suspense>} />
              <Route path="/kalshi/config" element={<Suspense fallback={<div className="text-gray-400">Loading...</div>}><KalshiConfig /></Suspense>}>
                <Route index element={<Suspense fallback={<div className="text-gray-400">Loading...</div>}><KalshiGeneralConfig /></Suspense>} />
                <Route path="general" element={<Suspense fallback={<div className="text-gray-400">Loading...</div>}><KalshiGeneralConfig /></Suspense>} />
                <Route path="keys" element={<Suspense fallback={<div className="text-gray-400">Loading...</div>}><KalshiKeysConfig /></Suspense>} />
                <Route path="risk" element={<Suspense fallback={<div className="text-gray-400">Loading...</div>}><KalshiRiskConfig /></Suspense>} />
                <Route path="strategies" element={<Suspense fallback={<div className="text-gray-400">Loading...</div>}><KalshiStrategiesConfig /></Suspense>} />
              </Route>

              {/* AI Provider management */}
              <Route path="/ai" element={<Suspense fallback={<div className="text-gray-400">Loading...</div>}><AIProviders /></Suspense>} />

              {/* Hedge engine dashboard */}
              <Route path="/hedge" element={<Suspense fallback={<div className="text-gray-400">Loading...</div>}><HedgeDashboard /></Suspense>} />

              {/* Legacy route - redirect /:exchange (without pair) to /:exchange/:pair */}
              <Route path="/:exchange" element={<Navigate to={`/${currentExchange}/${currentPair}`} replace />} />

              {/* Catch invalid routes - redirect to current exchange/pair */}
              <Route path="*" element={<Navigate to={`/${currentExchange}/${currentPair}`} replace />} />
            </Routes>
          )}
        </main>
      </div>
    </ExchangeContext.Provider>
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
