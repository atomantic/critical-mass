import Button from './ui/Button'
import React, { useState, lazy, Suspense } from 'react'
import { useDerivedDashboardStatus } from './regime/deriveDashboardStatus'
import { LastPriceContext } from './regime/LastPriceContext'
import { getPriceDecimals } from './charts/chartUtils'
import EmptyRegimeState from './regime/EmptyRegimeState'
import AuthDeniedBanner from './regime/AuthDeniedBanner'
import StoppedBanner from './regime/StoppedBanner'
import { useToast } from './useToast'
import { getBaseCurrency, getQuoteCurrency } from '../utils/productId.mjs'
import { pairQuery as buildPairQuery } from '../utils/api'
import RegimePriceChart from './charts/RegimePriceChart'
import VolatilityChart from './charts/VolatilityChart'
import RegimeTimeline from './charts/RegimeTimeline'
import {
  CancelLadderConfirmation, CollapseAllConfirmation, ResetCycleConfirmation, ResumeDrawdownConfirmation, RollUpConfirmation,
} from './regime/RegimeActionConfirmations'
import TpEditDialog from './regime/TpEditDialog'
import DcaConvertDialog from './regime/DcaConvertDialog'
import OpenOrdersTable, { REGIME_ORDER_TOUCH_TARGET } from './regime/OpenOrdersTable'
import FilledOrdersSection from './regime/FilledOrdersSection'
import PositionCard from './regime/PositionCard'
import LadderPanel from './regime/LadderPanel'
import BuysPausedBanner from './regime/BuysPausedBanner'
import VolatilityMetrics from './regime/VolatilityMetrics'
import TpOptimizerPanel from './regime/TpOptimizerPanel'
import SizeOptimizerPanel from './regime/SizeOptimizerPanel'
import FillTimeStats from './regime/FillTimeStats'
import RiskLimitsPanel from './regime/RiskLimitsPanel'
import MacroRegimePanel from './regime/MacroRegimePanel'
import ConfigurationSummary from './regime/ConfigurationSummary'
import PlacementIntentsPanel from './regime/PlacementIntentsPanel'
import OptimalTpAnalysis from './regime/OptimalTpAnalysis'
import LongTermBiasPanel from './regime/LongTermBiasPanel'
import LiveStatusBar from './regime/LiveStatusBar'
import useRegimeDashboardData from './regime/useRegimeDashboardData'
import useDcaConversion from './regime/useDcaConversion'
import useRegimeDashboardActions from './regime/useRegimeDashboardActions'

const CelestialVisualization = lazy(() => import('./celestial/CelestialVisualization'))
const EMPTY_BODIES = []
const EMPTY_FILLS = []

function ChartPlaceholder({ height, label }) {
  return (
    <div role="status" className="bg-gray-800 rounded-lg p-4 flex items-center justify-center text-xs text-gray-400" style={{ minHeight: height }}>
      {label}
    </div>
  )
}

function RegimeDashboard({ exchange = 'coinbase', pair }) {
  const pairQuery = buildPairQuery(pair)
  const { addToast } = useToast()
  const {
    status, config, loading, fillsLoading, chartLoading, presetsLoading, error, stale, retry, fillsUnavailable, liveFills, fillAggregates, presets, presetsError, retryPresets, isRunning, prevPriceRef,
    priceHistory, atrHistory, regimeHistory, fetchStatus, fetchConfig, fetchFills,
  } = useRegimeDashboardData(exchange, pair, pairQuery)
  const {
    dcaState, dcaStateError, retryDcaState, convertPreview, converting, showConvertConfirm, setShowConvertConfirm,
    handlePreviewConvert, handleExecuteConvert,
  } = useDcaConversion({ exchange, pairQuery, isRunning, addToast, fetchStatus, fetchFills })
  const {
    rollUpConfirm, setRollUpConfirm, rollingUp, collapseAllConfirm,
    setCollapseAllConfirm, drawdownResumeConfirm, setDrawdownResumeConfirm, resumingAuth,
    collapsingAll, resetCycleConfirm, setResetCycleConfirm, resettingCycle,
    tpEditModal, setTpEditModal, settingTp, cancellingLadder,
    cancelLadderConfirm, setCancelLadderConfirm, handleResumeDrawdown, handleResumeFromAuthDenied,
    handleRollUp, handleCollapseAll, handleResetCycle, handleSetTp,
    handleCancelLadder, handleExecuteCancelLadder,
  } = useRegimeDashboardActions({ exchange, pairQuery, addToast, fetchStatus, fetchConfig, fetchFills })
  const [openSearchId, setOpenSearchId] = useState('')
  const {
    isDryRun, market, position, regime, health, dryRunState, pendingOrdersList, placementIntents,
    buysPaused, isDrainingOrClosed, apy, tpOptimizer, sizeOptimizer, risk, riskPosition, riskConfig, macroConfig,
  } = useDerivedDashboardStatus(status, config)

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading regime engine status...</div>
      </div>
    )
  }

  const asset = getBaseCurrency(config?.productId)
  const quoteCurrency = getQuoteCurrency(config?.productId || pair)
  const priceDecimals = getPriceDecimals(market.lastPrice)

  return (
    <LastPriceContext.Provider value={market.lastPrice || 0}>
    <div className="space-y-6">
      {/* Error display */}
      {error && (
        <div role="alert" className="p-3 bg-red-900/50 border border-red-700 rounded-sm text-red-200 text-sm">
          {error}. {stale && 'Showing last good data (stale). '}
          <Button type="button" onClick={retry} variant="link" size="inline" className="ml-2 underline">Retry</Button>
        </div>
      )}

      {/* Stopped banner when engine is not running but we have data */}
      {status && !error && <StoppedBanner isRunning={isRunning} lastPrice={market.lastPrice} totalAsset={position.totalAsset}
        engineDown={status?.engineDown} stale={market.stale} silent={status?.statusSilent} />}

      {/* API-key-denied banner: the exchange rejected the key (commonly the
          server IP is not on the key's allowlist). New orders are halted until
          access is restored; live orders are left untouched. */}
      <AuthDeniedBanner health={health} handleResumeFromAuthDenied={handleResumeFromAuthDenied} resumingAuth={resumingAuth} />

      {/* Buys-paused banner: cycle buy-limit reached, new entries paused */}
      <BuysPausedBanner buysPaused={buysPaused} cycleBuys={position.cycleBuys} maxCycleBuys={config?.maxCycleBuys} isRunning={isRunning} isDrainingOrClosed={isDrainingOrClosed} setResetCycleConfirm={setResetCycleConfirm} resettingCycle={resettingCycle} />

      {(status && !error && !isRunning && !market.lastPrice && !position.totalAsset) ? (
        <EmptyRegimeState isDryRun={isDryRun} dcaState={dcaState} dcaStateError={dcaStateError} retryDcaState={retryDcaState} handlePreviewConvert={handlePreviewConvert} />
      ) : status ? (
        <>
          {/* Live Status Bar */}
          <LiveStatusBar asset={asset} market={market} position={position} config={config}
            prevPrice={prevPriceRef.current} health={health} regime={regime} celestial={status?.celestial}
            macro={status?.macro} entryMode={status?.entryMode} ladder={status?.ladder} autoSwitch={status?.autoSwitch} />

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 lg:gap-6">
          {/* Left Column: Volatility, Risk & Timeline */}
          <div className="space-y-4">
            {/* Volatility Metrics - Compact */}
            <VolatilityMetrics market={market} />

            {/* Volatility Chart */}
            {chartLoading ? <ChartPlaceholder height={200} label="Loading volatility history..." /> : (
              <VolatilityChart
                atrData={atrHistory}
                regimeData={regimeHistory}
                height={200}
              />
            )}

            {/* TP Auto-Management Panel */}
            <TpOptimizerPanel tpOptimizer={tpOptimizer} />

            {/* Size Auto-Management Panel */}
            <SizeOptimizerPanel sizeOptimizer={sizeOptimizer} />

            {/* Fill Time Stats */}
            <FillTimeStats fillTimeStats={status?.fillTimeStats} effectiveStaleMs={status?.effectiveStaleMs} pendingEntryStaleMs={status?.pendingEntryStaleMs} orderStaleMs={config?.orderStaleMs} />

            {/* Optimal TP Analytics (dry-run) */}
            <OptimalTpAnalysis isDryRun={isDryRun} optimalTpAnalytics={dryRunState?.optimalTpAnalytics} tpMinPercent={config?.tpMinPercent} tpMaxPercent={config?.tpMaxPercent} />

            {/* Risk Limits */}
            <RiskLimitsPanel quoteCurrency={quoteCurrency} risk={risk} position={riskPosition} config={riskConfig} committedUsdc={status?.ladder?.committedUsdc} asset={asset} setDrawdownResumeConfirm={setDrawdownResumeConfirm} />
          </div>

          {/* Middle Column: Position & Risk */}
          <div className="space-y-4">
            {/* 3D Celestial Visualization */}
            {status?.celestial?.enabled && (
              <Suspense fallback={<div className="bg-gray-800 rounded-lg p-4 text-xs text-gray-400">Loading celestial system...</div>}>
                <CelestialVisualization
                  celestial={status.celestial}
                  pendingOrders={pendingOrdersList}
                  currentPrice={market.lastPrice}
                  maxUsdcDeployed={config?.maxUsdcDeployed}
                  baseCurrency={asset}
                />
              </Suspense>
            )}

            {/* Position */}
            <PositionCard
              position={position}
              apy={apy}
              market={market}
              celestial={status?.celestial}
              config={config}
              asset={asset}
              isDryRun={isDryRun}
              dryRunState={dryRunState}
              exchange={exchange}
              pairQuery={pairQuery}
              fetchConfig={fetchConfig}
              fetchStatus={fetchStatus}
              addToast={addToast}
            />

          </div>

          {/* Right Column: Timeline & Price Chart */}
          <div className="space-y-4">
            {/* Macro Regime Panel */}
            <MacroRegimePanel config={macroConfig} macro={status?.macro} />

            {/* Long-Term Bias Panel (Phase 2: advisory depression score + one-click apply) */}
            {status?.macro?.longTermBias && (
              <LongTermBiasPanel
                bias={status.macro.longTermBias}
                config={config}
                presets={presets}
                exchange={exchange}
                pairQuery={pairQuery}
                onConfigUpdate={fetchConfig}
                addToast={addToast}
              />
            )}

            {/* Regime Timeline */}
            {chartLoading ? <ChartPlaceholder height={60} label="Loading regime timeline..." /> : <RegimeTimeline data={regimeHistory} currentRegime={regime} height={60} />}

            {chartLoading ? <ChartPlaceholder height={280} label="Loading price history..." /> : <RegimePriceChart
              priceData={priceHistory}
              regimeData={regimeHistory}
              currentPrice={market.lastPrice}
              anchorPrice={position.anchorPrice}
              atr={market.atr1m}
              kFactor={config?.kFactor}
              height={280}
            />}

            {/* Configuration Summary */}
            <ConfigurationSummary config={config} exchange={exchange} pairQuery={pairQuery} fetchConfig={fetchConfig} presets={presets} presetsLoading={presetsLoading} presetsError={presetsError} retryPresets={retryPresets} addToast={addToast} />
          </div>
        </div>

        {/* Orders Section - Stacked vertically */}
        <div className="space-y-4">
          {/* Open Orders */}
          <div className="bg-gray-800 rounded-lg p-4">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 mb-3">
              <h3 className="text-sm font-medium text-gray-400">Open Orders</h3>
              <div className="flex flex-wrap items-center gap-2">
                {isDryRun && <span className="text-xs text-purple-400">(Simulated)</span>}
                {status?.position?.ladderActive && status?.isRunning && (
                  <Button
                    onClick={handleCancelLadder}
                    disabled={cancellingLadder}
                    variant="destructive" size="xs" touchTarget="always" className={REGIME_ORDER_TOUCH_TARGET}
                  >
                    {cancellingLadder ? 'Cancelling…' : 'Cancel Ladder → Reactive'}
                  </Button>
                )}
                {status?.isRunning && (status?.celestial?.bodies?.length || 0) >= 2 && (
                  <Button
                    onClick={() => setCollapseAllConfirm(true)}
                    disabled={collapsingAll}
                    title="Cancel all body TP orders, combine into one body, place a single TP"
                    variant="caution" size="xs" touchTarget="always" className={REGIME_ORDER_TOUCH_TARGET}
                  >
                    {collapsingAll ? 'Collapsing…' : `Collapse All (${status.celestial.bodies.length})`}
                  </Button>
                )}
                {pendingOrdersList.length > 0 && (
                  <input
                    aria-label="Filter open orders by ID"
                    type="text"
                    value={openSearchId}
                    onChange={e => setOpenSearchId(e.target.value)}
                    placeholder="Filter by ID…"
                    className="bg-gray-700 text-gray-200 text-xs rounded-sm px-2 py-1 placeholder-gray-400 w-36"
                  />
                )}
              </div>
            </div>
            {/* Rebuild Ladder toggle + settings/preview panel — kept out of the
                buttons row above so opening it never shifts Cancel Ladder /
                Collapse All / the order filter input. */}
            <LadderPanel
              quoteCurrency={quoteCurrency}
              config={config}
              status={status}
              exchange={exchange}
              pairQuery={pairQuery}
              addToast={addToast}
              fetchConfig={fetchConfig}
              fetchStatus={fetchStatus}
            />
            <OpenOrdersTable
              fillsLoading={fillsLoading}
              pendingOrdersList={pendingOrdersList}
              liveFills={fillAggregates?.openFillsTruncated ? EMPTY_FILLS : fillAggregates?.openFills || liveFills}
              openFillsTruncated={fillAggregates?.openFillsTruncated}
              dryRunFilled={dryRunState?.filledOrders}
              isDryRun={isDryRun}
              celestialBodies={status?.celestial?.bodies || EMPTY_BODIES}
              avgCostBasis={position.avgCostBasis}
              config={config}
              priceDecimals={priceDecimals}
              asset={asset}
              isRunning={isRunning}
              openSearchId={openSearchId}
              setTpEditModal={setTpEditModal}
              setRollUpConfirm={setRollUpConfirm}
            />
          </div>

          {/* Unresolved placement intents — while any exist the fund refuses new placements */}
          <PlacementIntentsPanel placementIntents={placementIntents} asset={asset} exchange={exchange} pairQuery={pairQuery} addToast={addToast} fetchStatus={fetchStatus} fetchFills={fetchFills} />

        </div>
        </>
      ) : null}

      <FilledOrdersSection
        fillsLoading={fillsLoading}
        fillsUnavailable={fillsUnavailable}
        retry={retry}
        liveFills={liveFills}
        fillAggregates={fillAggregates}
        isDryRun={isDryRun}
        dryRunFilled={dryRunState?.filledOrders}
        pendingOrdersList={pendingOrdersList}
        priceDecimals={priceDecimals}
        asset={asset}
      />

      {/* Operational confirmations: each reads only its own state from the action hooks */}
      <CancelLadderConfirmation
        open={cancelLadderConfirm}
        busy={cancellingLadder}
        orderCount={status?.position?.pendingLadderOrders?.length || 0}
        onClose={() => setCancelLadderConfirm(false)}
        onConfirm={handleExecuteCancelLadder}
      />
      <CollapseAllConfirmation
        open={collapseAllConfirm}
        busy={collapsingAll}
        bodyCount={status?.celestial?.bodies?.length || 0}
        onClose={() => setCollapseAllConfirm(false)}
        onConfirm={handleCollapseAll}
      />
      <ResetCycleConfirmation
        open={resetCycleConfirm}
        busy={resettingCycle}
        cycleBuys={position.cycleBuys}
        maxCycleBuys={config?.maxCycleBuys}
        onClose={() => setResetCycleConfirm(false)}
        onConfirm={handleResetCycle}
      />
      <ResumeDrawdownConfirmation
        open={drawdownResumeConfirm}
        onClose={() => setDrawdownResumeConfirm(false)}
        onConfirm={handleResumeDrawdown}
      />
      <RollUpConfirmation
        rollUp={rollUpConfirm}
        busy={rollingUp}
        onClose={() => setRollUpConfirm(null)}
        onConfirm={handleRollUp}
      />
      <TpEditDialog tp={tpEditModal} setTp={setTpEditModal} busy={settingTp} onSubmit={handleSetTp} />
      <DcaConvertDialog
        preview={showConvertConfirm ? convertPreview : null}
        busy={converting}
        onClose={() => setShowConvertConfirm(false)}
        onConfirm={handleExecuteConvert}
      />
    </div>
    </LastPriceContext.Provider>
  )
}

export default RegimeDashboard
