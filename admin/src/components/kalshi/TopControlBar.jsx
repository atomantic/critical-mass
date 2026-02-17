import { createPortal } from 'react-dom'
import { Play, Square, RefreshCw, Wifi, WifiOff } from 'lucide-react'

function ToggleSwitch({ label, checked, onChange, disabled, colorOn = 'bg-green-500', colorOff = 'bg-gray-600' }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer min-h-[44px]">
      <span className="text-sm text-gray-400">{label}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
          disabled ? 'opacity-50 cursor-not-allowed' : ''
        } ${checked ? colorOn : colorOff}`}
      >
        <span
          className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
            checked ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
    </label>
  )
}

/**
 * Compact single-row control bar: toggles and engine start/stop
 */
export default function TopControlBar({
  config,
  status,
  updating,
  engineAction,
  onToggleConfig,
  onEngine,
  onResetDryRun,
}) {
  return (
    <div className="bg-gray-800 rounded-lg px-4 py-3">
      <div className="flex items-center justify-between flex-wrap gap-3">
        {/* Left: Toggles */}
        <div className="flex items-center gap-5">
          <ToggleSwitch
            label="Automation"
            checked={config?.enabled}
            onChange={(v) => onToggleConfig('enabled', v)}
            disabled={updating}
            colorOn="bg-green-500"
          />
          <ToggleSwitch
            label="Dry Run"
            checked={config?.dryRun}
            onChange={(v) => onToggleConfig('dryRun', v)}
            disabled={updating}
            colorOn="bg-yellow-500"
          />
        </div>

        {/* Center: Engine controls */}
        <div className="flex items-center gap-2">
          {config?.dryRun && (
            <button
              onClick={onResetDryRun}
              disabled={engineAction === 'reset'}
              className="px-3 py-2 min-h-[44px] bg-purple-600 hover:bg-purple-500 disabled:bg-purple-800 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5"
            >
              <RefreshCw size={14} className={engineAction === 'reset' ? 'animate-spin' : ''} />
              Reset
            </button>
          )}

          {status?.engineRunning ? (
            <button
              onClick={() => onEngine('stop')}
              disabled={engineAction === 'stop'}
              className="px-4 py-2 min-h-[44px] bg-red-600 hover:bg-red-500 disabled:bg-red-800 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5"
            >
              <Square size={14} />
              Stop
            </button>
          ) : (
            <button
              onClick={() => onEngine('start')}
              disabled={engineAction === 'start' || !config?.enabled}
              className="px-4 py-2 min-h-[44px] bg-green-600 hover:bg-green-500 disabled:bg-green-800 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5"
            >
              <Play size={14} />
              Start
            </button>
          )}
        </div>

        {/* Right: Engine stop/start is now the rightmost control */}
      </div>
    </div>
  )
}

/**
 * Live status indicators rendered via portal into the header nav bar
 */
export function HeaderStatus({ config, status, connected, coinbaseConnected, exchangeCount, onRefresh }) {
  const portalTarget = document.getElementById('header-status-portal')
  if (!portalTarget) return null

  return createPortal(
    <div className="flex items-center gap-3">
      <div className={`px-2.5 py-1 rounded text-xs font-semibold ${
        !config?.enabled ? 'bg-red-900/40 text-red-400' :
        config?.dryRun ? 'bg-yellow-900/40 text-yellow-400' : 'bg-green-900/40 text-green-400'
      }`}>
        {!config?.enabled ? 'Disabled' : config?.dryRun ? 'Dry Run' : 'Live'}
        {status?.engineRunning && ' (Running)'}
      </div>

      <div className="flex items-center gap-1.5">
        <div className={`flex items-center gap-1 text-xs ${connected ? 'text-green-400' : 'text-gray-500'}`} title="Kalshi">
          {connected ? <Wifi size={12} /> : <WifiOff size={12} />}
        </div>
        <div className={`w-1.5 h-1.5 rounded-full ${coinbaseConnected ? 'bg-orange-400' : 'bg-gray-600'}`} title={`Coinbase ${coinbaseConnected ? 'connected' : 'disconnected'}`} />
        {exchangeCount > 1 && (
          <span className="text-xs text-blue-400" title={`${exchangeCount} exchanges feeding composite`}>{exchangeCount}x</span>
        )}
      </div>

      <button
        onClick={onRefresh}
        className="p-1.5 rounded bg-gray-700 hover:bg-gray-600 transition-colors"
        title="Force refresh"
      >
        <RefreshCw size={14} />
      </button>
    </div>,
    portalTarget
  )
}
