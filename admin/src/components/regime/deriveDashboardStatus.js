// Select the status snapshot and panel inputs without changing fund/accounting data.
export function deriveDashboardStatus(status, config) {
  const isDryRun = status?.isDryRun || config?.dryRun
  const market = status?.market || {}
  const position = status?.position || {}
  const regime = status?.regime || {}
  const health = status?.health || {}
  const risk = status?.risk || {}
  const dryRunState = status?.dryRun || {}
  // Use pendingOrders from dryRunState for dry-run, from status for live
  const pendingOrdersList = isDryRun ? (dryRunState?.pendingOrders || []) : (status?.pendingOrders || [])
  // Only intents that actually need an operator: an in-flight dispatch is
  // reported by the engine but resolves itself within moments.
  const placementIntents = isDryRun ? [] : (status?.placementIntents || []).filter(i => i?.needsAttention)

  // New buys pause when the cycle buy-limit is reached; existing TPs stay active.
  const buysPaused = position?.cycleBuys != null && config?.maxCycleBuys != null && position.cycleBuys >= config.maxCycleBuys
  // A draining/closed fund's next cycle boundary is its close trigger — the
  // "resume buying" reset-cycle action is not applicable then (the engine
  // rejects it server-side too), so hide the button rather than showing an
  // action that would just fail with a confusing error.
  const fundLifecycle = status?.lifecycle?.lifecycle
  const isDrainingOrClosed = fundLifecycle === 'draining' || fundLifecycle === 'closed'

  const apy = status?.apy || {}
  const tpOptimizer = status?.tpOptimizer || {}
  const sizeOptimizer = status?.sizeOptimizer || {}

  // Panels receive their own settings/position slices; they do not own fund config.
  const riskPosition = { totalAsset: position.totalAsset, totalCostBasis: position.totalCostBasis, maxDrawdownSeen: position.maxDrawdownSeen }
  const riskConfig = config && { maxAssetExposure: config.maxAssetExposure, maxUsdcDeployed: config.maxUsdcDeployed, maxDrawdownPercent: config.maxDrawdownPercent }
  const macroConfig = config && {
    macroEnabled: config.macroEnabled,
    macroAccumulationSizeMult: config.macroAccumulationSizeMult,
    macroAccumulationTpMult: config.macroAccumulationTpMult,
    macroAccumulationOffsetMult: config.macroAccumulationOffsetMult,
    macroMarkupSizeMult: config.macroMarkupSizeMult,
    macroMarkupTpMult: config.macroMarkupTpMult,
    macroMarkupOffsetMult: config.macroMarkupOffsetMult,
    macroDeclineSizeMult: config.macroDeclineSizeMult,
    macroDeclineTpMult: config.macroDeclineTpMult,
    macroDeclineOffsetMult: config.macroDeclineOffsetMult,
  }

  return {
    isDryRun, market, position, regime,
    health, risk, dryRunState, pendingOrdersList,
    placementIntents, buysPaused, isDrainingOrClosed, apy,
    tpOptimizer, sizeOptimizer, riskPosition, riskConfig,
    macroConfig,
  }
}
