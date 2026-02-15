import { useState, useEffect } from 'react'

const EXCHANGE_ICONS = {
  coinbase: '₿',
  gemini: '♊',
  cryptocom: '🔷',
}

const EXCHANGE_COLORS = {
  coinbase: 'bg-blue-600',
  gemini: 'bg-cyan-600',
  cryptocom: 'bg-indigo-600',
}

const STRATEGY_CONFIG = {
  dca: {
    icon: '📊',
    label: 'DCA',
    color: 'bg-blue-600',
    textColor: 'text-blue-100',
    description: 'Fixed-interval dollar cost averaging',
  },
  regime: {
    icon: '⚡',
    label: 'Regime',
    color: 'bg-purple-600',
    textColor: 'text-purple-100',
    description: 'Volatility-driven regime engine',
  },
}

// Get status label and color for a strategy variant
const getStrategyStatus = (exchange, strategyType) => {
  const isRegime = strategyType === 'regime'
  const isEnabled = isRegime ? exchange?.regimeEnabled : exchange?.enabled
  const isRunning = isRegime && exchange?.regimeRunning
  const isDry = exchange?.dryRun

  if (isRegime) {
    if (isRunning) {
      return {
        label: isDry ? 'Dry-Run' : 'Running',
        color: isDry ? 'bg-purple-600' : 'bg-green-600',
        textColor: isDry ? 'text-purple-100' : 'text-green-100',
        pulse: true,
      }
    }
    if (isEnabled) {
      return { label: 'Ready', color: 'bg-blue-600', textColor: 'text-blue-100' }
    }
    return { label: 'Off', color: 'bg-gray-600', textColor: 'text-gray-300' }
  }

  // DCA strategy
  if (isEnabled) {
    return {
      label: isDry ? 'Dry-Run' : 'Active',
      color: isDry ? 'bg-yellow-600' : 'bg-green-600',
      textColor: isDry ? 'text-yellow-100' : 'text-green-100',
      pulse: !isDry,
    }
  }
  return { label: 'Off', color: 'bg-gray-600', textColor: 'text-gray-300' }
}

function ExchangeSelector({ currentExchange, currentStrategy, exchanges, onChange, onRefresh, simpleDcaEnabled }) {
  const [isOpen, setIsOpen] = useState(false)

  const handleSelect = (exchangeName, strategy) => {
    onChange(exchangeName, strategy)
    setIsOpen(false)
  }

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (isOpen && !e.target.closest('.exchange-selector')) {
        setIsOpen(false)
      }
    }
    document.addEventListener('click', handleClickOutside)
    return () => document.removeEventListener('click', handleClickOutside)
  }, [isOpen])

  const currentExchangeConfig = exchanges?.find(e => e.name === currentExchange)
  const currentStrategyConfig = STRATEGY_CONFIG[currentStrategy] || STRATEGY_CONFIG.dca
  const currentStatus = getStrategyStatus(currentExchangeConfig, currentStrategy)

  return (
    <div className="exchange-selector relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 md:gap-2 px-2 md:px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors"
      >
        <span className={`w-6 h-6 flex items-center justify-center rounded shrink-0 ${EXCHANGE_COLORS[currentExchange] || 'bg-gray-600'}`}>
          {EXCHANGE_ICONS[currentExchange] || '?'}
        </span>
        <span className="font-medium capitalize hidden md:inline">{currentExchange}</span>
        <span className="text-gray-400 hidden md:inline">/</span>
        <span className={`px-1.5 md:px-2 py-0.5 rounded text-xs shrink-0 ${currentStrategyConfig.color} ${currentStrategyConfig.textColor}`}>
          {currentStrategyConfig.icon} {currentStrategyConfig.label}
        </span>
        <span className={`text-xs px-1.5 md:px-2 py-0.5 rounded shrink-0 ${currentStatus.color} ${currentStatus.textColor} ${currentStatus.pulse ? 'animate-pulse' : ''}`}>
          {currentStatus.label}
        </span>
        <svg className={`w-4 h-4 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-[calc(100vw-2rem)] md:w-80 max-w-80 bg-gray-800 border border-gray-700 rounded-lg shadow-lg z-50">
          <div className="p-2">
            <div className="text-xs text-gray-500 uppercase tracking-wider px-2 py-1">Select Exchange & Strategy</div>

            {exchanges?.map(exchange => (
              <div key={exchange.name} className="mb-2">
                {/* Exchange Header */}
                <div className="flex items-center gap-2 px-3 py-2 text-gray-300">
                  <span className={`w-7 h-7 flex items-center justify-center rounded ${EXCHANGE_COLORS[exchange.name] || 'bg-gray-600'}`}>
                    {EXCHANGE_ICONS[exchange.name] || '?'}
                  </span>
                  <span className="font-medium capitalize">{exchange.name}</span>
                  <span className="text-xs text-gray-500">{exchange.productId || 'Not configured'}</span>
                </div>

                {/* Strategy Options */}
                <div className="pl-4 space-y-1">
                  {['dca', 'regime'].filter(s => s !== 'dca' || simpleDcaEnabled).map(strategyType => {
                    const strategyConfig = STRATEGY_CONFIG[strategyType]
                    const status = getStrategyStatus(exchange, strategyType)
                    const isSelected = exchange.name === currentExchange && strategyType === currentStrategy

                    return (
                      <button
                        key={strategyType}
                        onClick={() => handleSelect(exchange.name, strategyType)}
                        className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${
                          isSelected
                            ? 'bg-blue-600/20 text-blue-300 border border-blue-500/50'
                            : 'hover:bg-gray-700 text-gray-300'
                        }`}
                      >
                        <span className="text-lg">{strategyConfig.icon}</span>
                        <div className="flex-1 text-left">
                          <div className="text-sm font-medium">{strategyConfig.label}</div>
                          <div className="text-xs text-gray-500">{strategyConfig.description}</div>
                        </div>
                        <span className={`text-xs px-2 py-0.5 rounded ${status.color}/50 ${status.textColor.replace('100', '200')} ${status.pulse ? 'animate-pulse' : ''}`}>
                          {status.label}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="border-t border-gray-700 p-2">
            <button
              onClick={() => {
                setIsOpen(false)
                onRefresh?.()
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Refresh Exchanges
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default ExchangeSelector
