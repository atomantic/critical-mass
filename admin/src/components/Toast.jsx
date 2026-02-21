import { useState, useEffect, useRef, createContext, useContext, useCallback } from 'react'

const ToastContext = createContext({
  addToast: () => {},
})

export const useToast = () => useContext(ToastContext)

// Toast types with their styles
const toastStyles = {
  success: 'bg-green-900/90 border-green-600 text-green-100',
  error: 'bg-red-900/90 border-red-600 text-red-100',
  warning: 'bg-yellow-900/90 border-yellow-600 text-yellow-100',
  info: 'bg-blue-900/90 border-blue-600 text-blue-100',
  trade: 'bg-purple-900/90 border-purple-600 text-purple-100',
}

// Icons for each type
const toastIcons = {
  success: (
    <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
    </svg>
  ),
  error: (
    <svg className="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
    </svg>
  ),
  warning: (
    <svg className="w-5 h-5 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
    </svg>
  ),
  info: (
    <svg className="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  trade: (
    <svg className="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
    </svg>
  ),
}

function Toast({ id, type, title, message, onClose }) {
  const timerRef = useRef(null)

  useEffect(() => {
    timerRef.current = setTimeout(() => onClose(id), 5000)
    return () => clearTimeout(timerRef.current)
  }, [id, onClose])

  const handleDismiss = () => {
    clearTimeout(timerRef.current)
    onClose(id)
  }

  return (
    <div
      className={`flex items-start gap-3 p-4 rounded-lg border shadow-lg animate-slide-in ${toastStyles[type]}`}
      role="alert"
    >
      <div className="flex-shrink-0 mt-0.5">{toastIcons[type]}</div>
      <div className="flex-1 min-w-0">
        {title && <div className="font-semibold text-sm">{title}</div>}
        <div className="text-sm opacity-90">{message}</div>
      </div>
      <button
        onClick={handleDismiss}
        className="flex-shrink-0 opacity-70 hover:opacity-100 transition-opacity"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const addToast = useCallback(({ type = 'info', title, message }) => {
    const id = Date.now() + Math.random()
    setToasts((prev) => [...prev.slice(-4), { id, type, title, message }])
  }, [])

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
        {toasts.map((toast) => (
          <Toast key={toast.id} {...toast} onClose={removeToast} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

// Map trade event types to toast types
export function tradeEventToToast(event) {
  const typeMap = {
    starting: { type: 'info', title: `[${event.exchange}] Starting` },
    checking_orders: { type: 'info', title: `[${event.exchange}] Checking Orders` },
    order_filled: { type: 'success', title: `[${event.exchange}] Order Filled` },
    price_check: { type: 'info', title: `[${event.exchange}] Price Check` },
    balance_check: { type: 'info', title: `[${event.exchange}] Balance` },
    buy_placing: { type: 'trade', title: `[${event.exchange}] Placing Buy` },
    buy_placed: { type: 'trade', title: `[${event.exchange}] Buy Placed` },
    buy_filled: { type: 'success', title: `[${event.exchange}] Buy Filled` },
    sell_placed: { type: 'trade', title: `[${event.exchange}] Sell Placed` },
    complete: { type: 'success', title: `[${event.exchange}] Cycle Complete` },
    error: { type: 'error', title: `[${event.exchange}] Error` },
    skipped: { type: 'warning', title: `[${event.exchange}] Skipped` },
    disabled: { type: 'warning', title: `[${event.exchange}] Disabled` },
  }

  const config = typeMap[event.type] || { type: 'info', title: `[${event.exchange}]` }
  return {
    ...config,
    message: event.message,
  }
}

export default ToastProvider
