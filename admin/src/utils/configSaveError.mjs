// UI labels only: server validation messages remain stable for API clients.
export const CONFIG_FIELD_LABELS = {
  productId: 'Product ID',
  intervalsToSpread: 'Intervals',
  intervalType: 'Interval',
  sellMarkupPercent: 'Markup %',
  holdbackPercent: 'Holdback %',
  kFactor: 'k Factor',
  atrPeriod: 'ATR Period',
  minIntervalMs: 'Min Interval',
  maxIntervalMs: 'Max Interval',
  harvestScale: 'Harvest Scale',
  cautionScale: 'Caution Scale',
  trendScale: 'Trend Scale',
  maxCycleBuys: 'Max Cycle Buys',
  minOrderSizeUsdc: 'Min Order Size',
  ladderAutoSwitchVolMult: 'Auto-Switch Vol Mult',
  ladderMaxAthDropPct: 'Max ATH Drop %',
  ladderMinSpacingPct: 'Min Spacing %',
  tpMult: 'TP Multiplier',
  tpMinPercent: 'TP Min %',
  tpMaxPercent: 'TP Max %',
  holdbackRatio: 'Holdback Ratio',
  momentumMult: 'Momentum Mult',
  volExpansionMult: 'Vol Expansion',
  volContractionMult: 'Vol Contraction',
  vwapPeriodHours: 'VWAP Hours',
  trendConfirmationPeriods: 'Trend Confirm Periods',
  maxCelestialBodies: 'Max Celestial Bodies',
  mergeProximityScale: 'Merge Proximity Scale',
  macroUpdateIntervalMs: 'Update Interval (ms)',
  macroHysteresis: 'Hysteresis',
  macroAccumulationThreshold: 'Accumulation Threshold',
  macroDeclineThreshold: 'Decline Threshold',
  macroMarkupThreshold: 'Markup Threshold',
  macroAccumulationSizeMult: 'Accumulation Size',
  macroAccumulationTpMult: 'Accumulation TP',
  macroAccumulationOffsetMult: 'Accumulation Offset',
  macroMarkupSizeMult: 'Markup Size',
  macroMarkupTpMult: 'Markup TP',
  macroMarkupOffsetMult: 'Markup Offset',
  macroDeclineSizeMult: 'Decline Size',
  macroDeclineTpMult: 'Decline TP',
  macroDeclineOffsetMult: 'Decline Offset',
  tpEvaluationCycles: 'Evaluation Cycles',
  tpEvaluationMaxHours: 'Eval Max Hours',
  tpMinSampleSize: 'Min Sample Size',
  tpMaxChangePercent: 'Max Change %',
  tpAbsoluteMin: 'TP Absolute Min %',
  tpAbsoluteMax: 'TP Absolute Max %',
  depositedCapital: 'Deposited Capital',
  maxDrawdownPercent: 'Max Drawdown %',
  liquidityFactorCap: 'Liquidity Factor Cap',
  drawdownResetHours: 'Drawdown Reset (hrs)',
  cycleResetHours: 'Cycle Reset (hrs)',
  entryOffsetBps: 'Entry Offset (bps)',
  entryOffsetUpBps: 'Entry Offset Up (bps)',
  entryOffsetDownBps: 'Entry Offset Down (bps)',
  entryMaxRetries: 'Entry Max Retries',
  orderStaleMs: 'Order Stale Floor (ms)',
  cancelRateLimitMs: 'Cancel Rate Limit (ms)',
  maxOpenOrders: 'Max Open Orders',
  tpUpdateThresholdPct: 'TP Update Threshold %',
  reconcileIntervalMs: 'Reconcile Interval (ms)',
  maxSpreadBps: 'Max Spread (bps)',
  spreadPauseMs: 'Spread Pause (ms)',
  flashMoveMult: 'Flash Move Mult',
  flashCooldownMs: 'Flash Cooldown (ms)',
  staleDataMs: 'Stale Data (ms)',
  staleOrdersMs: 'Stale Orders (ms)',
  maxLatencyMs: 'Max Latency (ms)',
  safeRecoveryMs: 'Safe Recovery (ms)',
  maxRestErrors: 'Max REST Errors',
  maxRateLimits: 'Max Rate Limits',
  enabled: 'Enabled',
  dryRun: 'Dry Run',
  aggressiveness: 'Aggressiveness Level',
  baseSizeUsdc: 'Base Size',
  maxUsdcDeployed: 'Max Deployed',
  maxAssetExposure: 'Max Asset Exposure',
  totalAllocation: 'Allocation',
  minOrderSize: 'Min Order',
  maxBuyPrice: 'Max Price',
  fibBaseAmount: 'Fib Base Amount',
  amount: 'Amount',
  dcaStrategy: 'DCA Strategy',
  consolidateAfterOrders: 'Auto-Consolidate Order Count',
  consolidateInterval: 'Auto-Consolidate Schedule',
  entryMode: 'Entry Mode',
  ladderSpacingMode: 'Spacing Mode',
  ladderSizeMode: 'Size Mode',
  ladderAutoSwitch: 'Auto-Switch on Vol',
  celestialEnabled: 'Celestial Hierarchy',
  macroEnabled: 'Macro Regime',
  tpAutoManaged: 'TP Auto-Management',
  sizeAutoManaged: 'Size Auto-Management',
  sizeEvaluationCycles: 'Size Evaluation Cycles',
  sizeEvaluationMaxHours: 'Size Eval Max Hours',
  sizeMinSampleSize: 'Size Min Sample Size',
  sizeAbsoluteMinBase: 'Size Absolute Min Base',
  sizeAbsoluteMaxBase: 'Size Absolute Max Base',
  sizeTargetUtilization: 'Size Target Utilization',
  sizeMaxChangePercent: 'Size Max Change %',
  sizeAutoCycleBuys: 'Auto Cycle Buys',
  sizeMinCycleBuys: 'Min Cycle Buys',
  sizeMaxCycleBuys: 'Max Cycle Buys',
  longTermBiasEnabled: 'Long-Term Bias',
  longTermLookbackDays: 'Long-Term Lookback Days',
  longTermUpdateIntervalMs: 'Long-Term Update Interval',
  autoAggressivenessEnabled: 'Auto Aggressiveness',
  cancelEntriesOnFlash: 'Cancel Entries on Flash',
  divergenceScalePct: 'Divergence Scale %',
  wsConnectGraceMs: 'WebSocket Connect Grace',
  fillDriftSweepMs: 'Fill Drift Sweep',
  minDepthUsdc: 'Min Depth',
  depthPauseMs: 'Depth Pause'
}

export function humanizeConfigError(message) {
  if (typeof message !== 'string') return ''
  return message.split('; ').map(part => {
    const humanized = part.replace(/^(?:regime\.)?([A-Za-z][A-Za-z0-9]*)(?=:|\s|$)/, (token, key) => CONFIG_FIELD_LABELS[key] || token)
    // Cross-field constraints name the partner as well as the leading field.
    return humanized.replace(/(must be less than )(\w+)$/, (token, prefix, key) => `${prefix}${CONFIG_FIELD_LABELS[key] || key}`)
  }).join('; ')
}

export function describeConfigSaveError(status, body) {
  const data = body && typeof body === 'object' ? body : {}
  const errors = Array.isArray(data.errors) ? data.errors.filter(error => typeof error === 'string' && error.trim()) : []
  // The regime endpoint identifies editable validation failures with errors[].
  // An HTTP status or error string alone does not establish that changing the
  // draft can fix it. Full-config callers also use error strings, but consume
  // only message; keep the response-shape contract independent of HTTP status.
  const kind = data.persisted === true ? 'notApplied' : errors.length ? 'rejected' : 'failed'
  const reason = errors.join('; ') || (typeof data.error === 'string' && data.error) ||
    (typeof data.message === 'string' && data.message) ||
    (kind === 'notApplied' ? 'Settings were saved but not applied to the live engine. Restart the engine to apply them.' :
      status ? `Could not save settings (HTTP ${status})` : 'Could not save settings. Check your connection and retry.')
  return { kind, message: humanizeConfigError(reason) }
}
