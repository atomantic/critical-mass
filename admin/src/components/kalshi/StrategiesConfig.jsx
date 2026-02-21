import { useState, useEffect, useCallback } from 'react'
import { ChevronDown, ChevronRight, Activity, Zap, Target, TrendingUp, RefreshCw, Check, Settings, AlertTriangle, Sparkles } from 'lucide-react'
import { useToast } from '../Toast'

const STRATEGY_INFO = {
  'settlement-sniper': {
    name: 'Settlement Sniper',
    description: 'Volatility-adjusted probability model (pseudo Black-Scholes) trading the 2-5 minute sweet spot before settlement where edge is clearest.',
    type: 'crypto',
    icon: Zap,
    recommended: true,
    params: [
      { key: 'edgeThreshold', label: 'Edge Threshold', type: 'number', default: 0.15, step: 0.01, hint: 'Min edge to enter (0.15 = 15% divergence from fair value)' },
      { key: 'volatilityWindow', label: 'Vol Window (sec)', type: 'number', default: 300, hint: 'Rolling window for volatility calc (300 = 5 min of Coinbase ticks)' },
      { key: 'minVolatilityDataPoints', label: 'Min Vol Data Points', type: 'number', default: 60, hint: 'Minimum observations before trading (60 = 1 min at 1/sec)' },
      { key: 'minEntryPrice', label: 'Min Entry Price (c)', type: 'number', default: 15, hint: 'Don\'t buy below 15c (fees eat profit)' },
      { key: 'maxEntryPrice', label: 'Max Entry Price (c)', type: 'number', default: 85, hint: 'Don\'t buy above 85c (limited upside)' },
      { key: 'minMomentumConfirm', label: 'Min Momentum Confirm', type: 'number', default: 3, hint: 'Min confirming ticks (60%+ of last N must trend our way)' },
      { key: 'primaryEntryMin', label: 'Entry Window Start (sec)', type: 'number', default: 120, hint: 'Begin entries at this many seconds before settlement' },
      { key: 'monitorOnlyAbove', label: 'Monitor Only Above (sec)', type: 'number', default: 600, hint: 'Only monitor (no entries) when more than this far from settlement' },
      { key: 'noTradeBelow', label: 'No Trade Below (sec)', type: 'number', default: 60, hint: 'Stop trading when settlement averaging begins (< 60s)' },
      { key: 'kellyFraction', label: 'Kelly Fraction', type: 'number', default: 0.25, step: 0.05, hint: 'Fraction of full Kelly (0.25 = quarter-Kelly, conservative)' },
      { key: 'maxBetPct', label: 'Max Bet % of Bankroll', type: 'number', default: 0.05, step: 0.01, hint: 'Max bet as % of available balance (0.05 = 5%)' },
      { key: 'positionSize', label: 'Max Contracts', type: 'number', default: 10, hint: 'Max contracts per trade (Kelly may size lower)' },
      { key: 'maxPositions', label: 'Max Positions', type: 'number', default: 3, hint: 'Max concurrent open positions for this strategy' },
      { key: 'stopLossEdge', label: 'Stop Loss Edge', type: 'number', default: 0.10, step: 0.01, hint: 'Exit when edge reverses beyond this (0.10 = 10%)' },
      { key: 'settlementRideThreshold', label: 'Settlement Ride Edge', type: 'number', default: 0.40, step: 0.05, hint: 'Hold through exit window if edge > this (0.40 = 40%, ride to $1 payout)' },
      { key: 'settlementRideMaxSeconds', label: 'Settlement Ride Max (sec)', type: 'number', default: 180, hint: 'Max seconds left for settlement ride exception' }
    ]
  },
  'coinbase-fair-value': {
    name: 'Coinbase Fair Value',
    description: 'Calculates fair probability from Coinbase spot price vs strike. Trades only when high-conviction edge exists near settlement.',
    type: 'crypto',
    icon: Target,
    recommended: true,
    params: [
      { key: 'edgeThreshold', label: 'Edge Threshold', type: 'number', default: 0.25, step: 0.05, hint: 'Min divergence to enter (0.25 = 25% - high conviction only)' },
      { key: 'exitEdgeThreshold', label: 'Exit Edge', type: 'number', default: 0.10, step: 0.01, hint: 'Exit when edge shrinks below this' },
      { key: 'minSecondsToSettlement', label: 'Min Sec to Settlement', type: 'number', default: 30, hint: 'Don\'t trade if less than this many seconds to settlement' },
      { key: 'maxSecondsToSettlement', label: 'Max Sec to Settlement', type: 'number', default: 180, hint: 'Don\'t trade if more than 3 min to settlement (edge uncertain)' },
      { key: 'stopLossPct', label: 'Stop Loss %', type: 'number', default: 0.30, step: 0.05, hint: 'Stop loss percentage (0.30 = 30% - give room to breathe)' },
      { key: 'takeProfitPct', label: 'Take Profit %', type: 'number', default: 0.15, step: 0.05, hint: 'Take profit percentage (0.15 = 15% - take wins early)' },
      { key: 'positionSize', label: 'Position Size', type: 'number', default: 5, hint: 'Contracts per trade' },
      { key: 'maxPositions', label: 'Max Positions', type: 'number', default: 2, hint: 'Max open positions for this strategy' },
      { key: 'minEntryPrice', label: 'Min Entry Price (c)', type: 'number', default: 10, hint: 'Don\'t buy below 10c (fees eat profit)' },
      { key: 'maxEntryPrice', label: 'Max Entry Price (c)', type: 'number', default: 90, hint: 'Don\'t buy above 90c (fees eat profit)' }
    ]
  },
  'momentum-rider': {
    name: 'Momentum Rider',
    description: 'Rides Kalshi momentum with Coinbase spot confirmation -- buys at 65-80c and rides to settlement. No stop loss; fair value + spot momentum must confirm.',
    type: 'crypto',
    icon: TrendingUp,
    recommended: false,
    params: [
      { key: 'entryThreshold', label: 'Entry Threshold (c)', type: 'number', default: 65, hint: 'Buy when price reaches this level (65c = capture more upside)' },
      { key: 'maxEntryPrice', label: 'Max Entry Price (c)', type: 'number', default: 80, hint: 'Don\'t buy above 80c (risk/reward inverts)' },
      { key: 'profitTarget', label: 'Profit Target (c)', type: 'number', default: 15, hint: 'Take profit if up 15c+ (enough to clear fees). 0 = ride to settlement' },
      { key: 'stopLoss', label: 'Stop Loss (c)', type: 'number', default: 0, hint: '0 = disabled (ride to settlement). Fees make tight stops unprofitable' },
      { key: 'minTrendTicks', label: 'Min Trend Ticks', type: 'number', default: 3, hint: 'Require N of last 8 Kalshi ticks trending our way' },
      { key: 'trendLookback', label: 'Trend Lookback', type: 'number', default: 8, hint: 'Number of recent Kalshi price snapshots to analyze' },
      { key: 'minSpotMomentum', label: 'Min Spot Momentum (%)', type: 'number', default: 0.05, step: 0.01, hint: 'Coinbase spot must move >= this % in predicted direction' },
      { key: 'spotLookbackSec', label: 'Spot Lookback (sec)', type: 'number', default: 60, hint: 'Window for Coinbase spot momentum check' },
      { key: 'maxFairValuePremium', label: 'Max Fair Value Premium (c)', type: 'number', default: 15, hint: 'Skip if market price > fair value + this (already overpriced)' },
      { key: 'minSecondsToSettlement', label: 'Min Sec to Settlement', type: 'number', default: 60, hint: 'Don\'t enter within 60s of settlement' },
      { key: 'maxSecondsToSettlement', label: 'Max Sec to Settlement', type: 'number', default: 300, hint: 'Don\'t enter more than 5 min out' },
      { key: 'exitBeforeSettlement', label: 'Exit Before (sec)', type: 'number', default: 0, hint: '0 = ride to settlement. Set > 0 to force exit early' },
      { key: 'positionSize', label: 'Position Size', type: 'number', default: 5, hint: 'Base contracts per trade' },
      { key: 'maxBetPct', label: 'Max Bet % of Bankroll', type: 'number', default: 0.02, step: 0.01, hint: 'Conservative 2% while proving strategy' },
      { key: 'maxContracts', label: 'Max Contracts', type: 'number', default: 50, hint: 'Hard cap on contracts per trade' },
      { key: 'maxPositions', label: 'Max Positions', type: 'number', default: 2, hint: 'Max concurrent positions for this strategy' }
    ]
  },
  'gamma-scalper': {
    name: 'Gamma Scalper',
    description: 'Buys cheap OTM brackets (5-15c) when spot trends toward the bracket range -- targets 10c take profit with 5c stop loss.',
    type: 'crypto',
    icon: Sparkles,
    recommended: false,
    params: [
      { key: 'minEntryPrice', label: 'Min Entry Price (c)', type: 'number', default: 5, hint: 'Only buy OTM contracts at or above this price' },
      { key: 'maxEntryPrice', label: 'Max Entry Price (c)', type: 'number', default: 15, hint: 'Only buy OTM contracts at or below this price' },
      { key: 'minSecondsToSettlement', label: 'Min Sec to Settlement', type: 'number', default: 120, hint: 'Need enough time for repricing to occur' },
      { key: 'maxSecondsToSettlement', label: 'Max Sec to Settlement', type: 'number', default: 600, hint: 'OTM value decays too early' },
      { key: 'takeProfitCents', label: 'Take Profit (c)', type: 'number', default: 10, hint: 'Exit at entry + this (10c on a 10c entry = 100% return)' },
      { key: 'stopLossCents', label: 'Stop Loss (c)', type: 'number', default: 5, hint: 'Max loss per contract in cents' },
      { key: 'edgeThreshold', label: 'Edge Threshold', type: 'number', default: 0.08, step: 0.01, hint: 'Min edge for OTM entry (0.08 = 8%)' },
      { key: 'minMomentumTicks', label: 'Min Momentum Ticks', type: 'number', default: 4, hint: 'Min ticks trending toward bracket out of lookback window' },
      { key: 'momentumLookback', label: 'Momentum Lookback', type: 'number', default: 8, hint: 'Recent ticks to check for momentum toward bracket' },
      { key: 'maxBetPct', label: 'Max Bet % of Bankroll', type: 'number', default: 0.02, step: 0.01, hint: 'Conservative 2% max (speculative OTM plays)' },
      { key: 'maxContracts', label: 'Max Contracts', type: 'number', default: 50, hint: 'Hard cap on contracts per trade' },
      { key: 'maxPositions', label: 'Max Positions', type: 'number', default: 2, hint: 'Max concurrent OTM positions' }
    ]
  },
  'swing-flipper': {
    name: 'Swing Flipper',
    description: 'Rides intra-window oscillation on ATM brackets (25-65c). Buys pullbacks below recent peak, sells recoveries for 8c flips. Never holds to settlement.',
    type: 'crypto',
    icon: RefreshCw,
    recommended: false,
    params: [
      { key: 'minContractPrice', label: 'Min Contract Price (c)', type: 'number', default: 25, hint: 'Only target ATM brackets at or above this price' },
      { key: 'maxContractPrice', label: 'Max Contract Price (c)', type: 'number', default: 65, hint: 'Only target ATM brackets at or below this price' },
      { key: 'minOscillationRange', label: 'Min Oscillation Range (c)', type: 'number', default: 10, hint: 'Contract must show this range in recent snapshots' },
      { key: 'oscillationLookback', label: 'Oscillation Lookback', type: 'number', default: 15, hint: 'Number of recent snapshots to check for oscillation' },
      { key: 'pullbackEntry', label: 'Pullback Entry (c)', type: 'number', default: 8, hint: 'Buy when price is this many cents below recent peak' },
      { key: 'takeProfitCents', label: 'Take Profit (c)', type: 'number', default: 8, hint: 'Exit at entry + this (do not exceed 10c)' },
      { key: 'stopLossCents', label: 'Stop Loss (c)', type: 'number', default: 6, hint: 'Max loss per contract in cents (must cut fast)' },
      { key: 'minSecondsToSettlement', label: 'Time Exit (sec)', type: 'number', default: 90, hint: 'Force exit when this close to settlement' },
      { key: 'maxSecondsToSettlement', label: 'Max Sec to Settlement', type: 'number', default: 540, hint: 'Don\'t enter more than 9 min out' },
      { key: 'collapseRangeThreshold', label: 'Collapse Threshold (c)', type: 'number', default: 6, hint: 'Exit if oscillation range collapses below this' },
      { key: 'collapseLookback', label: 'Collapse Lookback', type: 'number', default: 8, hint: 'Recent snapshots to check for oscillation collapse' },
      { key: 'minSpotNearBracket', label: 'Min Spot Near Bracket (%)', type: 'number', default: 0.5, step: 0.1, hint: 'Spot must be within this % of bracket boundary' },
      { key: 'maxBetPct', label: 'Max Bet % of Bankroll', type: 'number', default: 0.01, step: 0.01, hint: 'Conservative 1% max (initial live sizing)' },
      { key: 'maxContracts', label: 'Max Contracts', type: 'number', default: 15, hint: 'Hard cap on contracts per trade' },
      { key: 'maxPositions', label: 'Max Positions', type: 'number', default: 1, hint: 'Max concurrent positions (keep at 1 for now)' }
    ]
  }
}

function PerformanceCard({ analytics }) {
  if (!analytics) return null

  const { summary, byStrategy, byReason } = analytics
  const winRateColor = summary.winRate >= 50 ? 'text-green-400' : summary.winRate >= 30 ? 'text-yellow-400' : 'text-red-400'
  const pnlColor = summary.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'

  return (
    <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Activity size={18} className="text-blue-400" />
        <h3 className="font-semibold text-white">Live Performance</h3>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-3">
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-gray-500">Trades</span>
          <span className="text-xl font-bold text-white">{summary.totalTrades}</span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-gray-500">Win Rate</span>
          <span className={`text-xl font-bold ${winRateColor}`}>{summary.winRate.toFixed(1)}%</span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-gray-500">Total P&L</span>
          <span className={`text-xl font-bold ${pnlColor}`}>${summary.totalPnl.toFixed(2)}</span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-gray-500">Avg P&L</span>
          <span className={`text-xl font-bold ${summary.avgPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>${summary.avgPnl.toFixed(2)}</span>
        </div>
      </div>

      {Object.keys(byStrategy).length > 0 && (
        <div className="pt-3 border-t border-gray-700/50">
          <div className="text-xs text-gray-500 mb-2">By Strategy</div>
          <div className="space-y-1">
            {Object.entries(byStrategy).map(([name, data]) => (
              <div key={name} className="flex justify-between text-sm">
                <span className="text-gray-400">{name}</span>
                <span className={data.pnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                  {data.winRate.toFixed(0)}% win, ${data.pnl.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {Object.keys(byReason).length > 0 && (
        <div className="pt-3 border-t border-gray-700/50">
          <div className="text-xs text-gray-500 mb-2">Exit Reasons</div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(byReason).map(([reason, data]) => (
              <span key={reason} className="px-2 py-1 bg-gray-700/50 rounded text-xs text-gray-300">
                {reason}: {data.count}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function AutoTuneCard({ analytics, strategies, onTune }) {
  const { addToast } = useToast()
  const [autoTuneEnabled, setAutoTuneEnabled] = useState(false)

  useEffect(() => {
    fetch('/api/kalshi/auto-tune/status').then(r => r.ok ? r.json() : null).then(d => {
      if (d) setAutoTuneEnabled(d.enabled)
    })
  }, [])

  const suggestions = []

  if (analytics?.summary) {
    const { winRate, totalTrades } = analytics.summary
    const stopLossCount = analytics.byReason?.['Stop loss']?.count || 0
    const takeProfitCount = analytics.byReason?.['Take profit']?.count || 0

    if (totalTrades >= 10) {
      if (stopLossCount > takeProfitCount * 3) {
        suggestions.push({
          type: 'warning',
          message: 'Too many stop losses. Consider widening stopLossPct.',
          action: 'widen_stops',
          params: { stopLossPct: 0.20 }
        })
      }

      if (winRate < 30) {
        suggestions.push({
          type: 'warning',
          message: 'Low win rate. Consider increasing edgeThreshold.',
          action: 'increase_edge',
          params: { edgeThreshold: 0.15 }
        })
      }

      if (analytics?.summary?.totalPnl < -50) {
        suggestions.push({
          type: 'error',
          message: 'Significant losses. Consider reducing positionSize.',
          action: 'reduce_size',
          params: { positionSize: 3 }
        })
      }
    }
  }

  const applyTune = (action, params) => {
    onTune(action, params)
    addToast({ type: 'success', message: `Applied tuning: ${action}` })
  }

  return (
    <div className="bg-gradient-to-r from-purple-900/30 to-blue-900/30 border border-purple-500/30 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles size={18} className="text-purple-400" />
          <h3 className="font-semibold text-white">Auto-Tuning</h3>
        </div>
        <button
          onClick={async () => {
            const endpoint = autoTuneEnabled ? 'disable' : 'enable'
            const res = await fetch(`/api/kalshi/auto-tune/${endpoint}`, { method: 'POST' })
            if (res.ok) {
              const d = await res.json()
              setAutoTuneEnabled(d.enabled)
            }
          }}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            autoTuneEnabled ? 'bg-purple-500' : 'bg-gray-600'
          }`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm ${
            autoTuneEnabled ? 'translate-x-6' : 'translate-x-1'
          }`} />
        </button>
      </div>

      {autoTuneEnabled && (
        <p className="text-sm text-purple-300">
          Auto-tuning is monitoring performance. Parameters will be adjusted automatically when thresholds are breached.
        </p>
      )}

      {suggestions.length > 0 ? (
        <div className="space-y-2">
          {suggestions.map((suggestion, i) => (
            <div key={i} className={`flex items-start gap-3 p-3 rounded-lg ${
              suggestion.type === 'error' ? 'bg-red-900/30 border border-red-500/30' : 'bg-yellow-900/30 border border-yellow-500/30'
            }`}>
              <AlertTriangle size={16} className={suggestion.type === 'error' ? 'text-red-400' : 'text-yellow-400'} />
              <div className="flex-1">
                <p className="text-sm text-gray-200">{suggestion.message}</p>
              </div>
              <button
                onClick={() => applyTune(suggestion.action, suggestion.params)}
                className="px-3 py-1 bg-white/10 hover:bg-white/20 rounded text-xs font-medium transition-colors"
              >
                Apply
              </button>
            </div>
          ))}
        </div>
      ) : analytics?.summary?.totalTrades >= 10 ? (
        <p className="text-sm text-gray-400">No tuning suggestions. Parameters look good.</p>
      ) : (
        <p className="text-sm text-gray-400">Need at least 10 trades to generate tuning suggestions.</p>
      )}
    </div>
  )
}

function StrategyCard({ strategyKey, strategy, info, onUpdate }) {
  const [expanded, setExpanded] = useState(false)
  const Icon = info.icon

  const handleToggle = (e) => {
    e.stopPropagation()
    onUpdate(strategyKey, { ...strategy, enabled: !strategy.enabled })
  }

  const handleParamChange = (paramKey, value) => {
    onUpdate(strategyKey, {
      ...strategy,
      params: { ...strategy.params, [paramKey]: value }
    })
  }

  return (
    <div className={`rounded-xl border transition-all duration-200 ${
      strategy.enabled
        ? 'bg-gray-800/80 border-blue-500/50 shadow-lg shadow-blue-500/10'
        : 'bg-gray-800/50 border-gray-700/50'
    }`}>
      <div
        className="p-5 flex items-start gap-4 cursor-pointer hover:bg-white/5 transition-colors rounded-t-xl"
        onClick={() => setExpanded(!expanded)}
      >
        <div className={`p-2.5 rounded-lg ${strategy.enabled ? 'bg-blue-500/20' : 'bg-gray-700/50'}`}>
          <Icon size={20} className={strategy.enabled ? 'text-blue-400' : 'text-gray-500'} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="px-2 py-0.5 rounded-md text-xs font-medium border bg-amber-500/20 text-amber-400 border-amber-500/30">
              crypto
            </span>
            {info.recommended && (
              <span className="px-2 py-0.5 rounded-md text-xs font-medium bg-green-500/20 text-green-400 border border-green-500/30">
                recommended
              </span>
            )}
            <h3 className="font-semibold text-white">{info.name}</h3>
            {strategy.enabled && (
              <span className="flex items-center gap-1 text-xs text-green-400">
                <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse" />
                Active
              </span>
            )}
          </div>
          <p className="text-sm text-gray-400 leading-relaxed">{info.description}</p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleToggle}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              strategy.enabled ? 'bg-blue-500' : 'bg-gray-600'
            }`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm ${
              strategy.enabled ? 'translate-x-6' : 'translate-x-1'
            }`} />
          </button>

          <div className="text-gray-500">
            {expanded ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
          </div>
        </div>
      </div>

      {expanded && (
        <div className="px-5 pb-5 border-t border-gray-700/50">
          <div className="pt-4 grid grid-cols-2 lg:grid-cols-3 gap-4">
            {info.params.map(param => (
              <div key={param.key} className="space-y-1.5">
                <label className="block text-sm font-medium text-gray-300">{param.label}</label>
                <input
                  type={param.type}
                  step={param.step || 1}
                  value={strategy.params?.[param.key] ?? param.default}
                  onChange={(e) => handleParamChange(param.key, param.type === 'number' ? parseFloat(e.target.value) : e.target.value)}
                  className="w-full px-3 py-2 bg-gray-900/50 border border-gray-600 rounded-lg text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/50 transition-colors"
                />
                {param.hint && (
                  <p className="text-xs text-gray-500">{param.hint}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default function StrategiesConfig() {
  const { addToast } = useToast()
  const [strategies, setStrategies] = useState({})
  const [analytics, setAnalytics] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const fetchData = useCallback(async () => {
    const [stratRes, analyticsRes] = await Promise.all([
      fetch('/api/kalshi/strategies'),
      fetch('/api/kalshi/analytics')
    ])

    if (stratRes.ok) {
      const data = await stratRes.json().catch(() => null)
      if (data) setStrategies(data.strategies || {})
    }

    if (analyticsRes.ok) {
      const data = await analyticsRes.json().catch(() => null)
      if (data) setAnalytics(data)
    }

    setLoading(false)
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 10000)
    return () => clearInterval(interval)
  }, [fetchData])

  const handleUpdate = (strategyKey, strategyData) => {
    setStrategies(s => ({ ...s, [strategyKey]: strategyData }))
  }

  const handleTune = (action, params) => {
    const newStrategies = { ...strategies }

    for (const [key, strategy] of Object.entries(newStrategies)) {
      if (!strategy.enabled) continue

      const updatedParams = { ...strategy.params }

      if (action === 'widen_stops' && params.stopLossPct) {
        updatedParams.stopLossPct = params.stopLossPct
      }
      if (action === 'increase_edge' && params.edgeThreshold) {
        updatedParams.edgeThreshold = params.edgeThreshold
      }
      if (action === 'reduce_size' && params.positionSize) {
        updatedParams.positionSize = params.positionSize
      }

      newStrategies[key] = { ...strategy, params: updatedParams }
    }

    setStrategies(newStrategies)
  }

  const handleSaveAll = async () => {
    setSaving(true)

    const res = await fetch('/api/kalshi/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategies })
    })

    if (res.ok) {
      addToast({ type: 'success', message: 'Strategies saved successfully' })
    } else {
      addToast({ type: 'error', message: 'Failed to save strategies' })
    }

    setSaving(false)
  }

  const enabledCount = Object.values(strategies).filter(s => s?.enabled).length
  const allStrategies = Object.entries(STRATEGY_INFO)

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="text-gray-400">Loading strategies...</div>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-8 max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Trading Strategies</h1>
          <p className="text-gray-400 mt-1">
            Configure automated trading strategies. {enabledCount > 0 && (
              <span className="text-blue-400">{enabledCount} active</span>
            )}
          </p>
        </div>
        <button
          onClick={handleSaveAll}
          disabled={saving}
          className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 rounded-lg font-medium transition-colors flex items-center gap-2"
        >
          {saving ? (
            <>
              <RefreshCw size={16} className="animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Check size={16} />
              Save Changes
            </>
          )}
        </button>
      </div>

      {/* Performance & Auto-Tune */}
      <div className="grid lg:grid-cols-2 gap-4">
        <PerformanceCard analytics={analytics} />
        <AutoTuneCard analytics={analytics} strategies={strategies} onTune={handleTune} />
      </div>

      {/* Strategies */}
      <section>
        <div className="flex items-center gap-2 mb-4">
          <Sparkles size={18} className="text-green-400" />
          <h2 className="text-lg font-semibold text-gray-300">Strategies</h2>
        </div>
        <div className="space-y-4">
          {allStrategies.map(([key, info]) => (
            <StrategyCard
              key={key}
              strategyKey={key}
              strategy={strategies[key] || { enabled: false, params: {} }}
              info={info}
              onUpdate={handleUpdate}
            />
          ))}
        </div>
      </section>

      {/* Help text */}
      <div className="bg-gray-800/30 border border-gray-700/50 rounded-xl p-4">
        <p className="text-sm text-gray-400">
          <strong className="text-gray-300">How it works:</strong> Enable strategies and configure parameters.
          The auto-tuning system monitors performance and suggests parameter changes when needed.
          Click "Apply" on suggestions or enable auto-tune for automatic adjustments.
        </p>
      </div>
    </div>
  )
}
