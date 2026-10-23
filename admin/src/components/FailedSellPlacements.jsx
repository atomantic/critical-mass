import Button from './ui/Button'
import { formatPrice, formatAsset } from './charts/chartUtils'

const formatTimestamp = (iso) => new Date(iso).toISOString().replace('T', ' ').slice(0, 19)

/**
 * Simple DCA buys whose covering sell could not be placed (state.json rows in
 * status 'sell_failed', issue #1035). Fed from the live /status read — the
 * authoritative DCA state — never from the regime-derived summary, so a failed
 * row stays visible after reload even with no pending sells.
 *
 * Retry is disabled while any placement intent on the fund needs attention:
 * the server refuses then too, and the intent's recovery hint is the next step.
 */
function FailedSellPlacements({ failedSells = [], placementIntents = [], baseCurrency, retryingBuyId = null, onRetry }) {
  if (!failedSells?.length) return null

  const blockingIntents = (placementIntents || []).filter(intent => intent.needsAttention)
  const retryDisabled = retryingBuyId !== null || blockingIntents.length > 0

  return (
    <div className="bg-red-900/30 border border-red-700 rounded-lg p-4" data-testid="failed-sell-placements">
      <h3 className="text-sm font-semibold text-red-300 mb-1">Failed Sell Placements ({failedSells.length})</h3>
      <p className="text-xs text-gray-300 mb-3">
        These buys are booked but no sell order covers them. Retry sell places the sell for that original buy only — it never buys again.
      </p>
      {blockingIntents.length > 0 && (
        <div className="mb-3 p-2 rounded bg-yellow-900/40 border border-yellow-700 text-xs text-yellow-200 space-y-1" data-testid="failed-sell-blocked">
          <div className="font-semibold">Retry is blocked: an earlier placement outcome on this fund is unknown.</div>
          <a href="#dca-placement-recovery" className="underline">Resolve the blocked placement above</a>
          {blockingIntents.map(intent => (
            <div key={intent.id} className="break-words">
              Intent <span className="font-mono">{intent.id}</span>
              {intent.clientOrderId && <> (client order <span className="font-mono">{intent.clientOrderId}</span>)</>}: {intent.recoveryHint}
            </div>
          ))}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-400 text-left">
              <th className="pb-2">Buy ID</th>
              <th className="pb-2">Bought</th>
              <th className="pb-2">Buy Price</th>
              <th className="pb-2">Failure</th>
              <th className="pb-2"><span className="sr-only">Action</span></th>
            </tr>
          </thead>
          <tbody>
            {failedSells.map(order => (
              <tr key={order.buyOrderId} className="border-t border-red-800/60 align-top">
                <td className="py-2 pr-2 font-mono break-all">{order.buyOrderId}</td>
                <td className="py-2 pr-2 whitespace-nowrap">{formatAsset(order.buyQuantity || 0, baseCurrency, { stripTrailingZeros: true })}</td>
                <td className="py-2 pr-2 whitespace-nowrap">{formatPrice(order.buyPrice)}</td>
                <td className="py-2 pr-2 text-red-200 break-words">
                  {order.sellFailedReason || 'Unknown reason'}
                  {order.sellPlacementUnresolved && (
                    <div className="text-yellow-300 mt-1">
                      Earlier sell outcome unknown (intent <span className="font-mono">{order.sellPlacementUnresolved.intentId}</span>
                      {order.sellPlacementUnresolved.clientOrderId && <>, client order <span className="font-mono">{order.sellPlacementUnresolved.clientOrderId}</span></>}) — reconcile before retrying.
                    </div>
                  )}
                  {order.sellFailedAt && <div className="text-gray-400 mt-1">{formatTimestamp(order.sellFailedAt)}</div>}
                </td>
                <td className="py-2 text-right">
                  <Button
                    type="button"
                    onClick={() => onRetry?.(order.buyOrderId)}
                    disabled={retryDisabled}
                    variant="destructive" size="xs" className="font-medium whitespace-nowrap"
                  >
                    {retryingBuyId === order.buyOrderId ? 'Retrying...' : 'Retry sell'}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default FailedSellPlacements
