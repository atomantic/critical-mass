import Button from './ui/Button'
function DcaPendingBuyRecovery({ pendingBuy, busy, dryRun, placementIntents = [], onResume, notice }) {
  if (!pendingBuy && !notice) return null
  const blocked = placementIntents.some(intent => intent.needsAttention)
  return (
    <section aria-label="DCA buy fill recovery" className="bg-amber-900/30 border border-amber-600 rounded-lg p-4 space-y-2">
      {pendingBuy && <>
        <h3 className="text-sm font-semibold text-amber-300">Buy awaiting fill recovery</h3>
        <p className="text-sm text-gray-200">
          The exchange accepted this buy, but its fill is unconfirmed. Further buys are withheld until it settles.
          Resume recovery to check this order and record its fill and covering sell. This action cannot place another buy.
        </p>
        <p className="text-xs font-mono break-all">Order {pendingBuy.orderId} · Interval {pendingBuy.runId || 'unknown'}</p>
        {pendingBuy.clientOrderId && <p className="text-xs font-mono break-all">Client order {pendingBuy.clientOrderId}</p>}
        {pendingBuy.lastError && <p className="text-sm text-amber-200 break-words">{pendingBuy.lastError}</p>}
        <Button type="button" onClick={() => onResume(pendingBuy.orderId)} disabled={busy || dryRun || blocked}
          variant="caution" size="md" touchTarget="always">
          {busy ? 'Checking buy…' : 'Resume buy recovery'}
        </Button>
        {dryRun && <p className="text-sm text-gray-200">Turn off Dry Run in the controls below to recover this live buy.</p>}
        {blocked && <p className="text-sm text-gray-200">Recovery is blocked by an unresolved placement. <a href="#dca-placement-recovery" className="text-blue-300 underline">Reconcile the placement above</a> first.</p>}
      </>}
      {notice && <p role={notice.error ? 'alert' : 'status'} className={`text-sm break-words ${notice.error ? 'text-red-300' : 'text-green-300'}`}>{notice.message}</p>}
    </section>
  )
}

export default DcaPendingBuyRecovery
