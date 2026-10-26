import { formatCurrency, formatPrice, formatAsset } from '../charts/chartUtils'
import StatCard from '../StatCard'
import { signedPrefix } from '../../utils/pnlFormat.mjs'

// Holdings valuation stays separate from dashboard requests and trading controls.
export default function DcaHoldingsSummary({ state, stats, costBasis, currentPrice, baseCurrency, quoteCurrency }) {
  const priceKnown = currentPrice !== null
  const NA = '—'
  const assetValue = (state.assetReserves || 0) * (currentPrice || 0)
  const pendingAssetValue = (state.outstandingOrdersAsset || 0) * (currentPrice || 0)
  const totalAssetHeld = (state.assetReserves || 0) + (state.outstandingOrdersAsset || 0)
  const hasHoldingCostBasis = costBasis != null
  const totalAssetCostBasis = (costBasis?.reservesCostBasis || 0) + (costBasis?.pendingCostBasis || 0)

  // formatCurrency for balances/totals, formatPrice for prices.
  // Local wrapper preserves this page's trailing-zero-stripped "0.5 BTC" rendering.
  const formatAssetHeld = (n) => formatAsset(n, baseCurrency, { stripTrailingZeros: true })

  const renderProfitCards = () => {
    // Current market value of all asset holdings
    const totalAssetMarketValue = totalAssetHeld * (currentPrice || 0)
    // Float P&L: if we sold everything at current price, what's the profit?
    const floatPnL = totalAssetMarketValue - totalAssetCostBasis
    const floatPnLPct = totalAssetCostBasis > 0 ? (floatPnL / totalAssetCostBasis) * 100 : 0
    const hasRealizedPnL = Number.isFinite(stats.realizedProfit)
    const realizedPnL = stats.realizedProfit
    const assetReserves = state.assetReserves || 0
    const reservesValue = assetReserves * (currentPrice || 0)
    const totalRealizedLiquid = realizedPnL + reservesValue
    return (
      <>
        <StatCard
          label={`${baseCurrency} Mkt Val`}
          value={priceKnown ? formatCurrency(totalAssetMarketValue) : NA}
          subtext={hasHoldingCostBasis ? `Cost: ${formatCurrency(totalAssetCostBasis)}` : 'Cost unavailable'}
          color="blue"
        />
        <StatCard
          label="Float P&L"
          value={hasHoldingCostBasis && priceKnown ? `${signedPrefix(floatPnL)}${formatCurrency(floatPnL)}` : NA}
          subtext={!hasHoldingCostBasis ? 'Unavailable for Fibonacci DCA' : priceKnown ? `${signedPrefix(floatPnLPct)}${floatPnLPct.toFixed(1)}%` : 'Price unavailable'}
          color={!hasHoldingCostBasis || !priceKnown ? 'blue' : floatPnL >= 0 ? 'green' : 'red'}
        />
        <StatCard
          label="Realized"
          value={hasRealizedPnL ? `${signedPrefix(totalRealizedLiquid)}${formatCurrency(totalRealizedLiquid)}` : NA}
          subtext={!hasRealizedPnL ? 'Unavailable for Simple DCA' : assetReserves > 0 ? <span className="flex flex-col leading-tight"><span className="text-white">{formatCurrency(realizedPnL)} USD</span><span className="text-orange-400">+{assetReserves.toFixed(8)} {baseCurrency}</span></span> : null}
          color={!hasRealizedPnL ? 'blue' : totalRealizedLiquid >= 0 ? 'green' : 'red'}
        />
      </>
    )
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Fund Assets */}
      <div className="bg-gray-800 rounded-lg p-4">
        <h3 className="text-xs text-gray-400 mb-2">Fund Assets</h3>
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          <div className="min-w-0">
            <div className="text-base sm:text-lg font-bold text-green-400 truncate">{formatCurrency(state.usdcFundSize)}</div>
            <div className="text-xs text-gray-400">{quoteCurrency}</div>
          </div>
          <div className="min-w-0">
            <div className="text-base sm:text-lg font-bold text-orange-400 truncate">{priceKnown ? formatCurrency(assetValue + pendingAssetValue) : NA}</div>
            <div className="text-xs text-gray-400">{baseCurrency} Value</div>
          </div>
          <div className="min-w-0">
            <div className="text-base sm:text-lg font-bold text-blue-400 truncate">{priceKnown ? formatCurrency((state.usdcFundSize || 0) + assetValue + pendingAssetValue) : NA}</div>
            <div className="text-xs text-gray-400">Total</div>
          </div>
        </div>
        {/* Asset Holdings Breakdown */}
        <div className="mt-3 pt-3 border-t border-gray-700">
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="text-center min-w-0">
              <div className="text-gray-400 mb-1">Pending Sale</div>
              <div className="text-yellow-400 font-semibold truncate">{formatAssetHeld(state.outstandingOrdersAsset || 0)}</div>
              <div className="text-gray-400 truncate">Cost: {hasHoldingCostBasis ? formatCurrency(costBasis.pendingCostBasis || 0) : '—'}</div>
              <div className="text-green-400 truncate">Exp: {formatCurrency(state.outstandingOrdersUSDC || 0)}</div>
            </div>
            <div className="text-center min-w-0">
              <div className="text-gray-400 mb-1">Reserves</div>
              <div className="text-orange-400 font-semibold truncate">{formatAssetHeld(state.assetReserves || 0)}</div>
              <div className="text-gray-400 truncate">Cost: {hasHoldingCostBasis ? formatCurrency(costBasis.reservesCostBasis || 0) : '—'}</div>
              <div className="text-gray-400 truncate">Val: {priceKnown ? formatCurrency(assetValue) : NA}</div>
            </div>
            <div className="text-center min-w-0">
              <div className="text-gray-400 mb-1">Total {baseCurrency}</div>
              <div className="text-purple-400 font-semibold truncate">{formatAssetHeld(totalAssetHeld)}</div>
              <div className="text-gray-400 truncate">Cost: {hasHoldingCostBasis ? formatCurrency(totalAssetCostBasis) : '—'}</div>
              <div className="text-gray-400 truncate">Avg: {hasHoldingCostBasis ? formatPrice(totalAssetHeld > 0 ? totalAssetCostBasis / totalAssetHeld : 0) : '—'}/{baseCurrency}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Stats Grid - 3 rows of 3 */}
      <div className="space-y-2">
        <div className="grid grid-cols-3 sm:grid-cols-3 gap-2">
          <StatCard label="Total Buys" value={stats.totalBuys} color="blue" />
          <StatCard label="Total Sells" value={stats.totalSells} color="green" />
          <StatCard label="Pending" value={stats.pendingOrders} color="yellow" />
        </div>
        <div className="grid grid-cols-3 gap-2">
          {renderProfitCards()}
        </div>
        <div className="grid grid-cols-3 sm:grid-cols-3 gap-2">
          <StatCard label="Fees" value={formatCurrency(stats.totalFees)} color="red" />
          <StatCard label="Rebates" value={formatCurrency(stats.totalRebates)} color="green" />
          <StatCard label="Net Fees" value={formatCurrency(stats.netFees)} color="purple" />
        </div>
      </div>
    </div>
  )
}
