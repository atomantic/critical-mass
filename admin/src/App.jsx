import { useState, useEffect, createContext, useContext } from 'react'
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
import ExchangeSelector from './components/ExchangeSelector'
import KeysConfig from './components/KeysConfig'
import RegimeDashboard from './components/RegimeDashboard'
import { ToastProvider, useToast, tradeEventToToast } from './components/Toast'
import { useTradeEvents } from './hooks/useTradeEvents'

// Extract quote currency from product ID (e.g., "BTC-USDC" -> "USDC", "BTCUSD" -> "USD")
export function getQuoteCurrency(productId) {
  if (!productId) return 'USDC'
  if (productId.includes('-')) {
    return productId.split('-')[1]
  }
  // For Gemini-style (BTCUSD), strip BTC prefix
  return productId.replace(/^BTC/, '') || 'USD'
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
    ...commonTabs.slice(4), // Config
  ]
}

// Valid exchange names and strategies
const VALID_EXCHANGES = ['coinbase', 'gemini']
const VALID_STRATEGIES = ['dca', 'regime']

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

  // Extract exchange and strategy from URL path (e.g., /coinbase/regime/config -> coinbase, regime)
  const pathParts = location.pathname.split('/').filter(Boolean)
  const urlExchange = VALID_EXCHANGES.includes(pathParts[0]) ? pathParts[0] : null
  const urlStrategy = VALID_STRATEGIES.includes(pathParts[1]) ? pathParts[1] : null

  const [currentExchange, setCurrentExchange] = useState(urlExchange || 'coinbase')
  const [currentStrategy, setCurrentStrategy] = useState(urlStrategy || 'dca')
  const [exchanges, setExchanges] = useState([])
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Get tabs based on current strategy
  const tabs = getTabsForStrategy(currentStrategy)

  // Fetch list of configured exchanges
  const fetchExchanges = async (autoSelect = false) => {
    const res = await fetch('/api/exchanges')
    if (res.ok) {
      const data = await res.json()
      setExchanges(data.exchanges || [])
      // Only auto-select exchange on initial load if not already in URL
      if (autoSelect && !urlExchange) {
        const enabled = data.exchanges?.find(e => e.enabled || e.regimeEnabled)
        const first = data.exchanges?.[0]
        const targetExchange = enabled?.name || first?.name || 'coinbase'
        // Determine strategy based on exchange config
        const exchangeConfig = enabled || first
        const targetStrategy = exchangeConfig?.strategy === 'regime' ? 'regime' : 'dca'
        setCurrentExchange(targetExchange)
        setCurrentStrategy(targetStrategy)
        navigate(`/${targetExchange}/${targetStrategy}`, { replace: true })
      } else if (autoSelect && urlExchange && !urlStrategy) {
        // URL has exchange but no strategy - redirect to strategy path
        const exchangeConfig = data.exchanges?.find(e => e.name === urlExchange)
        const targetStrategy = exchangeConfig?.strategy === 'regime' ? 'regime' : 'dca'
        setCurrentExchange(urlExchange)
        setCurrentStrategy(targetStrategy)
        navigate(`/${urlExchange}/${targetStrategy}`, { replace: true })
      } else if (autoSelect && urlExchange && urlStrategy) {
        // URL already has exchange and strategy
        setCurrentExchange(urlExchange)
        setCurrentStrategy(urlStrategy)
      }
    }
  }

  // Handle exchange/strategy change from selector - update URL
  const handleExchangeStrategyChange = (newExchange, newStrategy) => {
    setCurrentExchange(newExchange)
    setCurrentStrategy(newStrategy)
    // Navigate to new exchange/strategy, preserving current tab if valid
    const currentTab = pathParts[2] || ''
    const newTabs = getTabsForStrategy(newStrategy)
    const tabValid = currentTab === '' || newTabs.some(t => t.path === `/${currentTab}`)
    navigate(`/${newExchange}/${newStrategy}${tabValid && currentTab ? `/${currentTab}` : ''}`)
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

  // Initial load of exchanges (with auto-select on first load)
  useEffect(() => {
    fetchExchanges(true)
  }, [])

  // Sync exchange and strategy from URL when they change
  useEffect(() => {
    if (urlExchange && urlExchange !== currentExchange) {
      setCurrentExchange(urlExchange)
    }
    if (urlStrategy && urlStrategy !== currentStrategy) {
      setCurrentStrategy(urlStrategy)
    }
  }, [urlExchange, urlStrategy])

  // Fetch data when exchange changes
  useEffect(() => {
    if (currentExchange) {
      fetchData()
      // Set up auto-refresh
      const interval = setInterval(fetchData, 30000)
      return () => clearInterval(interval)
    }
  }, [currentExchange])

  // Get the current sub-path (tab) without the exchange/strategy prefix
  const getSubPath = () => {
    if (!urlExchange || !urlStrategy) return location.pathname
    return location.pathname.replace(`/${urlExchange}/${urlStrategy}`, '') || ''
  }

  const isActiveTab = (tabPath) => {
    const subPath = getSubPath()
    if (tabPath === '') return subPath === '' || subPath === '/'
    return subPath.startsWith(tabPath)
  }

  // Build full path with exchange and strategy prefix
  const buildPath = (tabPath) => `/${currentExchange}/${currentStrategy}${tabPath}`

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
          <div className="max-w-7xl 2xl:max-w-[1600px] 3xl:max-w-[1800px] mx-auto px-4 2xl:px-6 py-4">
            <div className="flex items-center justify-between">
              <Link to={buildPath('')} className="text-2xl font-bold text-white hover:text-gray-200">
                DCA Trading Bot
              </Link>
              <div className="flex items-center gap-4">
                <Link
                  to={`/${currentExchange}/keys`}
                  className="px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
                >
                  API Keys
                </Link>
                <ExchangeSelector
                  currentExchange={currentExchange}
                  currentStrategy={currentStrategy}
                  exchanges={exchanges}
                  onChange={handleExchangeStrategyChange}
                  onRefresh={fetchExchanges}
                />
              </div>
            </div>
          </div>
        </header>

        {/* Navigation */}
        <nav className="bg-gray-800 border-b border-gray-700">
          <div className="max-w-7xl 2xl:max-w-[1600px] 3xl:max-w-[1800px] mx-auto px-4 2xl:px-6">
            <div className="flex gap-1">
              {tabs.map(tab => (
                <Link
                  key={tab.path}
                  to={buildPath(tab.path)}
                  className={`px-4 py-3 text-sm font-medium transition-colors ${
                    isActiveTab(tab.path)
                      ? 'text-white border-b-2 border-blue-500'
                      : 'text-gray-400 hover:text-white'
                  }`}
                >
                  {tab.name}
                </Link>
              ))}
            </div>
          </div>
        </nav>

        {/* Main Content */}
        <main className="max-w-7xl 2xl:max-w-[1600px] 3xl:max-w-[1800px] mx-auto px-4 2xl:px-6 py-6">
          {error && (
            <div className="mb-4 p-4 bg-red-900/50 border border-red-700 rounded-lg text-red-200">
              Error: {error}
            </div>
          )}

          {loading && !summary ? (
            <div className="flex items-center justify-center h-64">
              <div className="text-gray-400">Loading...</div>
            </div>
          ) : (
            <Routes>
              {/* Redirect root to default exchange/strategy */}
              <Route path="/" element={<Navigate to={`/${currentExchange}/${currentStrategy}`} replace />} />

              {/* DCA strategy routes */}
              <Route path="/:exchange/dca" element={<Dashboard summary={summary} onRefresh={fetchData} exchange={currentExchange} />} />
              <Route path="/:exchange/dca/cost-basis" element={<CostBasisDCA summary={summary} quoteCurrency={getQuoteCurrency(summary?.config?.productId)} />} />
              <Route path="/:exchange/dca/transactions" element={<TransactionsDCA transactions={summary?.transactions} quoteCurrency={getQuoteCurrency(summary?.config?.productId)} />} />
              <Route path="/:exchange/dca/charts" element={<ChartsDCA summary={summary} quoteCurrency={getQuoteCurrency(summary?.config?.productId)} />} />
              <Route path="/:exchange/dca/backtest" element={<Backtest summary={summary} exchange={currentExchange} quoteCurrency={getQuoteCurrency(summary?.config?.productId)} />} />
              <Route path="/:exchange/dca/optimizer" element={<Optimizer exchange={currentExchange} />} />
              <Route path="/:exchange/dca/config" element={<ConfigEditor config={summary?.config} onSave={fetchData} exchange={currentExchange} strategy="dca" />} />

              {/* Regime strategy routes */}
              <Route path="/:exchange/regime" element={<RegimeDashboard exchange={currentExchange} />} />
              <Route path="/:exchange/regime/cost-basis" element={<CostBasisRegime exchange={currentExchange} />} />
              <Route path="/:exchange/regime/transactions" element={<TransactionsRegime exchange={currentExchange} />} />
              <Route path="/:exchange/regime/charts" element={<ChartsRegime exchange={currentExchange} />} />
              <Route path="/:exchange/regime/config" element={<ConfigEditor config={summary?.config} onSave={fetchData} exchange={currentExchange} strategy="regime" />} />

              {/* API Keys - shared per exchange (not strategy-specific) */}
              <Route path="/:exchange/keys" element={<KeysConfig exchange={currentExchange} onSave={fetchExchanges} />} />

              {/* Legacy route - redirect old /:exchange (without strategy) to new /:exchange/:strategy */}
              <Route path="/:exchange" element={<Navigate to={`/${currentExchange}/${currentStrategy}`} replace />} />

              {/* Catch invalid routes - redirect to current exchange/strategy */}
              <Route path="*" element={<Navigate to={`/${currentExchange}/${currentStrategy}`} replace />} />
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
