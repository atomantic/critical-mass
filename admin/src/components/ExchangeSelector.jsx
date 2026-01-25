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

function ExchangeSelector({ currentExchange, exchanges, onChange, onRefresh }) {
  const [isOpen, setIsOpen] = useState(false)

  const handleSelect = (exchange) => {
    onChange(exchange)
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

  return (
    <div className="exchange-selector relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors"
      >
        <span className={`w-6 h-6 flex items-center justify-center rounded ${EXCHANGE_COLORS[currentExchange] || 'bg-gray-600'}`}>
          {EXCHANGE_ICONS[currentExchange] || '?'}
        </span>
        <span className="font-medium capitalize">{currentExchange}</span>
        <span className={`text-xs px-2 py-0.5 rounded ${
          currentExchangeConfig?.enabled
            ? currentExchangeConfig?.dryRun
              ? 'bg-yellow-600 text-yellow-100'
              : 'bg-green-600 text-green-100'
            : 'bg-red-600 text-red-100'
        }`}>
          {!currentExchangeConfig?.enabled ? 'Off' : currentExchangeConfig?.dryRun ? 'Dry' : 'Live'}
        </span>
        <svg className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-64 bg-gray-800 border border-gray-700 rounded-lg shadow-lg z-50">
          <div className="p-2">
            <div className="text-xs text-gray-500 uppercase tracking-wider px-2 py-1">Select Exchange</div>
            {exchanges?.map(exchange => (
              <button
                key={exchange.name}
                onClick={() => handleSelect(exchange.name)}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${
                  exchange.name === currentExchange
                    ? 'bg-blue-600/20 text-blue-300'
                    : 'hover:bg-gray-700 text-gray-300'
                }`}
              >
                <span className={`w-8 h-8 flex items-center justify-center rounded ${EXCHANGE_COLORS[exchange.name] || 'bg-gray-600'}`}>
                  {EXCHANGE_ICONS[exchange.name] || '?'}
                </span>
                <div className="flex-1 text-left">
                  <div className="font-medium capitalize">{exchange.name}</div>
                  <div className="text-xs text-gray-500">{exchange.productId || 'Not configured'}</div>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded ${
                  exchange.enabled
                    ? exchange.dryRun
                      ? 'bg-yellow-600/50 text-yellow-200'
                      : 'bg-green-600/50 text-green-200'
                    : 'bg-gray-600 text-gray-400'
                }`}>
                  {!exchange.enabled ? 'Disabled' : exchange.dryRun ? 'Dry Run' : 'Live'}
                </span>
              </button>
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
