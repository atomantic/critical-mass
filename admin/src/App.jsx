import { useState, useEffect, createContext, useContext } from 'react'
import { Routes, Route, Link, useLocation, useNavigate, useParams, Navigate } from 'react-router-dom'
import Dashboard from './components/Dashboard'
import ConfigEditor from './components/ConfigEditor'
import Transactions from './components/Transactions'
import Charts from './components/Charts'
import CostBasis from './components/CostBasis'
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

// Exchange context for sharing current exchange across components
export const ExchangeContext = createContext({
  exchange: 'coinbase',
  setExchange: () => {},
  exchanges: [],
})

export const useExchange = () => useContext(ExchangeContext)

const tabs = [
  { name: 'Dashboard', path: '' },
  { name: 'Cost Basis', path: '/cost-basis' },
  { name: 'Transactions', path: '/transactions' },
  { name: 'Charts', path: '/charts' },
  { name: 'Backtest', path: '/backtest' },
  { name: 'Optimizer', path: '/optimizer' },
  { name: 'Regime', path: '/regime', highlight: true },
  { name: 'Config', path: '/config' },
  { name: 'API Keys', path: '/keys' },
]

// Valid exchange names
const VALID_EXCHANGES = ['coinbase', 'gemini']

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

  // Extract exchange from URL path (e.g., /coinbase/config -> coinbase)
  const pathParts = location.pathname.split('/').filter(Boolean)
  const urlExchange = VALID_EXCHANGES.includes(pathParts[0]) ? pathParts[0] : null

  const [currentExchange, setCurrentExchange] = useState(urlExchange || 'coinbase')
  const [exchanges, setExchanges] = useState([])
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Fetch list of configured exchanges
  const fetchExchanges = async (autoSelect = false) => {
    const res = await fetch('/api/exchanges')
    if (res.ok) {
      const data = await res.json()
      setExchanges(data.exchanges || [])
      // Only auto-select exchange on initial load if not already in URL
      if (autoSelect && !urlExchange) {
        const enabled = data.exchanges?.find(e => e.enabled)
        const first = data.exchanges?.[0]
        const targetExchange = enabled?.name || first?.name || 'coinbase'
        setCurrentExchange(targetExchange)
        navigate(`/${targetExchange}`, { replace: true })
      } else if (autoSelect && urlExchange) {
        // URL already has exchange, just use it
        setCurrentExchange(urlExchange)
      }
    }
  }

  // Handle exchange change - update URL
  const handleExchangeChange = (newExchange) => {
    setCurrentExchange(newExchange)
    // Get current sub-path (everything after exchange)
    const subPath = urlExchange ? location.pathname.replace(`/${urlExchange}`, '') : location.pathname
    navigate(`/${newExchange}${subPath || ''}`)
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

  // Sync exchange from URL when it changes
  useEffect(() => {
    if (urlExchange && urlExchange !== currentExchange) {
      setCurrentExchange(urlExchange)
    }
  }, [urlExchange])

  // Fetch data when exchange changes
  useEffect(() => {
    if (currentExchange) {
      fetchData()
      // Set up auto-refresh
      const interval = setInterval(fetchData, 30000)
      return () => clearInterval(interval)
    }
  }, [currentExchange])

  // Get the current sub-path (tab) without the exchange prefix
  const getSubPath = () => {
    if (!urlExchange) return location.pathname
    return location.pathname.replace(`/${urlExchange}`, '') || ''
  }

  const isActiveTab = (tabPath) => {
    const subPath = getSubPath()
    if (tabPath === '') return subPath === '' || subPath === '/'
    return subPath.startsWith(tabPath)
  }

  // Build full path with exchange prefix
  const buildPath = (tabPath) => `/${currentExchange}${tabPath}`

  return (
    <ExchangeContext.Provider value={{ exchange: currentExchange, setExchange: setCurrentExchange, exchanges }}>
      <div className="min-h-screen">
        {/* Header */}
        <header className="bg-gray-800 border-b border-gray-700">
          <div className="max-w-7xl 2xl:max-w-[1600px] 3xl:max-w-[1800px] mx-auto px-4 2xl:px-6 py-4">
            <div className="flex items-center justify-between">
              <Link to={buildPath('')} className="text-2xl font-bold text-white hover:text-gray-200">
                DCA Trading Bot
              </Link>
              <div className="flex items-center gap-4">
                <ExchangeSelector
                  currentExchange={currentExchange}
                  exchanges={exchanges}
                  onChange={handleExchangeChange}
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
                      : tab.highlight
                        ? 'text-purple-400 hover:text-purple-300'
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
              {/* Redirect root to default exchange */}
              <Route path="/" element={<Navigate to={`/${currentExchange}`} replace />} />

              {/* Exchange-prefixed routes */}
              <Route path="/:exchange" element={<Dashboard summary={summary} onRefresh={fetchData} exchange={currentExchange} />} />
              <Route path="/:exchange/cost-basis" element={<CostBasis summary={summary} quoteCurrency={getQuoteCurrency(summary?.config?.productId)} />} />
              <Route path="/:exchange/transactions" element={<Transactions transactions={summary?.transactions} quoteCurrency={getQuoteCurrency(summary?.config?.productId)} />} />
              <Route path="/:exchange/charts" element={<Charts summary={summary} quoteCurrency={getQuoteCurrency(summary?.config?.productId)} />} />
              <Route path="/:exchange/backtest" element={<Backtest summary={summary} exchange={currentExchange} quoteCurrency={getQuoteCurrency(summary?.config?.productId)} />} />
              <Route path="/:exchange/optimizer" element={<Optimizer exchange={currentExchange} />} />
              <Route path="/:exchange/regime" element={<RegimeDashboard exchange={currentExchange} />} />
              <Route path="/:exchange/config" element={<ConfigEditor config={summary?.config} onSave={fetchData} exchange={currentExchange} />} />
              <Route path="/:exchange/keys" element={<KeysConfig exchange={currentExchange} onSave={fetchExchanges} />} />

              {/* Catch invalid routes - redirect to current exchange */}
              <Route path="*" element={<Navigate to={`/${currentExchange}`} replace />} />
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
