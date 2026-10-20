import React from 'react'
import InfoTooltip from '../InfoTooltip'

export const CONFIG_TOOLTIPS = {
  baseSize: 'Base quote-currency amount per buy order. When "Auto", dynamically adjusted based on available balance and position sizing rules',
  kFactor: 'ATR multiplier controlling trigger sensitivity. Lower = more frequent trades on smaller moves. Higher = fewer trades, only on larger price swings',
  minInterval: 'Minimum wait time between consecutive buy orders to prevent over-trading during rapid price movement',
  maxInterval: 'Maximum time before placing another buy, even without a strong trigger signal',
  tpRange: 'Take-profit target range. Sell orders are placed within this band above cost basis. "Auto" adjusts based on volatility',
  entryOffset: 'Basis points below mid-price for limit buy entry. Higher values target a deeper discount but may fill less often',
  cautionScale: 'Scales down order size during high-volatility regimes. Lower values = more cautious sizing when markets are volatile',
  trendScale: 'Adjusts buy aggression based on trend strength. Lower values reduce buying into strong downtrends',
  maxCycleBuys: 'Maximum buy orders in a single accumulation cycle before the bot waits for corresponding sells to complete',
}

// Tooltip descriptions for the regime/entry status panels
export const REGIME_TOOLTIPS = {
  micro: (
    <>
      <div className="font-semibold text-gray-200 mb-1">Micro Regime</div>
      <div className="mb-1">Short-term market state derived from 1m ATR, realized volatility vs baseline, and VWAP distance.</div>
      <div><span className="text-green-400">HARVEST</span>: calm / mean-reverting → full sizing (1.0x). The <em>most aggressive</em> buy/sell cycling mode — &quot;harvest&quot; refers to harvesting micro cycles, NOT selling out.</div>
      <div><span className="text-yellow-400">CAUTION</span>: volatility expanding → sizing scaled by <code>cautionScale</code>.</div>
      <div><span className="text-red-400">TREND</span>: strong directional move → entries blocked unless <code>trendScale &gt; 0</code>.</div>
    </>
  ),
  macro: (
    <>
      <div className="font-semibold text-gray-200 mb-1">Macro Regime</div>
      <div className="mb-1">Multi-day trend context from 21h/50h/200h hourly EMAs + 20d daily EMA. Lookback maxes at ~200 hours / 20 days — the bot has no concept of multi-month or yearly cycles.</div>
      <div><span className="text-blue-400">ACCUMULATION</span>: price stacked below EMAs → 1.3x size, tighter TP, smaller offset.</div>
      <div><span className="text-gray-400">RANGING</span>: neutral → no modulation (1.0x / 1.0x / 1.0x).</div>
      <div><span className="text-green-400">MARKUP</span>: confirmed uptrend → 0.7x size, wider TP.</div>
      <div><span className="text-red-400">DECLINE</span>: confirmed downtrend → 0.4x size, tighter TP, wider offset.</div>
    </>
  ),
  entryStatus: (
    <>
      <div className="font-semibold text-gray-200 mb-1">Entry Status</div>
      <div>Gates that must pass for the bot to place a buy order:</div>
      <div className="mt-1">• <strong>Health</strong>: Ready / Safe / Paused / Stopped</div>
      <div>• <strong>Regime</strong>: Allowed unless micro regime is TREND</div>
      <div>• <strong>Celestial bodies</strong>: open-position capacity by tier (Sun / Planet / Asteroid)</div>
      <div>• <strong>Macro</strong>: long-term trend indicator (informational unless macro multipliers are non-zero)</div>
    </>
  ),
  entryMode: (
    <>
      <div className="font-semibold text-gray-200 mb-1">Entry Mode</div>
      <div><span className="text-gray-300">REACTIVE</span>: single buy order placed when the ATR trigger fires. Best for low-volatility / mean-reverting conditions.</div>
      <div className="mt-1"><span className="text-indigo-400">LADDER</span>: multiple pre-positioned buy orders descending from current price. Auto-activates when volatility expansion exceeds <code>ladderAutoSwitchVolMult</code> (default 2.0x).</div>
    </>
  ),
}

// Info icon + help popup for config labels
export function ConfigTooltip({ tip, align = 'center', width = 'w-52' }) {
  return <InfoTooltip tip={tip} align={align} width={width} label="Show help" />
}
export const LONG_TERM_BIAS_TOOLTIP = (
  <>
    <div className="font-semibold text-gray-200 mb-1">Long-Term Bias (Depression Score)</div>
    <div className="mb-1">Composite signal of how cheap an asset is relative to its trailing window. <strong>Phase 2 — advisory.</strong> Sizing is unchanged until you click <em>Apply Suggested</em>.</div>
    <div>• <strong>Percentile of range</strong> (60% weight): position in trailing high/low. 1.0 = at the period low.</div>
    <div>• <strong>Drawdown</strong> (30%): % below trailing high. Maps 80% drawdown → 1.0.</div>
    <div>• <strong>Z-score</strong> (10%): standard deviations below the trailing mean.</div>
    <div className="mt-1">When &quot;Suggested&quot; diverges from &quot;Current&quot;, an <em>Apply Suggested</em> button appears so you can adopt the recommendation with one click. See PLAN.md → Auto-Aggressiveness Roadmap.</div>
  </>
)
