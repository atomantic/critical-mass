import { Link } from '../../lib/router'
import ExchangeSelector from '../ExchangeSelector'
import Button from '../ui/Button'

// Fund sub-nav: view tabs plus the fund selector and regime engine controls.
// Rendered on fund routes only; global pages have no fund controls.
export default function FundSubNav({
  tabs, buildPath, isActiveTab, fundsUnavailable, exchangesError, retryExchanges,
  currentExchange, currentPair, exchanges, onExchangeChange, onAddFund,
  currentStrategy, regimeRunning, regimeDryRun, regimeLifecycle, wsConnected,
  resetting, closing, stopping, reopening, starting,
  onResetDryRun, onOpenCloseFund, onStop, onOpenReopenFund, onStart,
}) {
  return (
    <nav aria-label="Fund views" className="bg-gray-800 border-b border-gray-700">
      <div className="max-w-[95%] xl:max-w-[1400px] 2xl:max-w-[1800px] 3xl:max-w-[2000px] mx-auto px-4 2xl:px-6">
        <div className="flex flex-col xl:flex-row xl:items-center gap-0 xl:gap-2">
          <div className="flex w-full xl:w-auto gap-1 overflow-x-auto min-w-0">
            {!fundsUnavailable && tabs.map(tab => (
              <Link
                key={tab.path}
                to={buildPath(tab.path)}
                aria-current={isActiveTab(tab.path) ? 'page' : undefined}
                className={`px-3 sm:px-4 py-2.5 sm:py-3 text-xs sm:text-sm font-medium transition-colors whitespace-nowrap ${
                  isActiveTab(tab.path)
                    ? 'text-white border-b-2 border-blue-500'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                {tab.name}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-2 md:gap-3 flex-wrap max-w-full px-3 md:px-0 py-1.5 shrink-0 xl:ml-auto">
            {fundsUnavailable ? (
              <div role="alert" className="flex items-center gap-2 text-xs md:text-sm text-red-300">
                <span>Could not load funds ({exchangesError})</span>
                <Button variant="secondary" size="sm" onClick={retryExchanges}>
                  Retry
                </Button>
              </div>
            ) : (
              <ExchangeSelector
                currentExchange={currentExchange}
                currentPair={currentPair}
                exchanges={exchanges}
                onChange={onExchangeChange}
                onRefresh={retryExchanges}
                onAddFund={onAddFund}
              />
            )}
          {!fundsUnavailable && currentStrategy === 'regime' && regimeRunning !== null && (<>

              {regimeDryRun && (
                <span className="px-1.5 md:px-2 py-0.5 md:py-1 bg-purple-900/50 border border-purple-500 text-purple-400 text-2xs md:text-xs font-medium rounded-sm">
                  DRY-RUN
                </span>
              )}
              {regimeLifecycle === 'draining' && (
                <span className="px-1.5 md:px-2 py-0.5 md:py-1 bg-yellow-900/50 border border-yellow-500 text-yellow-300 text-2xs md:text-xs font-medium rounded-sm animate-pulse" title="Draining: blocking new entries; will close after current cycle's TP fills.">
                  DRAINING
                </span>
              )}
              {regimeLifecycle === 'closed' && (
                <span className="px-1.5 md:px-2 py-0.5 md:py-1 bg-red-900/50 border border-red-500 text-red-300 text-2xs md:text-xs font-medium rounded-sm" title="Fund is closed. Click Reopen to reactivate.">
                  CLOSED
                </span>
              )}
              <div className="flex items-center gap-1 md:gap-1.5 text-xs md:text-sm">
                <span className={`w-1.5 md:w-2 h-1.5 md:h-2 rounded-full ${regimeRunning ? 'bg-green-500 animate-pulse' : 'bg-gray-500'}`} />
                <span className={regimeRunning ? 'text-green-400' : 'text-gray-400'}>
                  {regimeRunning ? 'Running' : 'Stopped'}
                </span>
              </div>
              <div className="flex items-center gap-1 md:gap-1.5 text-xs md:text-sm">
                <span className={`w-1.5 md:w-2 h-1.5 md:h-2 rounded-full ${wsConnected ? 'bg-blue-500' : 'bg-red-500'}`} />
                <span className={wsConnected ? 'text-blue-400' : 'text-red-400'}>
                  {wsConnected ? 'Live' : 'Offline'}
                </span>
              </div>
              {regimeRunning ? (
                <>
                  {regimeDryRun && (
                    <Button
                      variant="purple"
                      size="responsive-xs"
                      onClick={onResetDryRun}
                      disabled={resetting}
                      title="Reset dry-run state"
                    >
                      {resetting ? '...' : 'Reset'}
                    </Button>
                  )}
                  {regimeLifecycle === 'active' && (
                    <Button
                      variant="warning"
                      size="responsive"
                      className="font-medium"
                      onClick={onOpenCloseFund}
                      disabled={closing}
                      title="Block new entries; auto-close after current cycle's TP fills"
                    >
                      {closing ? '...' : 'Close Fund'}
                    </Button>
                  )}
                  <Button
                    variant="destructive"
                    size="responsive"
                    className="font-medium"
                    onClick={onStop}
                    disabled={stopping}
                  >
                    {stopping ? '...' : 'Stop'}
                  </Button>
                </>
              ) : regimeLifecycle === 'closed' ? (
                <Button
                  size="responsive"
                  className="font-medium"
                  onClick={onOpenReopenFund}
                  disabled={reopening}
                  title="Reopen fund (does not restart the engine)"
                >
                  {reopening ? '...' : 'Reopen'}
                </Button>
              ) : (
                <Button
                  variant="success"
                  size="responsive"
                  className="font-medium"
                  onClick={onStart}
                  disabled={starting}
                >
                  {starting ? '...' : 'Start'}
                </Button>
              )}
          </>)}
          </div>
        </div>
      </div>
    </nav>
  )
}
