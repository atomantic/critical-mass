import { useState, useEffect, useRef } from 'react'
import { useLogStream } from '../hooks/useLogStream'
import { useToast } from './Toast'

const TAIL_OPTIONS = [100, 250, 500, 1000, 2000]

export default function LogViewer({ processName }) {
  const [tailLines, setTailLines] = useState(500)
  const [fullscreen, setFullscreen] = useState(false)
  const { logs, subscribed, clear, flush, flushing } = useLogStream(processName, { lines: tailLines })
  const { addToast } = useToast()
  const containerRef = useRef(null)
  const autoScrollRef = useRef(true)
  const prevFlushing = useRef(false)

  // Track flush completion for toast feedback
  useEffect(() => {
    if (prevFlushing.current && !flushing) {
      addToast({ type: 'success', title: 'Logs Flushed', message: `Flushed logs for ${processName}` })
    }
    prevFlushing.current = flushing
  }, [flushing, processName, addToast])

  // Auto-scroll to bottom on new lines (unless user scrolled up)
  useEffect(() => {
    const el = containerRef.current
    if (el && autoScrollRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [logs])

  const handleScroll = () => {
    const el = containerRef.current
    if (!el) return
    // Consider "at bottom" if within 50px of the bottom
    autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50
  }

  const formatTime = (ts) => {
    const d = new Date(ts)
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
      + '.' + String(d.getMilliseconds()).padStart(3, '0')
  }

  const logContent = (
    <div className={fullscreen ? 'fixed inset-0 z-50 bg-gray-900 flex flex-col' : ''}>
      {/* Header bar */}
      <div className="flex items-center gap-3 px-4 py-2 bg-gray-800 border-b border-gray-700 flex-wrap">
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-400">Tail:</label>
          <select
            value={tailLines}
            onChange={(e) => setTailLines(Number(e.target.value))}
            className="bg-gray-700 text-gray-200 text-xs rounded px-2 py-1 border border-gray-600 focus:border-blue-500 focus:outline-none"
          >
            {TAIL_OPTIONS.map(n => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>

        <span className="text-xs text-gray-500">{logs.length} lines</span>

        <div className="flex items-center gap-2 ml-auto">
          {/* Streaming status */}
          <div className="flex items-center gap-1.5 text-xs">
            <span className={`w-2 h-2 rounded-full ${subscribed ? 'bg-green-500 animate-pulse' : 'bg-gray-500'}`} />
            <span className={subscribed ? 'text-green-400' : 'text-gray-400'}>
              {subscribed ? 'Streaming' : 'Disconnected'}
            </span>
          </div>

          <button
            onClick={clear}
            className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 rounded transition-colors"
          >
            Clear
          </button>

          <button
            onClick={flush}
            disabled={flushing}
            className="px-2 py-1 text-xs bg-yellow-700 hover:bg-yellow-600 disabled:bg-yellow-800 disabled:text-gray-500 text-yellow-100 rounded transition-colors"
          >
            {flushing ? 'Flushing...' : 'Flush'}
          </button>

          <button
            onClick={() => setFullscreen(!fullscreen)}
            className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 rounded transition-colors"
          >
            {fullscreen ? 'Close' : 'Fullscreen'}
          </button>
        </div>
      </div>

      {/* Log container */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className={`${fullscreen ? 'flex-1' : 'h-[32rem]'} overflow-y-auto bg-gray-950 font-mono text-xs leading-5 p-3`}
      >
        {logs.length === 0 ? (
          <div className="text-gray-600 text-center py-8">
            {subscribed ? 'Waiting for log output...' : `Connecting to ${processName}...`}
          </div>
        ) : (
          logs.map((entry, i) => (
            <div key={i} className="flex gap-2 hover:bg-gray-900/50">
              <span className="text-gray-600 shrink-0 select-none">{formatTime(entry.timestamp)}</span>
              <span className={entry.type === 'stderr' ? 'text-red-400' : 'text-gray-300'}>{entry.line}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )

  return fullscreen ? logContent : (
    <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
      {logContent}
    </div>
  )
}
