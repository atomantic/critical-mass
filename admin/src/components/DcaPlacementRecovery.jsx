import { useRef, useState } from 'react'
import ModalDialog from './ModalDialog'
import { pairQuery } from '../utils/api'

// An unknown placement outcome blocks every subsequent DCA interval. This
// panel is independent of failed sells: the stranded placement may be a buy.
function DcaPlacementRecovery({ intents = [], exchange, pair, onResolved }) {
  const [confirmation, setConfirmation] = useState(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const pendingRef = useRef(false)
  const blocking = (intents || []).filter(intent => intent?.needsAttention)

  const open = (intent) => {
    setError(null)
    setNotice(null)
    setConfirmation({ intent })
  }

  const reconcile = async () => {
    if (!confirmation || pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    setError(null)
    const { intent } = confirmation
    try {
      const response = await fetch(`/api/${exchange}/reconcile-placement-intent${pairQuery(pair)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intentId: intent.id, action: 'discard' }),
      })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error || data.message || 'Reconciliation was rejected')
      setConfirmation(null)
      setNotice(data.message || 'Placement intent discarded. This fund can place orders again.')
      try {
        await onResolved?.(data)
      } catch {
        // The mutation succeeded. A failed follow-up read must not invite the
        // user to repeat it under a misleading "reconciliation failed" error.
        setError('Placement reconciled, but the dashboard could not refresh. Reload to read the current status.')
      }
    } catch (err) {
      setError(`${err.message || 'Could not reconcile the placement'}. The outcome may still be unresolved; check status before retrying.`)
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }

  if (!blocking.length && !notice && !error) return null

  return (
    <section id="dca-placement-recovery" aria-label="DCA placement recovery" className="bg-amber-900/30 border border-amber-600 rounded-lg p-4">
      {blocking.length > 0 && <>
        <h3 className="text-sm font-semibold text-amber-300 mb-2">Unresolved Placements ({blocking.length})</h3>
        <p className="text-sm text-gray-200 mb-3">
          Automation is blocked because an earlier order may already exist on the exchange. Reconcile it here before this fund places another order.
        </p>
        <div className="space-y-3">
          {blocking.map(intent => {
            const unreadable = intent.id === 'unreadable-intent-file'
            return (
              <div key={intent.id} className="bg-gray-900/60 rounded-sm p-3 text-xs space-y-2">
                <div className="font-mono break-all">{intent.action || 'order'} · {intent.side || '?'} · intent {intent.id}</div>
                <div className="text-gray-300 break-words">
                  {intent.productId || pair} · {intent.size != null ? `Amount ${intent.size}` : `Quote amount ${intent.sizeUsdc ?? 'unknown'}`}
                  {intent.price != null ? ` · Price ${intent.price}` : ''}
                  {intent.createdAt ? ` · Placed ${new Date(intent.createdAt).toLocaleString()}` : ''}
                </div>
                {intent.clientOrderId && <div className="font-mono break-all">Client order {intent.clientOrderId}</div>}
                {intent.reason && <p className="text-amber-200 break-words">{intent.reason}</p>}
                <p className="text-gray-300 break-words">
                  {unreadable ? intent.recoveryHint
                    : 'Check open orders and recent fills on the exchange. Cancel any live order from this placement and reconcile any executions in the fund records before discarding the intent.'}
                </p>
                {!unreadable && <div className="flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => open(intent)} disabled={pending}
                    className="min-h-11 px-3 py-2 bg-amber-700 hover:bg-amber-800 rounded-sm disabled:opacity-50">
                    Discard
                  </button>
                  {!intent.clientOrderId && <span className="text-gray-300">No client order id was recorded; check the placement time, side and amount on the exchange.</span>}
                </div>}
              </div>
            )
          })}
        </div>
      </>}
      {notice && <p role="status" className="mt-3 text-sm text-green-300">{notice}</p>}
      {!confirmation && error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
      {confirmation && (
        <ModalDialog onClose={() => { if (!pendingRef.current) setConfirmation(null) }} dismissible={!pending}
          labelledBy="dca-reconcile-title" describedBy="dca-reconcile-description">
          <h3 id="dca-reconcile-title" className="text-lg font-medium mb-3">
            Discard the placement intent
          </h3>
          <p id="dca-reconcile-description" className="text-sm text-gray-300 mb-3">
            Only discard after checking the exchange and confirming this placement has no live order and any fills have been accounted for. Clearing it allows new orders against this capital. This does not cancel an exchange order or book its fills.
          </p>
          <p className="font-mono text-xs break-all mb-3">Intent {confirmation.intent.id}</p>
          {error && <p role="alert" className="text-sm text-red-300 mb-3">{error}</p>}
          <div className="flex flex-wrap justify-end gap-3">
            <button type="button" autoFocus disabled={pending} onClick={() => setConfirmation(null)}
              className="min-h-11 px-4 py-2 bg-gray-700 rounded-sm disabled:opacity-50">Cancel</button>
            <button type="button" disabled={pending} onClick={reconcile}
              className="min-h-11 px-4 py-2 bg-amber-700 rounded-sm disabled:opacity-50">
              {pending ? 'Working…' : 'Discard intent'}
            </button>
          </div>
        </ModalDialog>
      )}
    </section>
  )
}

export default DcaPlacementRecovery
