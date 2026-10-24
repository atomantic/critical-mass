import Button from './ui/Button'
import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { EXCHANGE_ICONS, EXCHANGE_COLORS } from './exchangeStyles'

// Get engine status for an exchange
const getEngineStatus = (exchange) => {
  // Lifecycle takes precedence over running/ready state.
  if (exchange?.lifecycle === 'draining') {
    return {
      label: 'Draining',
      color: 'bg-yellow-600',
      textColor: 'text-yellow-100',
      pulse: true,
    }
  }
  if (exchange?.lifecycle === 'closed') {
    return {
      label: 'Closed',
      color: 'bg-red-700',
      textColor: 'text-red-100',
    }
  }

  const isRunning = exchange?.regimeRunning
  const isDry = exchange?.dryRun

  if (isRunning) {
    return {
      label: isDry ? 'Dry-Run' : 'Running',
      color: isDry ? 'bg-purple-600' : 'bg-green-600',
      textColor: isDry ? 'text-purple-100' : 'text-green-100',
      pulse: true,
    }
  }
  if (exchange?.regimeEnabled) {
    return { label: 'Ready', color: 'bg-blue-600', textColor: 'text-blue-100' }
  }
  return { label: 'Off', color: 'bg-gray-600', textColor: 'text-gray-300' }
}

function ExchangeSelector({ currentExchange, currentPair, exchanges, onChange, onRefresh, onAddFund }) {
  const [isOpen, setIsOpen] = useState(false)
  const triggerRef = useRef(null)
  const [popupStyle, setPopupStyle] = useState({})

  // Fixed positioning uses the visible viewport on both mobile and desktop.
  // Keep the whole popup scrollable so footer actions remain reachable too.
  useLayoutEffect(() => {
    if (!isOpen) return
    const viewport = window.visualViewport
    const updateBounds = () => {
      const trigger = triggerRef.current?.getBoundingClientRect()
      if (!trigger) return
      const leftEdge = viewport?.offsetLeft || 0
      const topEdge = viewport?.offsetTop || 0
      const viewportWidth = viewport?.width ?? window.innerWidth
      const viewportHeight = viewport?.height ?? window.innerHeight
      const margin = Math.min(16, viewportWidth / 4, viewportHeight / 4)
      const availableWidth = viewportWidth - margin * 2
      const width = viewportWidth >= 768 ? Math.min(320, availableWidth) : availableWidth
      const bottomEdge = topEdge + viewportHeight - margin
      // Leave enough space to browse when the trigger is near the bottom.
      const minimumBrowseHeight = Math.min(160, viewportHeight - margin * 2)
      const top = Math.max(topEdge + margin, Math.min(trigger.bottom + 8, bottomEdge - minimumBrowseHeight))
      setPopupStyle({
        top,
        left: Math.max(leftEdge + margin, Math.min(trigger.right - width, leftEdge + viewportWidth - margin - width)),
        width,
        maxHeight: Math.max(0, bottomEdge - top),
      })
    }
    updateBounds()
    window.addEventListener('resize', updateBounds)
    window.addEventListener('scroll', updateBounds, true)
    viewport?.addEventListener('resize', updateBounds)
    viewport?.addEventListener('scroll', updateBounds)
    return () => {
      window.removeEventListener('resize', updateBounds)
      window.removeEventListener('scroll', updateBounds, true)
      viewport?.removeEventListener('resize', updateBounds)
      viewport?.removeEventListener('scroll', updateBounds)
    }
  }, [isOpen])

  // Focus before removing the active option so dialogs capture a connected
  // return target and navigation/refresh never leave focus on the body.
  const closeWithFocus = () => {
    triggerRef.current?.focus()
    setIsOpen(false)
  }

  const handleKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeWithFocus()
    }
  }

  const handleSelect = (exchangeName, pair) => {
    closeWithFocus()
    onChange(exchangeName, pair)
  }

  const handleAddFund = () => {
    closeWithFocus()
    onAddFund?.()
  }

  // Close dropdown when clicking outside or pressing Escape
  useEffect(() => {
    if (!isOpen) return
    const handleClickOutside = (e) => {
      if (!e.target.closest('.exchange-selector')) {
        setIsOpen(false)
      }
    }
    document.addEventListener('click', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('click', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen])

  // Find the entry matching both exchange AND pair (multi-pair installs may
  // have several entries per exchange). Falls back to the first entry on
  // this exchange if no pair was passed.
  const currentExchangeConfig = exchanges?.find(
    (e) => e.name === currentExchange && (currentPair ? e.pair === currentPair : true)
  ) || exchanges?.find((e) => e.name === currentExchange)
  const currentStatus = getEngineStatus(currentExchangeConfig)
  const displayPair = currentPair || currentExchangeConfig?.pair || currentExchangeConfig?.productId || 'Not configured'

  return (
    <div className="exchange-selector relative">
      <button
        ref={triggerRef}
        aria-expanded={isOpen}
        aria-controls="exchange-selector-options"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 md:gap-2 px-1.5 md:px-3 py-1.5 md:py-2 min-h-[40px] bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors"
      >
        <span className={`w-5 h-5 md:w-6 md:h-6 text-xs md:text-sm flex items-center justify-center rounded-sm shrink-0 ${EXCHANGE_COLORS[currentExchange] || 'bg-gray-600'}`}>
          {EXCHANGE_ICONS[currentExchange] || '?'}
        </span>
        <span className="font-medium capitalize hidden md:inline">{currentExchange}</span>
        <span className="text-gray-400 hidden md:inline">/</span>
        <span className="text-xs md:text-sm text-gray-300 shrink-0">{displayPair}</span>
        <span className={`text-2xs md:text-xs px-1 md:px-2 py-0.5 rounded-sm shrink-0 ${currentStatus.color} ${currentStatus.textColor} ${currentStatus.pulse ? 'animate-pulse' : ''}`}>
          {currentStatus.label}
        </span>
        <svg className={`w-4 h-4 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div id="exchange-selector-options" style={popupStyle} className="fixed overflow-y-auto overscroll-contain bg-gray-800 border border-gray-700 rounded-lg shadow-lg z-50">
          <div className="p-2">
            <div className="text-xs text-gray-400 uppercase tracking-wider px-2 py-1">Select Exchange & Pair</div>

            {exchanges?.map(exchange => {
              const status = getEngineStatus(exchange)
              const pairValue = exchange.pair || exchange.productId
              const isSelected = exchange.name === currentExchange && pairValue === currentPair
              const key = `${exchange.name}::${pairValue}`

              return (
                <button
                  key={key}
                  onClick={() => handleSelect(exchange.name, pairValue)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 mb-1 rounded-lg transition-colors ${
                    isSelected
                      ? 'bg-blue-600/20 text-blue-300 border border-blue-500/50'
                      : 'hover:bg-gray-700 text-gray-300'
                  }`}
                >
                  <span className={`w-7 h-7 flex items-center justify-center rounded-sm shrink-0 ${EXCHANGE_COLORS[exchange.name] || 'bg-gray-600'}`}>
                    {EXCHANGE_ICONS[exchange.name] || '?'}
                  </span>
                  <div className="flex-1 text-left">
                    <div className="text-sm font-medium capitalize">{exchange.name}</div>
                    <div className="text-xs text-gray-400">{pairValue || 'Not configured'}</div>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-sm ${status.color}/50 ${status.textColor.replace('100', '200')} ${status.pulse ? 'animate-pulse' : ''}`}>
                    {status.label}
                  </span>
                </button>
              )
            })}
          </div>

          <div className="border-t border-gray-700 p-2 space-y-1">
            {onAddFund && (
              <Button
                onClick={handleAddFund}
                variant="soft-primary" size="md" className="w-full gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Add Fund
              </Button>
            )}
            <Button
              onClick={() => {
                closeWithFocus()
                onRefresh?.()
              }}
              variant="secondary" size="md" className="w-full gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Refresh Exchanges
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

export default ExchangeSelector
