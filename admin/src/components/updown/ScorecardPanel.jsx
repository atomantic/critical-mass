import { Target, TrendingUp, TrendingDown, Minus } from 'lucide-react'

const WINDOW_ORDER = ['1m', '5m', '15m', '1h']
const TF_ORDER = ['1d', '4h', '2h', '1h', '30m', '15m', '10m', '5m', '3m', '1m']
const INDICATOR_LABELS = {
  rsi: 'RSI',
  stochastic: 'Stoch',
  macd: 'MACD',
  bollinger: 'Bollinger',
  vwap: 'VWAP',
  momentum: 'Momentum',
}

const BASE_WEIGHTS = { rsi: 0.25, stochastic: 0.20, macd: 0.20, bollinger: 0.15, vwap: 0.10, momentum: 0.10 }

function accuracyColor(accuracy) {
  if (accuracy == null) return 'text-gray-500'
  if (accuracy >= 60) return 'text-green-400'
  if (accuracy >= 50) return 'text-yellow-400'
  return 'text-red-400'
}

function accuracyBg(accuracy) {
  if (accuracy == null) return 'bg-gray-700'
  if (accuracy >= 60) return 'bg-green-500'
  if (accuracy >= 50) return 'bg-yellow-500'
  return 'bg-red-500'
}

function AccuracyBar({ accuracy, label, detail }) {
  const pct = accuracy ?? 0
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-16 text-gray-400 truncate">{label}</span>
      <div className="flex-1 bg-gray-700 rounded-full h-1.5">
        <div
          className={`${accuracyBg(accuracy)} h-1.5 rounded-full transition-all`}
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      </div>
      <span className={`w-12 text-right font-mono ${accuracyColor(accuracy)}`}>
        {accuracy != null ? `${accuracy.toFixed(0)}%` : '---'}
      </span>
      {detail && <span className="text-gray-500 w-14 text-right">{detail}</span>}
    </div>
  )
}

export default function ScorecardPanel({ scorecard }) {
  if (!scorecard) {
    return (
      <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
        <div className="flex items-center gap-2 mb-3">
          <Target size={16} className="text-purple-400" />
          <h3 className="text-sm font-semibold">Prediction Scorecard</h3>
        </div>
        <div className="text-xs text-gray-500">Waiting for predictions...</div>
      </div>
    )
  }

  const { overall, byWindow, byTimeframe, byIndicator, adaptiveWeights, totalPredictions, totalEvaluated, totalSkipped, contractAware } = scorecard

  const StreakIcon = overall?.streak > 0 ? TrendingUp : overall?.streak < 0 ? TrendingDown : Minus
  const streakColor = overall?.streak > 0 ? 'text-green-400' : overall?.streak < 0 ? 'text-red-400' : 'text-gray-400'

  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <Target size={16} className="text-purple-400" />
        <h3 className="text-sm font-semibold">Prediction Scorecard</h3>
      </div>

      {/* Overall Accuracy */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-1">
          <span className={`text-2xl font-bold font-mono ${accuracyColor(overall?.accuracy)}`}>
            {overall?.accuracy != null ? `${overall.accuracy.toFixed(1)}%` : '---'}
          </span>
          <div className="flex items-center gap-1">
            <StreakIcon size={14} className={streakColor} />
            <span className={`text-xs font-mono ${streakColor}`}>
              {overall?.streak > 0 ? `+${overall.streak}` : overall?.streak ?? 0}
            </span>
          </div>
        </div>
        <div className="w-full bg-gray-700 rounded-full h-2 mb-1">
          <div
            className={`${accuracyBg(overall?.accuracy)} h-2 rounded-full transition-all`}
            style={{ width: `${Math.max(0, Math.min(100, overall?.accuracy ?? 0))}%` }}
          />
        </div>
        <div className="flex justify-between text-xs text-gray-500">
          <span>{totalPredictions} predictions</span>
          <span className="text-green-500">{overall?.correct ?? 0}W</span>
          <span className="text-red-500">{overall?.incorrect ?? 0}L</span>
          <span>{totalSkipped} skip</span>
        </div>
        {(overall?.avgCorrectBps > 0 || overall?.avgIncorrectBps > 0) && (
          <div className="flex justify-between text-xs text-gray-500 mt-0.5">
            <span>Avg win: <span className="text-green-400 font-mono">{overall.avgCorrectBps.toFixed(1)}bp</span></span>
            <span>Avg loss: <span className="text-red-400 font-mono">{overall.avgIncorrectBps.toFixed(1)}bp</span></span>
          </div>
        )}
      </div>

      {/* Contract Accuracy */}
      {contractAware && (
        <div className="mb-4 bg-gray-900 rounded-lg p-2.5">
          <div className="text-xs text-gray-500 mb-1 font-medium">Contract Accuracy</div>
          <div className="flex items-center justify-between">
            <span className={`text-lg font-bold font-mono ${accuracyColor(contractAware.accuracy)}`}>
              {contractAware.accuracy.toFixed(1)}%
            </span>
            <span className="text-xs text-gray-500">
              <span className="text-green-500">{contractAware.wins}W</span>
              {' / '}
              <span className="text-red-500">{contractAware.losses}L</span>
              {' / '}
              {contractAware.total} total
            </span>
          </div>
        </div>
      )}

      {/* Window Accuracy */}
      {totalEvaluated > 0 && (
        <div className="mb-4">
          <div className="text-xs text-gray-500 mb-1.5 font-medium">By Window</div>
          <div className="space-y-1">
            {WINDOW_ORDER.map(w => {
              const data = byWindow?.[w]
              return (
                <AccuracyBar
                  key={w}
                  label={w}
                  accuracy={data?.accuracy}
                  detail={data?.total > 0 ? `${data.correct}/${data.total}` : null}
                />
              )
            })}
          </div>
        </div>
      )}

      {/* Timeframe Accuracy */}
      {totalEvaluated > 0 && (
        <div className="mb-4">
          <div className="text-xs text-gray-500 mb-1.5 font-medium">By Timeframe</div>
          <div className="grid grid-cols-5 gap-1">
            {TF_ORDER.map(tf => {
              const data = byTimeframe?.[tf]
              return (
                <div
                  key={tf}
                  className={`text-center p-1 rounded text-xs ${
                    data?.accuracy == null ? 'bg-gray-700/50 text-gray-600'
                    : data.accuracy >= 60 ? 'bg-green-900/40 text-green-400'
                    : data.accuracy >= 50 ? 'bg-yellow-900/40 text-yellow-400'
                    : 'bg-red-900/40 text-red-400'
                  }`}
                >
                  <div className="font-medium">{tf}</div>
                  <div className="font-mono text-[10px]">
                    {data?.accuracy != null ? `${data.accuracy.toFixed(0)}%` : '---'}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Indicator Accuracy */}
      {totalEvaluated > 0 && (
        <div className="mb-4">
          <div className="text-xs text-gray-500 mb-1.5 font-medium">By Indicator</div>
          <div className="space-y-1">
            {Object.entries(INDICATOR_LABELS).map(([key, label]) => {
              const data = byIndicator?.[key]
              return (
                <AccuracyBar
                  key={key}
                  label={label}
                  accuracy={data?.accuracy}
                  detail={data?.predictions > 0 ? `n=${data.predictions}` : null}
                />
              )
            })}
          </div>
        </div>
      )}

      {/* Adaptive Weights */}
      {adaptiveWeights && totalEvaluated > 0 && (
        <div>
          <div className="text-xs text-gray-500 mb-1.5 font-medium">Adaptive Weights</div>
          <div className="space-y-0.5">
            {Object.entries(INDICATOR_LABELS).map(([key, label]) => {
              const current = adaptiveWeights[key] ?? BASE_WEIGHTS[key]
              const base = BASE_WEIGHTS[key]
              const delta = current - base
              const deltaColor = delta > 0.005 ? 'text-green-400' : delta < -0.005 ? 'text-red-400' : 'text-gray-500'
              return (
                <div key={key} className="flex items-center gap-2 text-xs">
                  <span className="w-16 text-gray-400 truncate">{label}</span>
                  <span className="font-mono text-gray-300 w-10 text-right">{(current * 100).toFixed(1)}%</span>
                  <span className={`font-mono w-12 text-right ${deltaColor}`}>
                    {delta >= 0 ? '+' : ''}{(delta * 100).toFixed(1)}%
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
