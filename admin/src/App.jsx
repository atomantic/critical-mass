import { Component, useState, useEffect, useLayoutEffect, useRef, Suspense } from 'react'
import { Routes, Route, Link, Navigate } from './lib/router'
import { useLocation, useNavigate } from './lib/routerContext'
import { matchPath } from './lib/routeMatching'
import AppHeader from './components/shell/AppHeader'
import FundSubNav from './components/shell/FundSubNav'
import FundLifecycleDialogs from './components/shell/FundLifecycleDialogs'
import Button from './components/ui/Button'
import RetryBanner from './components/ui/RetryBanner'

import {
  routePaths, Dashboard, ConfigEditor, TransactionsDCA, TransactionsRegime, ChartsDCA, ChartsRegime,
  CostBasisDCA, CostBasisRegime, Backtest, Optimizer, Overview, KeysConfig, NotificationsConfig,
  BackupRestore, RegimeDashboard, Systems, AIProviders, LogViewer, GatewayAccess, UpDownDashboard,
  ScorecardAnalysis, SentinelDashboard, ArbitrageDashboard,
} from './routeChunks'
import AlertBanner from './components/sentinel/AlertBanner'
import { ToastProvider } from './components/Toast'
import { useToast } from './components/useToast'
import { tradeEventToToast } from './utils/tradeEventToToast.mjs'
import { useTradeEvents } from './hooks/useTradeEvents'
import useFundController from './hooks/useFundController'
import { getBaseCurrency, getQuoteCurrency } from './utils/productId.mjs'

const globalRoutes = [
  { path: routePaths.overview, render: onAddFund => <Overview onAddFund={onAddFund} /> },
  { path: routePaths.notifications, Page: NotificationsConfig },
  { path: routePaths.backups, Page: BackupRestore },
  { path: routePaths.systems, Page: Systems },
  { path: routePaths.ai, Page: AIProviders },
  { path: routePaths.updownAnalysis, Page: ScorecardAnalysis },
  { path: routePaths.updown, Page: UpDownDashboard },
  { path: routePaths.sentinel, Page: SentinelDashboard },
  { path: routePaths.arbitrage, Page: ArbitrageDashboard },
  { path: routePaths.gateway, Page: GatewayAccess },
  { path: routePaths.gatewayLogs, Page: LogViewer, props: { processName: 'critical-mass' } },
]

class RouteErrorBoundary extends Component {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3 text-center" role="alert">
        <p className="text-gray-300">This page could not be loaded.</p>
        <Button className="font-medium" onClick={() => window.location.reload()}>
          Reload page
        </Button>
      </div>
    )
  }
}

function RouteLoadingFallback() {
  return (
    <div className="flex items-center justify-center h-64" role="status" aria-live="polite">
      <div className="text-gray-400">Loading...</div>
    </div>
  )
}

// Component that listens to trade events and shows toasts
function TradeEventListener() {
  const { addToast } = useToast()
  const { latestEvent } = useTradeEvents()

  useEffect(() => {
    if (latestEvent) {
      // Only show toasts for significant events (skip info-level like price checks)
      const significantTypes = ['buy_filled', 'sell_placed', 'order_filled', 'complete', 'error', 'skipped']
      if (significantTypes.includes(latestEvent.type)) {
        addToast(tradeEventToToast(latestEvent))
      }
    }
  }, [latestEvent, addToast])

  return null
}

function AppContent() {
  const location = useLocation()
  const navigate = useNavigate()
  const { addToast } = useToast()
  const {
    urlExchange, urlPair, isFundRoute, currentExchange, currentPair, currentStrategy,
    exchanges, exchangesLoaded, simpleDcaEnabled, fundsUnavailable, exchangesError, awaitingFundList, fundMissing,
    summary, loading, error, summaryWanted, pollRegime,
    regimeRunning, regimeDryRun, regimeLifecycle, statusError, wsConnected,
    tabs, isActiveTab, buildPath,
    fetchExchanges, retryExchanges, fetchData, refreshFund, fetchRegimeStatus, handleExchangeChange,
    starting, stopping, resetting, closing, reopening,
    closeFundDialogOpen, setCloseFundDialogOpen, closeFundReason, setCloseFundReason,
    reopenFundDialogOpen, setReopenFundDialogOpen, resetDryRunConfirm, setResetDryRunConfirm,
    handleStartRegime, handleStopRegime, openCloseFundDialog, submitCloseFund,
    openReopenFundDialog, submitReopenFund, handleResetDryRun, handleExecuteResetDryRun,
  } = useFundController({
    location, navigate, addToast,
    isGlobalRoute: globalRoutes.some(({ path }) => matchPath(path, location.pathname)),
  })

  const [addFundDialogOpen, setAddFundDialogOpen] = useState(false)
  const openAddFund = () => setAddFundDialogOpen(true)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const mainContentRef = useRef(null)
  const mobileDestinationRef = useRef(null)

  const handleMobileSection = (event, to) => {
    // Match Link's same-window activation rules. Modified clicks keep both
    // their native browser behavior and the current menu/focus position.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return
    mobileDestinationRef.current = to
    setMobileMenuOpen(false)
  }

  useLayoutEffect(() => {
    if (mobileMenuOpen || mobileDestinationRef.current === null) return
    const destination = mobileDestinationRef.current
    mobileDestinationRef.current = null
    if (destination === location.pathname + location.search + location.hash) {
      // The destination's content or Suspense loading region has committed.
      // Focus the persistent landmark once; lazy completion and polls must
      // leave the operator's subsequent focus choices alone.
      mainContentRef.current?.focus()
    }
  }, [location, mobileMenuOpen])
  return (
    <div className="min-h-dvh">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:top-2 focus:left-2 focus:px-4 focus:py-2 focus:rounded-sm focus:bg-blue-600 focus:text-white"
        >
          Skip to main content
        </a>
        <AppHeader
          mobileMenuOpen={mobileMenuOpen}
          onToggleMobileMenu={() => setMobileMenuOpen(!mobileMenuOpen)}
          onMobileSection={handleMobileSection}
        />

        {/* Fund sub-nav (fund routes only; global pages have no fund controls) */}
        {isFundRoute && (
          <FundSubNav
            tabs={tabs}
            buildPath={buildPath}
            isActiveTab={isActiveTab}
            fundsUnavailable={fundsUnavailable}
            exchangesError={exchangesError}
            retryExchanges={retryExchanges}
            currentExchange={currentExchange}
            currentPair={currentPair}
            exchanges={exchanges}
            onExchangeChange={handleExchangeChange}
            onAddFund={openAddFund}
            currentStrategy={currentStrategy}
            regimeRunning={regimeRunning}
            regimeDryRun={regimeDryRun}
            regimeLifecycle={regimeLifecycle}
            wsConnected={wsConnected}
            resetting={resetting}
            closing={closing}
            stopping={stopping}
            reopening={reopening}
            starting={starting}
            onResetDryRun={handleResetDryRun}
            onOpenCloseFund={openCloseFundDialog}
            onStop={handleStopRegime}
            onOpenReopenFund={openReopenFundDialog}
            onStart={handleStartRegime}
          />
        )}

        {/* Global Alert Banner */}
        <AlertBanner />

        <FundLifecycleDialogs
          currentExchange={currentExchange}
          currentPair={currentPair}
          exchanges={exchanges}
          navigate={navigate}
          addToast={addToast}
          fetchExchanges={fetchExchanges}
          closeFundDialogOpen={closeFundDialogOpen}
          setCloseFundDialogOpen={setCloseFundDialogOpen}
          closeFundReason={closeFundReason}
          setCloseFundReason={setCloseFundReason}
          closing={closing}
          submitCloseFund={submitCloseFund}
          addFundDialogOpen={addFundDialogOpen}
          setAddFundDialogOpen={setAddFundDialogOpen}
          reopenFundDialogOpen={reopenFundDialogOpen}
          setReopenFundDialogOpen={setReopenFundDialogOpen}
          reopening={reopening}
          submitReopenFund={submitReopenFund}
          resetDryRunConfirm={resetDryRunConfirm}
          setResetDryRunConfirm={setResetDryRunConfirm}
          resetting={resetting}
          handleExecuteResetDryRun={handleExecuteResetDryRun}
        />

        {/* Main Content */}
        <main ref={mainContentRef} id="main-content" tabIndex={-1} className="max-w-[95%] xl:max-w-[1400px] 2xl:max-w-[1800px] 3xl:max-w-[2000px] mx-auto px-4 2xl:px-6 py-6 focus:outline-hidden">
          {pollRegime && statusError && (
            <RetryBanner message={statusError} onRetry={fetchRegimeStatus} retryLabel="Retry engine status" />
          )}
          {summaryWanted && error && (!isActiveTab('/config') || summary?.config) && (
            <RetryBanner message={error} onRetry={fetchData} />
          )}

          {awaitingFundList || (summaryWanted && loading && !summary && !isActiveTab('/config')) ? (
            <RouteLoadingFallback />
          ) : fundMissing ? (
            <div role="alert" className="text-sm text-gray-300 space-y-3">
              <p>
                No configured fund matches <span className="font-mono text-yellow-400">{urlExchange}/{urlPair}</span>.
              </p>
              <div className="flex items-center gap-3">
                <Button variant="secondary" size="sm" onClick={retryExchanges}>Reload fund list</Button>
                <Link to="/" className="text-blue-400 hover:text-blue-300 underline">Back to Overview</Link>
              </div>
            </div>
          ) : isFundRoute && fundsUnavailable ? null : (
            <RouteErrorBoundary key={location.pathname}>
              <Suspense fallback={<RouteLoadingFallback />}>
                <Routes>
                  {globalRoutes.map(({ path, Page, props, render }) => (
                    <Route key={path} path={path} element={Page ? <Page {...props} /> : render(openAddFund)} />
                  ))}

                  {/* Pair-based routes - strategy determined from exchange config.
                      The `key` includes both exchange and pair so React unmounts
                      and remounts the dashboard whenever the user navigates to a
                      different fund — this guarantees fresh state and re-fetched
                      data instead of stale data from the previous fund. */}
                  {isFundRoute && (<>
                    <Route path={routePaths.fund} element={
                      currentStrategy === 'regime'
                        ? <RegimeDashboard key={`${currentExchange}-${currentPair}`} exchange={currentExchange} pair={currentPair} />
                        : <Dashboard key={`${currentExchange}-${currentPair}`} summary={summary} onRefresh={refreshFund} exchange={currentExchange} pair={currentPair} />
                    } />
                    <Route path={routePaths.costBasis} element={
                      currentStrategy === 'regime'
                        ? <CostBasisRegime key={`${currentExchange}-${currentPair}`} exchange={currentExchange} pair={currentPair} />
                        : <CostBasisDCA key={`${currentExchange}-${currentPair}`} summary={summary} quoteCurrency={getQuoteCurrency(summary?.config?.productId)} exchange={currentExchange} pair={currentPair} />
                    } />
                    <Route path={routePaths.transactions} element={
                      currentStrategy === 'regime'
                        ? <TransactionsRegime key={`${currentExchange}-${currentPair}`} exchange={currentExchange} pair={currentPair} />
                        : <TransactionsDCA transactions={summary?.transactions} baseCurrency={getBaseCurrency(summary?.config?.productId)} quoteCurrency={getQuoteCurrency(summary?.config?.productId)} />
                    } />
                    <Route path={routePaths.charts} element={
                      currentStrategy === 'regime'
                        ? <ChartsRegime key={`${currentExchange}-${currentPair}`} exchange={currentExchange} pair={currentPair} />
                        : <ChartsDCA summary={summary} quoteCurrency={getQuoteCurrency(summary?.config?.productId)} />
                    } />
                    <Route path={routePaths.config} element={<ConfigEditor key={`${currentExchange}-${currentPair}`} config={summary?.config} regimeDefaults={summary?.regimeDefaults} loadError={error || (!loading && !summary?.config ? 'Configuration is unavailable' : null)} onRetry={fetchData} onSave={refreshFund} exchange={currentExchange} pair={currentPair} strategy={currentStrategy} engineRunning={regimeRunning} engineDryRun={regimeDryRun} onRestart={fetchRegimeStatus} />} />

                    {/* DCA-only routes (backtest, optimizer) */}
                    {simpleDcaEnabled && currentStrategy !== 'regime' && <>
                      <Route path={routePaths.backtest} element={<Backtest key={`${currentExchange}:${currentPair}`} summary={summary} exchange={currentExchange} pair={currentPair} quoteCurrency={getQuoteCurrency(summary?.config?.productId)} />} />
                      <Route path={routePaths.optimizer} element={<Optimizer key={`${currentExchange}:${currentPair}`} exchange={currentExchange} pair={currentPair} />} />
                    </>}

                    {/* API Keys - in sub-nav tabs */}
                    <Route path={routePaths.keys} element={<KeysConfig key={currentExchange} exchange={currentExchange} funds={exchanges.filter(e => e.name === currentExchange)} onSave={fetchExchanges} />} />

                    {/* PM2 Logs - per exchange engine */}
                    <Route path={routePaths.logs} element={<LogViewer processName={`critical-mass-${currentExchange}`} />} />

                  </>)}

                  {urlExchange && !urlPair && (
                    <Route path="/:exchange" element={
                      fundsUnavailable ? (
                        <RetryBanner message={exchangesError} onRetry={retryExchanges} retryLabel="Retry fund list" />
                      ) : !exchangesLoaded ? (
                        <RouteLoadingFallback />
                      ) : (
                        <Navigate to={currentPair ? `/${currentExchange}/${currentPair}` : routePaths.overview} replace />
                      )
                    } />
                  )}
                  <Route path="*" element={<Navigate to={routePaths.overview} replace />} />
                </Routes>
              </Suspense>
            </RouteErrorBoundary>
          )}
        </main>
      </div>
  )
}

function App() {
  return (
    <ToastProvider>
      <TradeEventListener />
      <AppContent />
    </ToastProvider>
  )
}

export default App
