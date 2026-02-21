import { DollarSign, TrendingUp, Activity, Ghost, Layers } from 'lucide-react'

/**
 * Format a number as USD currency
 * @param {number | null | undefined} value
 * @returns {string}
 */
const formatCurrency = (value) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value || 0)

/**
 * Compact stat row
 */
function StatRow({ label, value, color }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-xs text-gray-500">{label}</span>
      <span className={`text-sm font-semibold ${color || 'text-gray-200'}`}>{value}</span>
    </div>
  )
}

/**
 * Right sidebar panel: market info, position, balance, today's stats
 * @param {Object} props
 * @param {Object | null} props.activeMarket - Active market ({ ticker, strike, closeTime })
 * @param {Object | null} props.matchingPosition - Position matching active market
 * @param {Object | null} props.marketPrice - Kalshi price data for active market
 * @param {Object | null} props.balance - { available, inPositions }
 * @param {Object | null} props.realBalance - Real Kalshi balance (for dry-run comparison)
 * @param {Object | null} props.stats - Today stats { trades, wins, pnl }
 * @param {string} props.mode - 'dry_run' or 'live'
 */
export default function MarketSidebar({
  activeMarket,
  matchingPosition,
  marketPrice,
  balance,
  realBalance,
  stats,
  mode,
  shadowStats,
  positions,
  prices,
  onPositionClick
}) {
  const strike = activeMarket?.strike
  const yesBid = marketPrice?.yesBid
  const yesAsk = marketPrice?.yesAsk
  const spread = (yesBid != null && yesAsk != null) ? yesAsk - yesBid : null
  const midPrice = (yesBid != null && yesAsk != null) ? ((yesBid + yesAsk) / 2).toFixed(1) : null
  const isYes = matchingPosition?.side === 'yes' || matchingPosition?.position > 0
  const contracts = matchingPosition?.contracts || Math.abs(matchingPosition?.position || 0)
  const avgCost = matchingPosition?.avgCost || matchingPosition?.average_price
    || (matchingPosition?.market_exposure && contracts ? Math.round(matchingPosition.market_exposure / contracts) : 0)

  // Directional markets (15M, 1H) use Up/Down; bracket/range markets use Yes/No
  const ticker = (activeMarket?.ticker || '').toUpperCase()
  const isDirectional = ticker.includes('15M') || ticker.includes('1H')
  const yesLabel = isDirectional ? '▲ Up' : 'Yes'
  const noLabel = isDirectional ? '▼ Down' : 'No'

  // Calculate unrealized P&L
  let unrealizedPnl = null
  if (matchingPosition && marketPrice) {
    const currentPrice = isYes
      ? (marketPrice.yesBid || marketPrice.lastPrice)
      : (marketPrice.noBid || (100 - (marketPrice.yesAsk || marketPrice.lastPrice)))
    if (currentPrice && avgCost) {
      const pnlPerContract = isYes ? currentPrice - avgCost : avgCost - currentPrice
      unrealizedPnl = (pnlPerContract * contracts) / 100
    }
  }

  const pnlColor = (stats?.pnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'
  const unrealizedColor = unrealizedPnl == null ? 'text-gray-500'
    : unrealizedPnl >= 0 ? 'text-green-400' : 'text-red-400'

  return (
    <div className="bg-gray-800 rounded-lg p-3 md:p-4 space-y-3 md:space-y-4 h-fit">
      {/* Market Title + Strike + Position -- compact row on mobile */}
      <div className="flex flex-row lg:flex-col gap-3 lg:gap-0">
        <div className="flex-1 min-w-0">
          <div className="text-[10px] md:text-xs text-gray-500 uppercase tracking-wider mb-1">Active Market</div>
          {activeMarket?.ticker ? (
            <>
              <a href={`https://kalshi.com/markets/${activeMarket.event_ticker || activeMarket.ticker}`}
                target="_blank" rel="noopener noreferrer"
                className="font-mono text-xs md:text-sm text-gray-300 hover:text-blue-400 truncate block">{activeMarket.ticker}</a>
              {strike && (
                <div className="mt-1 cursor-help" title="The prior BTC close price. Market settles YES if BTC closes above this, NO if below.">
                  <span className="text-[10px] md:text-xs text-gray-500">Mkt Prob</span>
                  <div className="flex items-baseline gap-2">
                    <span className="text-base md:text-lg font-bold text-green-400">${strike.toLocaleString()}</span>
                    {midPrice != null && (
                      <span className="text-xs text-gray-400 font-semibold cursor-help"
                        title={`Market mid-price: ${midPrice}¢ (bid ${yesBid}¢ / ask ${yesAsk}¢, spread ${spread}¢)`}>
                        {midPrice}%
                      </span>
                    )}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="text-sm text-gray-500">No active market</div>
          )}
        </div>

        {/* Position inline on mobile */}
        <div className="shrink-0 text-right lg:text-left lg:mt-3 lg:pt-3 lg:border-t lg:border-gray-700">
          <div className="text-[10px] md:text-xs text-gray-500 uppercase tracking-wider mb-1 lg:mb-1.5">Position</div>
          {matchingPosition ? (
            <div className="space-y-0.5 lg:space-y-1">
              <div className="flex items-center gap-2 justify-end lg:justify-start">
                <span className={`px-2 py-0.5 rounded text-xs font-semibold ${isYes ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'}`}>
                  {isYes ? yesLabel : noLabel}
                </span>
                <span className="text-xs md:text-sm text-gray-200">{contracts}x</span>
              </div>
              <div className="text-xs text-gray-500">@ {avgCost}¢</div>
              {unrealizedPnl != null && (
                <div className={`text-xs font-semibold ${unrealizedColor}`}>{formatCurrency(unrealizedPnl)}</div>
              )}
            </div>
          ) : (
            <div className="text-xs md:text-sm text-gray-500">None</div>
          )}
        </div>
      </div>

      {/* Divider */}
      <div className="border-t border-gray-700" />

      {/* Balance + Today Stats -- horizontal grid on mobile, stacked on desktop */}
      <div className="grid grid-cols-2 lg:grid-cols-1 gap-3 lg:gap-0">
        {/* Balance */}
        <div>
          <div className="text-[10px] md:text-xs text-gray-500 uppercase tracking-wider mb-1 md:mb-1.5 flex items-center gap-1">
            <DollarSign size={12} />
            Balance
          </div>
          <StatRow label="Available" value={formatCurrency(balance?.available)} color="text-green-400" />
          <StatRow label="In positions" value={formatCurrency(balance?.inPositions)} color="text-blue-400" />
          {(() => {
            const pv = realBalance?.portfolioValue ?? balance?.portfolioValue
            const avail = balance?.available || 0
            const inPos = balance?.inPositions || 0
            const pending = pv != null ? pv - avail - inPos : 0
            return pending > 0.01 ? (
              <StatRow label="Pending" value={formatCurrency(pending)} color="text-yellow-400" />
            ) : null
          })()}
          {mode === 'dry_run' && realBalance && (
            <div className="text-[10px] md:text-xs text-gray-600 mt-1">
              Real: {formatCurrency(realBalance.available)}
            </div>
          )}
        </div>

        {/* Today Stats -- on desktop add a divider above */}
        <div className="lg:border-t lg:border-gray-700 lg:pt-3 lg:mt-3">
          <div className="text-[10px] md:text-xs text-gray-500 uppercase tracking-wider mb-1 md:mb-1.5 flex items-center gap-1">
            <Activity size={12} />
            Today
          </div>
          <StatRow label="Trades" value={stats?.trades ?? 0} />
          <StatRow label="Wins" value={stats?.wins ?? 0} />
          <StatRow
            label="P&L"
            value={formatCurrency(stats?.pnl)}
            color={pnlColor}
          />
        </div>
      </div>

      {/* Open Positions */}
      {(() => {
        const openPositions = (positions || []).filter(pos => {
          const c = pos.contracts || Math.abs(pos.position || 0)
          return c > 0
        })
        if (openPositions.length === 0) return null
        return (
        <>
          <div className="border-t border-gray-700" />
          <div>
            <div className="text-[10px] md:text-xs text-gray-500 uppercase tracking-wider mb-1.5 flex items-center gap-1">
              <Layers size={12} />
              Open Positions ({openPositions.length})
            </div>
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {openPositions.map((pos) => {
                const posIsYes = pos.side === 'yes' || pos.position > 0
                const posContracts = pos.contracts || Math.abs(pos.position || 0)
                // Derive avg cost: explicit field, or from market_exposure / contracts (both in cents)
                const posAvgCost = pos.avgCost || pos.average_price
                  || (pos.market_exposure && posContracts ? Math.round(pos.market_exposure / posContracts) : 0)
                const posCostBasis = posContracts > 0 && posAvgCost > 0
                  ? (posContracts * posAvgCost) / 100
                  : (pos.market_exposure != null ? pos.market_exposure / 100 : null)
                const isActive = pos.ticker === activeMarket?.ticker
                const posTicker = (pos.ticker || '').toUpperCase()
                const posIsDirectional = posTicker.includes('15M') || posTicker.includes('1H')
                const posYesLabel = posIsDirectional ? 'Up' : 'Yes'
                const posNoLabel = posIsDirectional ? 'Down' : 'No'

                // Current market value + unrealized P&L from live prices
                const livePrice = prices?.get(pos.ticker)
                let currentValue = null
                let posUnrealized = null
                if (livePrice && posContracts > 0) {
                  const curPrice = posIsYes
                    ? (livePrice.yesBid || livePrice.lastPrice)
                    : (livePrice.noBid || (100 - (livePrice.yesAsk || livePrice.lastPrice)))
                  if (curPrice) {
                    currentValue = (curPrice * posContracts) / 100
                    if (posCostBasis != null) {
                      posUnrealized = currentValue - posCostBasis
                    }
                  }
                }
                const posUnrealizedColor = posUnrealized == null ? ''
                  : posUnrealized >= 0 ? 'text-green-400' : 'text-red-400'

                // Short ticker: show last segment (e.g., B97250 from KXBTC-...-B97250)
                const segments = pos.ticker?.split('-') || []
                const shortTicker = segments.length > 1 ? segments.slice(-1)[0] : pos.ticker

                return (
                  <button
                    key={pos.ticker}
                    onClick={() => onPositionClick?.(pos)}
                    className={`w-full text-left px-2 py-1.5 rounded text-xs transition-colors ${
                      isActive
                        ? 'bg-blue-900/30 border border-blue-500/30'
                        : 'bg-gray-700/30 hover:bg-gray-700/60 border border-transparent'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-mono text-gray-300 truncate" title={pos.ticker}>{shortTicker}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold shrink-0 ${
                        posIsYes ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'
                      }`}>
                        {posIsYes ? posYesLabel : posNoLabel} {posContracts}x
                      </span>
                    </div>
                    <div className="flex items-center justify-between mt-0.5">
                      <span className="text-gray-500">
                        {posAvgCost > 0 ? `@ ${posAvgCost}¢` : posCostBasis != null ? `cost ${formatCurrency(posCostBasis)}` : ''}
                      </span>
                      {currentValue != null ? (
                        <span className="text-gray-300">
                          {formatCurrency(currentValue)}
                          {posUnrealized != null && (
                            <span className={`ml-1 ${posUnrealizedColor}`}>
                              ({posUnrealized >= 0 ? '+' : ''}{formatCurrency(posUnrealized)})
                            </span>
                          )}
                        </span>
                      ) : posCostBasis != null ? (
                        <span className="text-gray-500">{formatCurrency(posCostBasis)} exposed</span>
                      ) : null}
                    </div>
                    {pos.resting_orders_count > 0 && (
                      <div className="text-[10px] text-yellow-500/70 mt-0.5">
                        {pos.resting_orders_count} resting order{pos.resting_orders_count > 1 ? 's' : ''}
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        </>
        )
      })()}

      {/* Shadow Strategies */}
      {shadowStats && Object.keys(shadowStats).length > 0 && (
        <>
          <div className="border-t border-gray-700" />
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wider mb-1.5 flex items-center gap-1">
              <Ghost size={12} />
              Shadow Strategies
            </div>
            {Object.entries(shadowStats).map(([name, s]) => {
              const shadowPnlColor = (s.pnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'
              const winRatePct = ((s.winRate ?? 0) * 100).toFixed(0)
              return (
                <div key={name} className="mb-2 last:mb-0">
                  <div className="text-xs font-medium text-gray-300 mb-0.5">{name}</div>
                  <div className="grid grid-cols-3 gap-1 text-xs">
                    <div>
                      <span className="text-gray-500">Trades</span>
                      <div className="text-gray-200 font-semibold">{s.trades ?? 0}</div>
                    </div>
                    <div>
                      <span className="text-gray-500">Win%</span>
                      <div className={`font-semibold ${parseInt(winRatePct) >= 60 ? 'text-green-400' : parseInt(winRatePct) >= 40 ? 'text-yellow-400' : 'text-red-400'}`}>
                        {winRatePct}%
                      </div>
                    </div>
                    <div>
                      <span className="text-gray-500">P&L</span>
                      <div className={`font-semibold ${shadowPnlColor}`}>{formatCurrency(s.pnl)}</div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
