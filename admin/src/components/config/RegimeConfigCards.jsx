import { DurationInput, FormInput, FormSelect, SectionCard } from './ConfigFormControls'
import DisclosureCard from './DisclosureCard'
import { fieldValue } from '../../utils/regimeFieldValue.mjs'
import ToggleSwitch from '../ToggleSwitch'
import { TIERS as CELESTIAL_TIERS, formatTierCapitalRange } from '../../../../shared/celestial-tiers.mjs'

export function VolatilityClockCard({ config, regimeConfig, quoteCurrency, handleChange, defaults, handleRegimeChange, productIdLocked = false }) {
  const fv = (key) => fieldValue(regimeConfig, defaults, key)
  return (
    <SectionCard title="Volatility Clock">
      <div className="grid grid-cols-2 gap-3">
        <FormInput label="Product ID" hint={productIdLocked ? 'Fixed for an existing fund; create a new fund to trade another pair' : 'Trading pair (e.g. BTC-USDC)'} value={config.productId} onChange={(v) => handleChange('productId', v)} readOnly={productIdLocked} />
        <FormInput label={`Base Size (${quoteCurrency})`} hint="Quote-currency amount per entry order" value={fv('baseSizeUsdc')} onChange={(v) => handleRegimeChange('baseSizeUsdc', v)} type="number" />
        <FormInput label="k Factor (ATR mult)" hint="Higher = longer waits between entries" value={fv('kFactor')} onChange={(v) => handleRegimeChange('kFactor', v)} type="number" />
        <FormInput label="ATR Period" hint="# of candles for ATR calculation" value={fv('atrPeriod')} onChange={(v) => handleRegimeChange('atrPeriod', v)} type="number" />
        <DurationInput label="Min Interval" hint="Fastest allowed entry interval" value={fv('minIntervalMs')} onChange={(v) => handleRegimeChange('minIntervalMs', v)} />
        <DurationInput label="Max Interval" hint="Slowest entry interval (low-vol cap)" value={fv('maxIntervalMs')} onChange={(v) => handleRegimeChange('maxIntervalMs', v)} />
      </div>
    </SectionCard>
  )
}

export function RegimeScalingCard({ regimeConfig, defaults, handleRegimeChange }) {
  const fv = (key) => fieldValue(regimeConfig, defaults, key)
  return (
    <SectionCard title="Regime Scaling">
      <div className="grid grid-cols-2 gap-3">
        <FormInput label="Harvest Scale" hint="Size multiplier in calm, mean-reverting markets" value={fv('harvestScale')} onChange={(v) => handleRegimeChange('harvestScale', v)} type="number" />
        <FormInput label="Caution Scale" hint="Size multiplier during elevated volatility" value={fv('cautionScale')} onChange={(v) => handleRegimeChange('cautionScale', v)} type="number" />
        <FormInput label="Trend Scale" hint="Size multiplier in strong trends (0 = no entries)" value={fv('trendScale')} onChange={(v) => handleRegimeChange('trendScale', v)} type="number" />
        <FormInput label="Max Cycle Buys" hint="Max buys per cycle before pausing entries" value={fv('maxCycleBuys')} onChange={(v) => handleRegimeChange('maxCycleBuys', v)} type="number" />
        <FormInput label="Min Order Size ($)" hint="Floor for order size after all multipliers" value={fv('minOrderSizeUsdc')} onChange={(v) => handleRegimeChange('minOrderSizeUsdc', v)} type="number" />
      </div>
      <div className="mt-2 text-xs text-gray-400">
        Scaling: HARVEST={fv('harvestScale')}x, CAUTION={fv('cautionScale')}x, TREND={fv('trendScale')}x base size
      </div>
    </SectionCard>
  )
}

export function EntryModeLadderCard({ regimeConfig, quoteCurrency, defaults, handleRegimeChange }) {
  const fv = (key) => fieldValue(regimeConfig, defaults, key)
  return (
    <SectionCard title="Entry Mode & Ladder" className="lg:col-span-2">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        <FormSelect
          label="Entry Mode"
          hint="Reactive: one order per trigger. Ladder: multiple orders spread across price levels"
          value={fv('entryMode')}
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
              checked={fv('ladderAutoSwitch')}
              onChange={(e) => handleRegimeChange('ladderAutoSwitch', e.target.checked)}
              className="w-4 h-4 rounded-sm bg-gray-700 border-gray-600"
            />
            <label htmlFor="ladderAutoSwitch" className="text-sm text-gray-300">Auto-Switch on Vol</label>
          </div>
          <div className="text-2xs text-gray-400 mt-0.5 leading-tight">Switch from reactive to ladder when vol spikes</div>
        </div>
        {regimeConfig.ladderAutoSwitch && (
          <FormInput label="Auto-Switch Vol Mult" hint="Switch to ladder when realized volatility reaches this multiple of its baseline (1.5 = 50% above)" value={fv('ladderAutoSwitchVolMult')} onChange={(v) => handleRegimeChange('ladderAutoSwitchVolMult', v)} type="number" />
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
            <FormInput label="Max ATH Drop %" hint="Floor = ATH × (1 - this/100). 80 means lowest bid at 20% of ATH" value={fv('ladderMaxAthDropPct')} onChange={(v) => handleRegimeChange('ladderMaxAthDropPct', v)} type="number" />
            <FormInput label="Min Spacing %" hint="Minimum gap between adjacent rungs" value={fv('ladderMinSpacingPct')} onChange={(v) => handleRegimeChange('ladderMinSpacingPct', v)} type="number" />
            <FormSelect
              label="Spacing Mode"
              hint="How orders are distributed across the price range"
              value={fv('ladderSpacingMode')}
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
              value={fv('ladderSizeMode')}
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
            Dynamic order count. Floor at {fv('ladderMaxAthDropPct')}% below ATH. {fv('ladderSizeMode')} sizing across all available {quoteCurrency}.
            {regimeConfig.ladderAutoSwitch && ` Auto-switches to ladder when vol expands ${fv('ladderAutoSwitchVolMult')}x.`}
          </div>
        </>
      )}
    </SectionCard>
  )
}

export function TakeProfitCard({ regimeConfig, baseCurrency, defaults, handleRegimeChange }) {
  const fv = (key) => fieldValue(regimeConfig, defaults, key)
  return (
    <SectionCard title="Take-Profit">
      <div className="grid grid-cols-2 gap-3">
        <FormInput label="TP Multiplier" hint="ATR-based TP scaling factor" value={fv('tpMult')} onChange={(v) => handleRegimeChange('tpMult', v)} type="number" />
        <FormInput label="TP Min %" hint="Floor for take-profit percentage" value={fv('tpMinPercent')} onChange={(v) => handleRegimeChange('tpMinPercent', v)} type="number" />
        <FormInput label="TP Max %" hint="Ceiling for take-profit percentage" value={fv('tpMaxPercent')} onChange={(v) => handleRegimeChange('tpMaxPercent', v)} type="number" />
        <FormInput label="Holdback Ratio" hint="Base share of gross TP profit allocated to retained asset (0-1)" value={fv('holdbackRatio')} onChange={(v) => handleRegimeChange('holdbackRatio', v)} type="number" />
      </div>
      <div className="mt-2 text-xs text-gray-400">
        Base allocation: <span className="text-white font-medium">{((fv('holdbackRatio')) * 100).toFixed(0)}%</span> of gross TP profit to retained {baseCurrency}, valued at the target price.
        {' '}The body tier multiplies this ratio; the effective profit share is capped at 95%.
        {' '}Example: 0.01 BTC at $100,000/BTC targeting $110,000/BTC, with ratio 0.5 and tier scale 1, has $100 gross profit. Allocating $50 to retained BTC leaves about 0.00045455 BTC (4.55% of the position), with about 0.00954545 BTC to sell.
        {' '}This example excludes fees and rounds quantities to eight decimals. Actual placement also applies quantity rounding, a minimum holdback, fee floors and exchange minimums; net returns are not guaranteed.
      </div>
    </SectionCard>
  )
}

export function RegimeDetectionCard({ regimeConfig, defaults, handleRegimeChange, disclosure }) {
  const fv = (key) => fieldValue(regimeConfig, defaults, key)
  return (
    <DisclosureCard cardId="regimeDetection" title="Regime Detection" disclosure={disclosure}>
      <div className="grid grid-cols-2 gap-3">
        <FormInput label="Momentum Mult" hint="VWAP divergence threshold (×10 bps)" value={fv('momentumMult')} onChange={(v) => handleRegimeChange('momentumMult', v)} type="number" />
        <FormInput label="Vol Expansion" hint="realizedVol/baseline ratio to enter CAUTION" value={fv('volExpansionMult')} onChange={(v) => handleRegimeChange('volExpansionMult', v)} type="number" />
        <FormInput label="Vol Contraction" hint="realizedVol/baseline ratio to return to HARVEST" value={fv('volContractionMult')} onChange={(v) => handleRegimeChange('volContractionMult', v)} type="number" />
        <FormInput label="VWAP Hours" hint="Rolling window for VWAP calculation" value={fv('vwapPeriodHours')} onChange={(v) => handleRegimeChange('vwapPeriodHours', v)} type="number" />
        <FormInput label="Trend Confirm Periods" hint="Consecutive momentum periods to confirm TREND" value={fv('trendConfirmationPeriods')} onChange={(v) => handleRegimeChange('trendConfirmationPeriods', v)} type="number" />
      </div>
    </DisclosureCard>
  )
}

export function CelestialHierarchyCard({ regimeConfig, baseCurrency, defaults, handleRegimeChange }) {
  const fv = (key) => fieldValue(regimeConfig, defaults, key)
  return (
    <SectionCard title="Celestial Hierarchy" className="lg:col-span-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-3">
        <ToggleSwitch
          label="Enable Celestial Bodies"
          checked={fv('celestialEnabled')}
          onChange={() => handleRegimeChange('celestialEnabled', !fv('celestialEnabled'))}
        />
        {fv('celestialEnabled') && (
          <span className="text-xs text-cyan-400">
            Buys become celestial bodies that consolidate and promote through tiers
          </span>
        )}
      </div>
      {fv('celestialEnabled') && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <FormInput label="Max Celestial Bodies" hint="Max concurrent body TP orders (1-1000)" value={fv('maxCelestialBodies')} onChange={(v) => handleRegimeChange('maxCelestialBodies', Math.round(v))} type="number" />
            <FormInput label="Merge Proximity Scale" hint="How aggressively bodies merge (0.25=conservative, 1.0=default, 3.0=aggressive)" value={fv('mergeProximityScale')} onChange={(v) => handleRegimeChange('mergeProximityScale', Math.max(0.25, Math.min(3.0, Math.round(v * 100) / 100)))} type="number" />
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
                <div className="text-gray-400">{formatTierCapitalRange(tier, fv('maxUsdcDeployed'))}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </SectionCard>
  )
}

export function MacroRegimeCard({ regimeConfig, defaults, handleRegimeChange, disclosure }) {
  const fv = (key) => fieldValue(regimeConfig, defaults, key)
  return (
    <DisclosureCard cardId="macro" title="Macro Regime (Multi-Timeframe)" disclosure={disclosure} className="lg:col-span-2">
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
            <DurationInput label="Update Interval" hint="How often to re-score macro (1-10 min)" value={fv('macroUpdateIntervalMs')} onChange={(v) => handleRegimeChange('macroUpdateIntervalMs', v)} />
            <FormInput label="Suggestion Delay (hours)" hint="Stable long-term bias divergence before an advisory (0.01–720). Never changes sizing automatically." value={fv('aggressivenessSuggestionHours')} onChange={(v) => handleRegimeChange('aggressivenessSuggestionHours', v)} type="number" />
            <FormInput label="Hysteresis" hint="Score buffer to prevent mode chatter (0–20)" value={fv('macroHysteresis')} onChange={(v) => handleRegimeChange('macroHysteresis', v)} type="number" />
            <FormInput label="Accumulation Threshold" hint="Score below this = ACCUMULATION" value={fv('macroAccumulationThreshold')} onChange={(v) => handleRegimeChange('macroAccumulationThreshold', v)} type="number" />
            <FormInput label="Decline Threshold" hint="Score below this = DECLINE" value={fv('macroDeclineThreshold')} onChange={(v) => handleRegimeChange('macroDeclineThreshold', v)} type="number" />
            <FormInput label="Markup Threshold" hint="Score above this = MARKUP" value={fv('macroMarkupThreshold')} onChange={(v) => handleRegimeChange('macroMarkupThreshold', v)} type="number" />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <div className="bg-green-900/15 border border-green-800/30 rounded-sm p-3">
              <div className="text-xs text-green-400 font-medium mb-2">Accumulation (buying dips harder)</div>
              <div className="grid grid-cols-3 gap-2">
                <FormInput label="Size" hint="0 pauses new automatic entries. Otherwise use 0.1–3.0." value={fv('macroAccumulationSizeMult')} onChange={(v) => handleRegimeChange('macroAccumulationSizeMult', v)} type="number" />
                <FormInput label="TP" hint="Tighter" value={fv('macroAccumulationTpMult')} onChange={(v) => handleRegimeChange('macroAccumulationTpMult', v)} type="number" />
                <FormInput label="Offset" hint="Tighter" value={fv('macroAccumulationOffsetMult')} onChange={(v) => handleRegimeChange('macroAccumulationOffsetMult', v)} type="number" />
              </div>
            </div>
            <div className="bg-yellow-900/15 border border-yellow-800/30 rounded-sm p-3">
              <div className="text-xs text-yellow-400 font-medium mb-2">Markup (uptrend — reduce exposure)</div>
              <div className="grid grid-cols-3 gap-2">
                <FormInput label="Size" hint="0 pauses new automatic entries. Otherwise use 0.1–3.0." value={fv('macroMarkupSizeMult')} onChange={(v) => handleRegimeChange('macroMarkupSizeMult', v)} type="number" />
                <FormInput label="TP" hint="Wider" value={fv('macroMarkupTpMult')} onChange={(v) => handleRegimeChange('macroMarkupTpMult', v)} type="number" />
                <FormInput label="Offset" hint="Wider" value={fv('macroMarkupOffsetMult')} onChange={(v) => handleRegimeChange('macroMarkupOffsetMult', v)} type="number" />
              </div>
            </div>
            <div className="bg-red-900/15 border border-red-800/30 rounded-sm p-3">
              <div className="text-xs text-red-400 font-medium mb-2">Decline (capitulation — conservative)</div>
              <div className="grid grid-cols-3 gap-2">
                <FormInput label="Size" hint="0 pauses new automatic entries. Otherwise use 0.1–3.0." value={fv('macroDeclineSizeMult')} onChange={(v) => handleRegimeChange('macroDeclineSizeMult', v)} type="number" />
                <FormInput label="TP" hint="Tighter" value={fv('macroDeclineTpMult')} onChange={(v) => handleRegimeChange('macroDeclineTpMult', v)} type="number" />
                <FormInput label="Offset" hint="Wider" value={fv('macroDeclineOffsetMult')} onChange={(v) => handleRegimeChange('macroDeclineOffsetMult', v)} type="number" />
              </div>
            </div>
          </div>
          <div className="mt-2 text-xs text-gray-400">
            RANGING mode uses 1.0x for all multipliers (passthrough). Score range: -100 to +100. Thresholds must be ordered: decline &lt; accumulation &lt; markup.
          </div>
        </>
      )}
    </DisclosureCard>
  )
}

export function TpAutoManagementCard({ regimeConfig, defaults, handleRegimeChange }) {
  const fv = (key) => fieldValue(regimeConfig, defaults, key)
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
            <FormInput label="Evaluation Cycles" hint="Re-evaluate TP after this many completed cycles" value={fv('tpEvaluationCycles')} onChange={(v) => handleRegimeChange('tpEvaluationCycles', v)} type="number" />
            <FormInput label="Eval Max Hours" hint="Max hours before forcing TP re-evaluation" value={fv('tpEvaluationMaxHours')} onChange={(v) => handleRegimeChange('tpEvaluationMaxHours', v)} type="number" />
            <FormInput label="Min Sample Size" hint="Min fills needed before first auto-adjust" value={fv('tpMinSampleSize')} onChange={(v) => handleRegimeChange('tpMinSampleSize', v)} type="number" />
            <FormInput label="Max Change %" hint="Max single adjustment to TP values" value={fv('tpMaxChangePercent')} onChange={(v) => handleRegimeChange('tpMaxChangePercent', v)} type="number" />
            <FormInput label="TP Absolute Min %" hint="Hard floor: TP can never go below this" value={fv('tpAbsoluteMin')} onChange={(v) => handleRegimeChange('tpAbsoluteMin', v)} type="number" />
            <FormInput label="TP Absolute Max %" hint="Hard ceiling: TP can never go above this" value={fv('tpAbsoluteMax')} onChange={(v) => handleRegimeChange('tpAbsoluteMax', v)} type="number" />
          </div>
          <div className="mt-2 text-xs text-gray-400">
            Auto-adjusts TP range every {fv('tpEvaluationCycles')} cycles or {fv('tpEvaluationMaxHours')}h.
            Requires {fv('tpMinSampleSize')} samples before first adjustment.
            Holdback auto-set to half of TP Min.
          </div>
        </>
      )}
    </SectionCard>
  )
}

export function RiskCapsCard({ regimeConfig, baseCurrency, quoteCurrency, defaults, handleRegimeChange }) {
  const fv = (key) => fieldValue(regimeConfig, defaults, key)
  return (
    <SectionCard title="Risk Caps">
      <div className="grid grid-cols-2 gap-3">
        <FormInput label="Deposited Capital" hint="Your actual cash deposits (0 = auto-derive)" value={fv('depositedCapital')} onChange={(v) => handleRegimeChange('depositedCapital', v)} type="number" />
        <FormInput label={`Max ${baseCurrency} Exposure`} hint={`Max ${baseCurrency} the engine can hold (0 = uncapped)`} value={fv('maxAssetExposure')} onChange={(v) => handleRegimeChange('maxAssetExposure', v)} type="number" />
        <FormInput label={`Max Deployed (${quoteCurrency})`} hint={`Max ${quoteCurrency} deployed across active orders`} value={fv('maxUsdcDeployed')} onChange={(v) => handleRegimeChange('maxUsdcDeployed', v)} type="number" />
        <FormInput label="Max Drawdown %" hint="Pause new buys when fund equity (capital + realized + held coins at market) falls this % below its peak" value={fv('maxDrawdownPercent')} onChange={(v) => handleRegimeChange('maxDrawdownPercent', v)} type="number" />
        <FormInput label="Liquidity Factor Cap" hint="Max size multiplier from orderbook liquidity" value={fv('liquidityFactorCap')} onChange={(v) => handleRegimeChange('liquidityFactorCap', v)} type="number" />
        <FormInput label="Drawdown Reset (hrs)" hint="Hours at drawdown cap before auto-resuming (0 = off)" value={fv('drawdownResetHours')} onChange={(v) => handleRegimeChange('drawdownResetHours', v)} type="number" />
        <FormInput label="Cycle Reset (hrs)" hint="Hours at cycle buys limit before auto-resetting (0 = off)" value={fv('cycleResetHours')} onChange={(v) => handleRegimeChange('cycleResetHours', v)} type="number" />
      </div>
      <div className="mt-2 text-xs text-gray-400">
        Auto-reset hours: 0 = disabled. After this time at a limit, the engine resumes with reset counters.
      </div>
    </SectionCard>
  )
}

export function OrderExecutionCard({ regimeConfig, defaults, handleRegimeChange, disclosure }) {
  const fv = (key) => fieldValue(regimeConfig, defaults, key)
  return (
    <DisclosureCard cardId="orderExecution" title="Order Execution" disclosure={disclosure}>
      <div className="grid grid-cols-2 gap-3">
        <FormInput label="Entry Offset (bps)" hint="Place limit buy this many bps below market" value={fv('entryOffsetBps')} onChange={(v) => handleRegimeChange('entryOffsetBps', v)} type="number" />
        <FormInput label="Entry Offset Up (bps)" hint="Offset when momentum is UP (tighter to fill before rise)" value={fv('entryOffsetUpBps')} onChange={(v) => handleRegimeChange('entryOffsetUpBps', v)} type="number" />
        <FormInput label="Entry Offset Down (bps)" hint="Offset when momentum is DOWN (deeper to catch the dip)" value={fv('entryOffsetDownBps')} onChange={(v) => handleRegimeChange('entryOffsetDownBps', v)} type="number" />
        <FormInput label="Entry Max Retries" hint="Retry cancelled entries up to this many times" value={fv('entryMaxRetries')} onChange={(v) => handleRegimeChange('entryMaxRetries', v)} type="number" />
        <DurationInput label="Order Stale Floor" hint="Min entry timeout; actual scales with offset²/ATR², capped at Max Interval" value={fv('orderStaleMs')} onChange={(v) => handleRegimeChange('orderStaleMs', v)} />
        <DurationInput label="Cancel Rate Limit" hint="Min wait between cancel API calls" value={fv('cancelRateLimitMs')} onChange={(v) => handleRegimeChange('cancelRateLimitMs', v)} />
        <FormInput label="Max Open Orders" hint="Max simultaneous entry orders allowed" value={fv('maxOpenOrders')} onChange={(v) => handleRegimeChange('maxOpenOrders', v)} type="number" />
        <FormInput label="TP Update Threshold %" hint="Min price change before updating TP order" value={fv('tpUpdateThresholdPct')} onChange={(v) => handleRegimeChange('tpUpdateThresholdPct', v)} type="number" />
        <DurationInput label="Reconcile Interval" hint="How often to sync local state with exchange" value={fv('reconcileIntervalMs')} onChange={(v) => handleRegimeChange('reconcileIntervalMs', v)} />
      </div>
    </DisclosureCard>
  )
}

export function SafetyTailEventsCard({ regimeConfig, defaults, handleRegimeChange, disclosure }) {
  const fv = (key) => fieldValue(regimeConfig, defaults, key)
  return (
    <DisclosureCard cardId="safetyTail" title="Safety & Tail Events" disclosure={disclosure}>
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
            <FormInput label="Max Spread (bps)" hint="Pause entries when bid-ask spread exceeds this" value={fv('maxSpreadBps')} onChange={(v) => handleRegimeChange('maxSpreadBps', v)} type="number" />
            <DurationInput label="Spread Pause" hint="How long to pause after spread breach" value={fv('spreadPauseMs')} onChange={(v) => handleRegimeChange('spreadPauseMs', v)} />
            <FormInput label="Flash Move Mult" hint="ATR multiplier to detect flash crashes" value={fv('flashMoveMult')} onChange={(v) => handleRegimeChange('flashMoveMult', v)} type="number" />
            <DurationInput label="Flash Cooldown" hint="Pause duration after flash event detected" value={fv('flashCooldownMs')} onChange={(v) => handleRegimeChange('flashCooldownMs', v)} />
          </div>
          <div className="mt-3">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="cancelEntriesOnFlash"
                checked={fv('cancelEntriesOnFlash')}
                onChange={(e) => handleRegimeChange('cancelEntriesOnFlash', e.target.checked)}
                className="w-4 h-4 rounded-sm bg-gray-700 border-gray-600"
              />
              <label htmlFor="cancelEntriesOnFlash" className="text-sm text-gray-300">Cancel Entries on Flash</label>
            </div>
            <div className="text-2xs text-gray-400 mt-0.5 leading-tight">Pull all pending entries during flash events</div>
          </div>
        </>
      )}
    </DisclosureCard>
  )
}

export function SystemHealthCard({ regimeConfig, defaults, handleRegimeChange, disclosure }) {
  const fv = (key) => fieldValue(regimeConfig, defaults, key)
  return (
    <DisclosureCard cardId="systemHealth" title="System Health" disclosure={disclosure}>
      <div className="grid grid-cols-2 gap-3">
        <DurationInput label="Stale Data" hint="Enter SAFE mode if no ticker data for this long" value={fv('staleDataMs')} onChange={(v) => handleRegimeChange('staleDataMs', v)} />
        <DurationInput label="Stale Orders" hint="Flag orders as stale after this duration" value={fv('staleOrdersMs')} onChange={(v) => handleRegimeChange('staleOrdersMs', v)} />
        <DurationInput label="Max Latency" hint="Enter SAFE mode if API latency exceeds this" value={fv('maxLatencyMs')} onChange={(v) => handleRegimeChange('maxLatencyMs', v)} />
        <DurationInput label="Safe Recovery" hint="Time healthy before exiting SAFE mode" value={fv('safeRecoveryMs')} onChange={(v) => handleRegimeChange('safeRecoveryMs', v)} />
        <FormInput label="Max REST Errors" hint="Consecutive API errors before SAFE mode" value={fv('maxRestErrors')} onChange={(v) => handleRegimeChange('maxRestErrors', v)} type="number" />
        <FormInput label="Max Rate Limits" hint="Consecutive rate limits before SAFE mode" value={fv('maxRateLimits')} onChange={(v) => handleRegimeChange('maxRateLimits', v)} type="number" />
      </div>
      <div className="mt-2 text-xs text-gray-400">
        System enters SAFE mode when health thresholds are exceeded. Safe Recovery is time healthy before exiting SAFE.
      </div>
    </DisclosureCard>
  )
}
