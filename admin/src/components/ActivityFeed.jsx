import { useState } from 'react'
import { useTradeEvents } from '../hooks/useTradeEvents'

// Event type styles
const eventStyles = {
  starting: { bg: 'bg-blue-900/30', border: 'border-blue-600', dot: 'bg-blue-500' },
  checking_orders: { bg: 'bg-gray-800/50', border: 'border-gray-600', dot: 'bg-gray-400' },
  order_filled: { bg: 'bg-green-900/30', border: 'border-green-600', dot: 'bg-green-500' },
  price_check: { bg: 'bg-gray-800/50', border: 'border-gray-600', dot: 'bg-gray-400' },
  balance_check: { bg: 'bg-gray-800/50', border: 'border-gray-600', dot: 'bg-gray-400' },
  buy_placing: { bg: 'bg-purple-900/30', border: 'border-purple-600', dot: 'bg-purple-500' },
  buy_placed: { bg: 'bg-purple-900/30', border: 'border-purple-600', dot: 'bg-purple-500' },
  buy_filled: { bg: 'bg-green-900/30', border: 'border-green-600', dot: 'bg-green-500' },
  sell_placed: { bg: 'bg-yellow-900/30', border: 'border-yellow-600', dot: 'bg-yellow-500' },
  complete: { bg: 'bg-green-900/30', border: 'border-green-600', dot: 'bg-green-500' },
  error: { bg: 'bg-red-900/30', border: 'border-red-600', dot: 'bg-red-500' },
  skipped: { bg: 'bg-yellow-900/30', border: 'border-yellow-600', dot: 'bg-yellow-500' },
  disabled: { bg: 'bg-red-900/30', border: 'border-red-600', dot: 'bg-red-500' },
}

const defaultStyle = { bg: 'bg-gray-800/50', border: 'border-gray-600', dot: 'bg-gray-400' }

function formatTime(timestamp) {
  const date = new Date(timestamp)
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function ActivityFeed({ exchange = null, maxEvents = 10, showWhenEmpty = true }) {
  const { events, connected, clearEvents } = useTradeEvents(exchange)
  const [expanded, setExpanded] = useState(false)

  const displayEvents = expanded ? events : events.slice(0, maxEvents)

  if (!showWhenEmpty && events.length === 0) {
    return null
  }

  return (
    <div className="bg-gray-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-semibold">Live Activity</h3>
          <span
            className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}
            title={connected ? 'Connected' : 'Disconnected'}
          />
        </div>
        {events.length > 0 && (
          <div className="flex items-center gap-2">
            {events.length > maxEvents && (
              <button
                onClick={() => setExpanded(!expanded)}
                className="text-xs text-gray-400 hover:text-white"
              >
                {expanded ? 'Show less' : `Show all (${events.length})`}
              </button>
            )}
            <button
              onClick={clearEvents}
              className="text-xs text-gray-400 hover:text-white"
            >
              Clear
            </button>
          </div>
        )}
      </div>

      {events.length === 0 ? (
        <div className="text-gray-500 text-sm text-center py-8">
          {connected ? 'Waiting for trade activity...' : 'Connecting to server...'}
        </div>
      ) : (
        <div className="space-y-2 max-h-[calc(100vh-12rem)] overflow-y-auto">
          {displayEvents.map((event, i) => {
            const style = eventStyles[event.type] || defaultStyle
            return (
              <div
                key={`${event.timestamp}-${i}`}
                className={`flex items-start gap-3 p-2 rounded border ${style.bg} ${style.border} animate-fade-in`}
              >
                <span className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${style.dot}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-xs text-gray-400">
                    <span className="font-medium text-gray-300">{event.exchange}</span>
                    <span>{formatTime(event.timestamp)}</span>
                  </div>
                  <div className="text-sm mt-0.5">{event.message}</div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default ActivityFeed
