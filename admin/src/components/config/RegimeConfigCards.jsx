import { FormInput, FormSelect, SectionCard } from './ConfigFormControls'
import ToggleSwitch from '../ToggleSwitch'
import { TIERS as CELESTIAL_TIERS, formatTierCapitalRange } from '../../../../shared/celestial-tiers.mjs'

export function VolatilityClockCard({ config, regimeConfig, quoteCurrency, handleChange, handleRegimeChange }) {
  return (
    <SectionCard title="Volatility Clock">
      <div className="grid grid-cols-2 gap-3">
        <FormInput label="Product ID" hint="Trading pair (e.g. BTC-USDC)" value={config.productId} onChange={(v) => handleChange('productId', v)} />
        <FormInput label={`Base Size (${quoteCurrency})`} hint="Quote-currency amount per entry order" value={regimeConfig.baseSizeUsdc || 50} onChange={(v) => handleRegimeChange('baseSizeUsdc', v)} type="number" />
        <FormInput label="k Factor (ATR mult)" hint="Higher = longer waits between entries" value={regimeConfig.kFactor || 0.6} onChange={(v) => handleRegimeChange('kFactor', v)} type="number" />
        <FormInput label="ATR Period" hint="# of candles for ATR calculation" value={regimeConfig.atrPeriod || 14} onChange={(v) => handleRegimeChange('atrPeriod', v)} type="number" />
        <FormInput label="Min Interval (ms)" hint="Fastest allowed entry interval" value={regimeConfig.minIntervalMs || 60000} onChange={(v) => handleRegimeChange('minIntervalMs', v)} type="number" />
        <FormInput label="Max Interval (ms)" hint="Slowest entry interval (low-vol cap)" value={regimeConfig.maxIntervalMs || 3600000} onChange={(v) => handleRegimeChange('maxIntervalMs', v)} type="number" />
      </div>
    </SectionCard>
  )
}

export function RegimeScalingCard({ regimeConfig, handleRegimeChange }) {
  return (
    <SectionCard title="Regime Scaling">
      <div className="grid grid-cols-2 gap-3">
        <FormInput label="Harvest Scale" hint="Size multiplier in calm, mean-reverting markets" value={regimeConfig.harvestScale || 1.0} onChange={(v) => handleRegimeChange('harvestScale', v)} type="number" />
        <FormInput label="Caution Scale" hint="Size multiplier during elevated volatility" value={regimeConfig.cautionScale ?? 0.5} onChange={(v) => handleRegimeChange('cautionScale', v)} type="number" />
        <FormInput label="Trend Scale" hint="Size multiplier in strong trends (0 = no entries)" value={regimeConfig.trendScale ?? 0.0} onChange={(v) => handleRegimeChange('trendScale', v)} type="number" />
        <FormInput label="Max Cycle Buys" hint="Max buys per cycle before pausing entries" value={regimeConfig.maxCycleBuys || 10} onChange={(v) => handleRegimeChange('maxCycleBuys', v)} type="number" />
        <FormInput label="Min Order Size ($)" hint="Floor for order size after all multipliers" value={regimeConfig.minOrderSizeUsdc || 5} onChange={(v) => handleRegimeChange('minOrderSizeUsdc', v)} type="number" />
      </div>
      <div className="mt-2 text-xs text-gray-400">
        Scaling: HARVEST={regimeConfig.harvestScale ?? 1.0}x, CAUTION={regimeConfig.cautionScale ?? 0.5}x, TREND={regimeConfig.trendScale ?? 0.0}x base size
      </div>
    </SectionCard>
  )
}

export function EntryModeLadderCard({ regimeConfig, quoteCurrency, handleRegimeChange }) {
  return (
    <SectionCard title="Entry Mode & Ladder" className="lg:col-span-2">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        <FormSelect
          label="Entry Mode"
          hint="Reactive: one order per trigger. Ladder: multiple orders spread across price levels"
          value={regimeConfig.entryMode || 'reactive'}
          onChange={(v) => handleRegimeChange('entryMode', v)}
          options={[
            { value: 'reactive', label: 'Reactive (single order)' },
            { value: 'ladder', label: 'Ladder (pre-positioned)' }
          ]}
        />
        <div className="pt-5">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="ladderAutoSwitch"
              checked={regimeConfig.ladderAutoSwitch || false}
              onChange={(e) => handleRegimeChange('ladderAutoSwitch', e.target.checked)}
              className="w-4 h-4 rounded-sm bg-gray-700 border-gray-600"
            />
            <label htmlFor="ladderAutoSwitch" className="text-sm text-gray-300">Auto-Switch on Vol</label>
          </div>
          <div className="text-2xs text-gray-400 mt-0.5 leading-tight">Switch from reactive to ladder when vol spikes</div>
        </div>
        {regimeConfig.ladderAutoSwitch && (
          <FormInput label="Auto-Switch Vol Mult" hint="Switch to ladder when realized volatility reaches this multiple of its baseline (1.5 = 50% above)" value={regimeConfig.ladderAutoSwitchVolMult || 2.0} onChange={(v) => handleRegimeChange('ladderAutoSwitchVolMult', v)} type="number" />
        )}
      </div>
      {(regimeConfig.entryMode === 'ladder' || regimeConfig.ladderAutoSwitch) && (
        <>
          <div className="bg-indigo-900/20 border border-indigo-700/30 rounded-sm p-3 mb-3">
            <div className="text-xs text-indigo-300">
              <span className="font-medium">Ladder Mode:</span> Deploys all available {quoteCurrency} as limit buy orders from just below current price
              down to an ATH-based floor with Fibonacci-weighted sizing. Orders stay in place during flash events; rebuild only after cycle reset.
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <FormInput label="Max ATH Drop %" hint="Floor = ATH × (1 - this/100). 80 means lowest bid at 20% of ATH" value={regimeConfig.ladderMaxAthDropPct || 80} onChange={(v) => handleRegimeChange('ladderMaxAthDropPct', v)} type="number" />
            <FormInput label="Min Spacing %" hint="Minimum gap between adjacent rungs" value={regimeConfig.ladderMinSpacingPct || 0.5} onChange={(v) => handleRegimeChange('ladderMinSpacingPct', v)} type="number" />
            <FormSelect
              label="Spacing Mode"
              hint="How orders are distributed across the price range"
              value={regimeConfig.ladderSpacingMode || 'sqrt'}
              onChange={(v) => handleRegimeChange('ladderSpacingMode', v)}
              options={[
                { value: 'linear', label: 'Linear (even spacing)' },
                { value: 'sqrt', label: 'Sqrt (denser near top)' },
                { value: 'exponential', label: 'Exponential (denser at bottom)' }
              ]}
            />
            <FormSelect
              label="Size Mode"
              hint="How order sizes scale across the ladder"
              value={regimeConfig.ladderSizeMode || 'fibonacci'}
              onChange={(v) => handleRegimeChange('ladderSizeMode', v)}
              options={[
                { value: 'fibonacci', label: 'Fibonacci (escalating at bottom)' },
                { value: 'flat', label: 'Flat (equal sizes)' },
                { value: 'linear', label: 'Linear (larger at bottom)' },
                { value: 'sqrt', label: 'Sqrt (moderate scaling)' }
              ]}
            />
          </div>
          <div className="mt-2 text-xs text-gray-400">
            Dynamic order count. Floor at {regimeConfig.ladderMaxAthDropPct || 80}% below ATH. {regimeConfig.ladderSizeMode || 'fibonacci'} sizing across all available {quoteCurrency}.
            {regimeConfig.ladderAutoSwitch && ` Auto-switches to ladder when vol expands ${regimeConfig.ladderAutoSwitchVolMult || 2.0}x.`}
          </div>
        </>
      )}
    </SectionCard>
  )
}

export function TakeProfitCard({ regimeConfig, baseCurrency, handleRegimeChange }) {
  return (
    <SectionCard title="Take-Profit">
      <div className="grid grid-cols-2 gap-3">
        <FormInput label="TP Multiplier" hint="ATR-based TP scaling factor" value={regimeConfig.tpMult || 1.0} onChange={(v) => handleRegimeChange('tpMult', v)} type="number" />
        <FormInput label="TP Min %" hint="Floor for take-profit percentage" value={regimeConfig.tpMinPercent || 2.0} onChange={(v) => handleRegimeChange('tpMinPercent', v)} type="number" />
        <FormInput label="TP Max %" hint="Ceiling for take-profit percentage" value={regimeConfig.tpMaxPercent || 15.0} onChange={(v) => handleRegimeChange('tpMaxPercent', v)} type="number" />
        <FormInput label="Holdback Ratio" hint="Base share of gross TP profit allocated to retained asset (0-1)" value={regimeConfig.holdbackRatio ?? 0.5} onChange={(v) => handleRegimeChange('holdbackRatio', v)} type="number" />
      </div>
      <div className="mt-2 text-xs text-gray-400">
        Base allocation: <span className="text-white font-medium">{((regimeConfig.holdbackRatio ?? 0.5) * 100).toFixed(0)}%</span> of gross TP profit to retained {baseCurrency}, valued at the target price.
        {' '}The body tier multiplies this ratio; the effective profit share is capped at 95%.
        {' '}Example: 0.01 BTC at $100,000/BTC targeting $110,000/BTC, with ratio 0.5 and tier scale 1, has $100 gross profit. Allocating $50 to retained BTC leaves about 0.00045455 BTC (4.55% of the position), with about 0.00954545 BTC to sell.
        {' '}This example excludes fees and rounds quantities to eight decimals. Actual placement also applies quantity rounding, a minimum holdback, fee floors and exchange minimums; net returns are not guaranteed.
      </div>
    </SectionCard>
  )
}

export function RegimeDetectionCard({ regimeConfig, handleRegimeChange }) {
  return (
    <SectionCard title="Regime Detection">
      <div className="grid grid-cols-2 gap-3">
        <FormInput label="Momentum Mult" hint="VWAP divergence threshold (×10 bps)" value={regimeConfig.momentumMult || 1.5} onChange={(v) => handleRegimeChange('momentumMult', v)} type="number" />
        <FormInput label="Vol Expansion" hint="realizedVol/baseline ratio to enter CAUTION" value={regimeConfig.volExpansionMult || 1.5} onChange={(v) => handleRegimeChange('volExpansionMult', v)} type="number" />
        <FormInput label="Vol Contraction" hint="realizedVol/baseline ratio to return to HARVEST" value={regimeConfig.volContractionMult || 1.2} onChange={(v) => handleRegimeChange('volContractionMult', v)} type="number" />
        <FormInput label="VWAP Hours" hint="Rolling window for VWAP calculation" value={regimeConfig.vwapPeriodHours || 4} onChange={(v) => handleRegimeChange('vwapPeriodHours', v)} type="number" />
        <FormInput label="Trend Confirm Periods" hint="Consecutive momentum periods to confirm TREND" value={regimeConfig.trendConfirmationPeriods || 5} onChange={(v) => handleRegimeChange('trendConfirmationPeriods', v)} type="number" />
      </div>
    </SectionCard>
  )
}

export function CelestialHierarchyCard({ regimeConfig, baseCurrency, handleRegimeChange }) {
  return (
    <SectionCard title="Celestial Hierarchy" className="lg:col-span-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-3">
        <ToggleSwitch
          label="Enable Celestial Bodies"
          checked={regimeConfig.celestialEnabled !== false}
          onChange={() => handleRegimeChange('celestialEnabled', !(regimeConfig.celestialEnabled !== false))}
        />
        {regimeConfig.celestialEnabled !== false && (
          <span className="text-xs text-cyan-400">
            Buys become celestial bodies that consolidate and promote through tiers
          </span>
        )}
      </div>
      {regimeConfig.celestialEnabled !== false && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <FormInput label="Max Celestial Bodies" hint="Max concurrent body TP orders (1-1000)" value={regimeConfig.maxCelestialBodies ?? 10} onChange={(v) => handleRegimeChange('maxCelestialBodies', Math.round(v))} type="number" />
            <FormInput label="Merge Proximity Scale" hint="How aggressively bodies merge (0.25=conservative, 1.0=default, 3.0=aggressive)" value={regimeConfig.mergeProximityScale ?? 1.0} onChange={(v) => handleRegimeChange('mergeProximityScale', Math.max(0.25, Math.min(3.0, Math.round(v * 100) / 100)))} type="number" />
          </div>
          <div className="mt-2 text-xs text-gray-400">
            Each buy creates a celestial body. Bodies merge when TP prices are close, and promote to higher tiers as mass grows.
            Tiers: {CELESTIAL_TIERS.map(t => `${t.emoji} ${t.label.toLowerCase()}`).join(' → ')}.
            Higher tiers have wider TP targets and hold more {baseCurrency}.
          </div>
          <div className="mt-2 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-9 gap-1 text-xs text-center">
            {CELESTIAL_TIERS.map(tier => (
              <div key={tier.name} className="bg-gray-800/50 rounded-sm p-1">
                <div>{tier.emoji}</div>
                <div className="text-gray-400">{tier.label}</div>
                <div className="text-gray-400">{formatTierCapitalRange(tier, regimeConfig.maxUsdcDeployed || 10000)}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </SectionCard>
  )
}

export function MacroRegimeCard({ regimeConfig, handleRegimeChange }) {
  return (
    <SectionCard title="Macro Regime (Multi-Timeframe)" className="lg:col-span-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-3">
        <ToggleSwitch
          label="Enable Macro Regime"
          checked={Boolean(regimeConfig.macroEnabled)}
          onChange={() => handleRegimeChange('macroEnabled', !regimeConfig.macroEnabled)}
        />
        {regimeConfig.macroEnabled && (
          <span className="text-xs text-cyan-400">
            Hourly + daily EMA overlay modulates sizing, TP, and entry offset
          </span>
        )}
      </div>
      {regimeConfig.macroEnabled && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
            <FormInput label="Update Interval (ms)" hint="How often to re-score macro (60000-600000)" value={regimeConfig.macroUpdateIntervalMs ?? 300000} onChange={(v) => handleRegimeChange('macroUpdateIntervalMs', v)} type="number" />
            <FormInput label="Suggestion Delay (hours)" hint="Stable long-term bias divergence before an advisory (0.01–720). Never changes sizing automatically." value={regimeConfig.aggressivenessSuggestionHours ?? 6} onChange={(v) => handleRegimeChange('aggressivenessSuggestionHours', v)} type="number" />
            <FormInput label="Hysteresis" hint="Score buffer to prevent mode chatter (1-20)" value={regimeConfig.macroHysteresis ?? 5} onChange={(v) => handleRegimeChange('macroHysteresis', v)} type="number" />
            <FormInput label="Accumulation Threshold" hint="Score below this = ACCUMULATION" value={regimeConfig.macroAccumulationThreshold ?? -15} onChange={(v) => handleRegimeChange('macroAccumulationThreshold', v)} type="number" />
            <FormInput label="Decline Threshold" hint="Score below this = DECLINE" value={regimeConfig.macroDeclineThreshold ?? -50} onChange={(v) => handleRegimeChange('macroDeclineThreshold', v)} type="number" />
            <FormInput label="Markup Threshold" hint="Score above this = MARKUP" value={regimeConfig.macroMarkupThreshold ?? 35} onChange={(v) => handleRegimeChange('macroMarkupThreshold', v)} type="number" />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <div className="bg-green-900/15 border border-green-800/30 rounded-sm p-3">
              <div className="text-xs text-green-400 font-medium mb-2">Accumulation (buying dips harder)</div>
              <div className="grid grid-cols-3 gap-2">
                <FormInput label="Size" hint="0.1-3.0" value={regimeConfig.macroAccumulationSizeMult ?? 1.3} onChange={(v) => handleRegimeChange('macroAccumulationSizeMult', v)} type="number" />
                <FormInput label="TP" hint="Tighter" value={regimeConfig.macroAccumulationTpMult ?? 0.85} onChange={(v) => handleRegimeChange('macroAccumulationTpMult', v)} type="number" />
                <FormInput label="Offset" hint="Tighter" value={regimeConfig.macroAccumulationOffsetMult ?? 0.8} onChange={(v) => handleRegimeChange('macroAccumulationOffsetMult', v)} type="number" />
              </div>
            </div>
            <div className="bg-yellow-900/15 border border-yellow-800/30 rounded-sm p-3">
              <div className="text-xs text-yellow-400 font-medium mb-2">Markup (uptrend — reduce exposure)</div>
              <div className="grid grid-cols-3 gap-2">
                <FormInput label="Size" hint="0.1-3.0" value={regimeConfig.macroMarkupSizeMult ?? 0.7} onChange={(v) => handleRegimeChange('macroMarkupSizeMult', v)} type="number" />
                <FormInput label="TP" hint="Wider" value={regimeConfig.macroMarkupTpMult ?? 1.3} onChange={(v) => handleRegimeChange('macroMarkupTpMult', v)} type="number" />
                <FormInput label="Offset" hint="Wider" value={regimeConfig.macroMarkupOffsetMult ?? 1.2} onChange={(v) => handleRegimeChange('macroMarkupOffsetMult', v)} type="number" />
              </div>
            </div>
            <div className="bg-red-900/15 border border-red-800/30 rounded-sm p-3">
              <div className="text-xs text-red-400 font-medium mb-2">Decline (capitulation — conservative)</div>
              <div className="grid grid-cols-3 gap-2">
                <FormInput label="Size" hint="0.1-3.0" value={regimeConfig.macroDeclineSizeMult ?? 0.4} onChange={(v) => handleRegimeChange('macroDeclineSizeMult', v)} type="number" />
                <FormInput label="TP" hint="Tighter" value={regimeConfig.macroDeclineTpMult ?? 0.7} onChange={(v) => handleRegimeChange('macroDeclineTpMult', v)} type="number" />
                <FormInput label="Offset" hint="Wider" value={regimeConfig.macroDeclineOffsetMult ?? 1.5} onChange={(v) => handleRegimeChange('macroDeclineOffsetMult', v)} type="number" />
              </div>
            </div>
          </div>
          <div className="mt-2 text-xs text-gray-400">
            RANGING mode uses 1.0x for all multipliers (passthrough). Score range: -100 to +100. Thresholds must be ordered: decline &lt; accumulation &lt; markup.
          </div>
        </>
      )}
    </SectionCard>
  )
}

export function TpAutoManagementCard({ regimeConfig, handleRegimeChange }) {
  return (
    <SectionCard title="TP Auto-Management" className="lg:col-span-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-3">
        <ToggleSwitch
          label="Enable Auto-Management"
          checked={Boolean(regimeConfig.tpAutoManaged)}
          onChange={() => handleRegimeChange('tpAutoManaged', !regimeConfig.tpAutoManaged)}
        />
        {regimeConfig.tpAutoManaged && (
          <span className="text-xs text-cyan-400">
            TP values will be dynamically adjusted based on observed cycle data
          </span>
        )}
      </div>
      {regimeConfig.tpAutoManaged && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <FormInput label="Evaluation Cycles" hint="Re-evaluate TP after this many completed cycles" value={regimeConfig.tpEvaluationCycles || 5} onChange={(v) => handleRegimeChange('tpEvaluationCycles', v)} type="number" />
            <FormInput label="Eval Max Hours" hint="Max hours before forcing TP re-evaluation" value={regimeConfig.tpEvaluationMaxHours || 24} onChange={(v) => handleRegimeChange('tpEvaluationMaxHours', v)} type="number" />
            <FormInput label="Min Sample Size" hint="Min fills needed before first auto-adjust" value={regimeConfig.tpMinSampleSize || 10} onChange={(v) => handleRegimeChange('tpMinSampleSize', v)} type="number" />
            <FormInput label="Max Change %" hint="Max single adjustment to TP values" value={regimeConfig.tpMaxChangePercent || 25} onChange={(v) => handleRegimeChange('tpMaxChangePercent', v)} type="number" />
            <FormInput label="TP Absolute Min %" hint="Hard floor: TP can never go below this" value={regimeConfig.tpAbsoluteMin || 0.05} onChange={(v) => handleRegimeChange('tpAbsoluteMin', v)} type="number" />
            <FormInput label="TP Absolute Max %" hint="Hard ceiling: TP can never go above this" value={regimeConfig.tpAbsoluteMax || 5.0} onChange={(v) => handleRegimeChange('tpAbsoluteMax', v)} type="number" />
          </div>
          <div className="mt-2 text-xs text-gray-400">
            Auto-adjusts TP range every {regimeConfig.tpEvaluationCycles || 5} cycles or {regimeConfig.tpEvaluationMaxHours || 24}h.
            Requires {regimeConfig.tpMinSampleSize || 10} samples before first adjustment.
            Holdback auto-set to half of TP Min.
          </div>
        </>
      )}
    </SectionCard>
  )
}

export function RiskCapsCard({ regimeConfig, baseCurrency, quoteCurrency, handleRegimeChange }) {
  return (
    <SectionCard title="Risk Caps">
      <div className="grid grid-cols-2 gap-3">
        <FormInput label="Deposited Capital" hint="Your actual cash deposits (0 = auto-derive)" value={regimeConfig.depositedCapital || 0} onChange={(v) => handleRegimeChange('depositedCapital', v)} type="number" />
        <FormInput label={`Max ${baseCurrency} Exposure`} hint={`Max ${baseCurrency} the engine can hold (0 = uncapped)`} value={regimeConfig.maxAssetExposure ?? 0} onChange={(v) => handleRegimeChange('maxAssetExposure', v)} type="number" />
        <FormInput label={`Max Deployed (${quoteCurrency})`} hint={`Max ${quoteCurrency} deployed across active orders`} value={regimeConfig.maxUsdcDeployed || 10000} onChange={(v) => handleRegimeChange('maxUsdcDeployed', v)} type="number" />
        <FormInput label="Max Drawdown %" hint="Pause new buys when fund equity (capital + realized + held coins at market) falls this % below its peak" value={regimeConfig.maxDrawdownPercent || 20} onChange={(v) => handleRegimeChange('maxDrawdownPercent', v)} type="number" />
        <FormInput label="Liquidity Factor Cap" hint="Max size multiplier from orderbook liquidity" value={regimeConfig.liquidityFactorCap || 2.0} onChange={(v) => handleRegimeChange('liquidityFactorCap', v)} type="number" />
        <FormInput label="Drawdown Reset (hrs)" hint="Hours at drawdown cap before auto-resuming (0 = off)" value={regimeConfig.drawdownResetHours ?? 72} onChange={(v) => handleRegimeChange('drawdownResetHours', v)} type="number" />
        <FormInput label="Cycle Reset (hrs)" hint="Hours at cycle buys limit before auto-resetting (0 = off)" value={regimeConfig.cycleResetHours ?? 72} onChange={(v) => handleRegimeChange('cycleResetHours', v)} type="number" />
      </div>
      <div className="mt-2 text-xs text-gray-400">
        Auto-reset hours: 0 = disabled. After this time at a limit, the engine resumes with reset counters.
      </div>
    </SectionCard>
  )
}

export function OrderExecutionCard({ regimeConfig, handleRegimeChange }) {
  return (
    <SectionCard title="Order Execution">
      <div className="grid grid-cols-2 gap-3">
        <FormInput label="Entry Offset (bps)" hint="Place limit buy this many bps below market" value={regimeConfig.entryOffsetBps ?? 10} onChange={(v) => handleRegimeChange('entryOffsetBps', v)} type="number" />
        <FormInput label="Entry Offset Up (bps)" hint="Offset when momentum is UP (tighter to fill before rise)" value={regimeConfig.entryOffsetUpBps ?? 5} onChange={(v) => handleRegimeChange('entryOffsetUpBps', v)} type="number" />
        <FormInput label="Entry Offset Down (bps)" hint="Offset when momentum is DOWN (deeper to catch the dip)" value={regimeConfig.entryOffsetDownBps ?? 15} onChange={(v) => handleRegimeChange('entryOffsetDownBps', v)} type="number" />
        <FormInput label="Entry Max Retries" hint="Retry cancelled entries up to this many times" value={regimeConfig.entryMaxRetries || 3} onChange={(v) => handleRegimeChange('entryMaxRetries', v)} type="number" />
        <FormInput label="Order Stale Floor (ms)" hint="Min entry timeout; actual scales with offset²/ATR², capped at Max Interval" value={regimeConfig.orderStaleMs || 30000} onChange={(v) => handleRegimeChange('orderStaleMs', v)} type="number" />
        <FormInput label="Cancel Rate Limit (ms)" hint="Min wait between cancel API calls" value={regimeConfig.cancelRateLimitMs || 1000} onChange={(v) => handleRegimeChange('cancelRateLimitMs', v)} type="number" />
        <FormInput label="Max Open Orders" hint="Max simultaneous entry orders allowed" value={regimeConfig.maxOpenOrders || 3} onChange={(v) => handleRegimeChange('maxOpenOrders', v)} type="number" />
        <FormInput label="TP Update Threshold %" hint="Min price change before updating TP order" value={regimeConfig.tpUpdateThresholdPct || 0.5} onChange={(v) => handleRegimeChange('tpUpdateThresholdPct', v)} type="number" />
        <FormInput label="Reconcile Interval (ms)" hint="How often to sync local state with exchange" value={regimeConfig.reconcileIntervalMs || 300000} onChange={(v) => handleRegimeChange('reconcileIntervalMs', v)} type="number" />
      </div>
    </SectionCard>
  )
}

export function SafetyTailEventsCard({ regimeConfig, handleRegimeChange }) {
  return (
    <SectionCard title="Safety & Tail Events">
      <p className="text-xs text-gray-400 mb-3">
        Depth-based entry protection is unavailable in this build.
      </p>
      {regimeConfig.entryMode === 'ladder' ? (
        <div className="text-xs text-gray-400 italic">
          These settings apply to Reactive mode only. Ladder mode bypasses tail event checks — the ladder IS the flash event strategy.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <FormInput label="Max Spread (bps)" hint="Pause entries when bid-ask spread exceeds this" value={regimeConfig.maxSpreadBps || 50} onChange={(v) => handleRegimeChange('maxSpreadBps', v)} type="number" />
            <FormInput label="Spread Pause (ms)" hint="How long to pause after spread breach" value={regimeConfig.spreadPauseMs || 300000} onChange={(v) => handleRegimeChange('spreadPauseMs', v)} type="number" />
            <FormInput label="Flash Move Mult" hint="ATR multiplier to detect flash crashes" value={regimeConfig.flashMoveMult || 3.0} onChange={(v) => handleRegimeChange('flashMoveMult', v)} type="number" />
            <FormInput label="Flash Cooldown (ms)" hint="Pause duration after flash event detected" value={regimeConfig.flashCooldownMs || 600000} onChange={(v) => handleRegimeChange('flashCooldownMs', v)} type="number" />
          </div>
          <div className="mt-3">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="cancelEntriesOnFlash"
                checked={regimeConfig.cancelEntriesOnFlash !== false}
                onChange={(e) => handleRegimeChange('cancelEntriesOnFlash', e.target.checked)}
                className="w-4 h-4 rounded-sm bg-gray-700 border-gray-600"
              />
              <label htmlFor="cancelEntriesOnFlash" className="text-sm text-gray-300">Cancel Entries on Flash</label>
            </div>
            <div className="text-2xs text-gray-400 mt-0.5 leading-tight">Pull all pending entries during flash events</div>
          </div>
        </>
      )}
    </SectionCard>
  )
}

export function SystemHealthCard({ regimeConfig, handleRegimeChange }) {
  return (
    <SectionCard title="System Health">
      <div className="grid grid-cols-2 gap-3">
        <FormInput label="Stale Data (ms)" hint="Enter SAFE mode if no ticker data for this long" value={regimeConfig.staleDataMs || 30000} onChange={(v) => handleRegimeChange('staleDataMs', v)} type="number" />
        <FormInput label="Stale Orders (ms)" hint="Flag orders as stale after this duration" value={regimeConfig.staleOrdersMs || 60000} onChange={(v) => handleRegimeChange('staleOrdersMs', v)} type="number" />
        <FormInput label="Max Latency (ms)" hint="Enter SAFE mode if API latency exceeds this" value={regimeConfig.maxLatencyMs || 5000} onChange={(v) => handleRegimeChange('maxLatencyMs', v)} type="number" />
        <FormInput label="Safe Recovery (ms)" hint="Time healthy before exiting SAFE mode" value={regimeConfig.safeRecoveryMs || 60000} onChange={(v) => handleRegimeChange('safeRecoveryMs', v)} type="number" />
        <FormInput label="Max REST Errors" hint="Consecutive API errors before SAFE mode" value={regimeConfig.maxRestErrors || 5} onChange={(v) => handleRegimeChange('maxRestErrors', v)} type="number" />
        <FormInput label="Max Rate Limits" hint="Consecutive rate limits before SAFE mode" value={regimeConfig.maxRateLimits || 3} onChange={(v) => handleRegimeChange('maxRateLimits', v)} type="number" />
      </div>
      <div className="mt-2 text-xs text-gray-400">
        System enters SAFE mode when health thresholds are exceeded. Safe Recovery is time healthy before exiting SAFE.
      </div>
    </SectionCard>
  )
}
