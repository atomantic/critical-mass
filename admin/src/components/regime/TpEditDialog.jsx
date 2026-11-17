import Button from '../ui/Button'
import ModalDialog from '../ModalDialog'

const usd = (value) => value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// Set-TP-target editor for one celestial body (by % above average cost, or by
// limit price). Bespoke rather than a ConfirmDialog: initial focus belongs on
// the active mode's input, not on Cancel, and Confirm's label and enabled state
// depend on the mode. `tp` is the editor state owned by useRegimeDashboardActions
// (null while closed); `setTp` is its setter, so the dialog needs no per-field
// callbacks. The initial-focus marker is used when the dialog opens. React's
// autoFocus handles inputs mounted by a mode switch while it is open.
export default function TpEditDialog({ tp, setTp, busy, onSubmit }) {
  if (!tp) return null
  const close = () => setTp(null)
  return (
    <ModalDialog
      onClose={close}
      dismissible={!busy}
      labelledBy="tp-edit-title"
      describedBy="tp-edit-description"
      maxWidthClassName="max-w-sm"
    >
      <h3 id="tp-edit-title" className="text-white text-lg font-medium mb-1">Set TP Target</h3>
      <p id="tp-edit-description" className="text-gray-400 text-xs font-mono mb-3">body …{tp.bodyLabel}</p>
      {/* Mode tabs */}
      <div className="flex mb-3 border border-gray-600 rounded-sm overflow-hidden">
        <Button
          variant={tp.mode === 'pct' ? 'accent' : 'secondary'} size="compact-xs" className="flex-1 font-medium"
          onClick={() => setTp(prev => ({ ...prev, mode: 'pct' }))}
        >
          Percentage
        </Button>
        <Button
          variant={tp.mode === 'price' ? 'accent' : 'secondary'} size="compact-xs" className="flex-1 font-medium"
          onClick={() => setTp(prev => ({ ...prev, mode: 'price' }))}
        >
          Limit Price
        </Button>
      </div>
      {tp.mode === 'pct' ? (
        <div className="mb-1">
          <label htmlFor="tp-edit-pct-input" className="text-gray-400 text-xs block mb-1">Take-profit % above avg cost</label>
          <div className="flex items-center gap-2">
            <input
              id="tp-edit-pct-input"
              type="number"
              step="0.01"
              min="0.01"
              max="50"
              className="flex-1 bg-gray-900 border border-gray-600 rounded-sm px-3 py-2 text-white font-mono text-sm focus:outline-hidden focus:border-cyan-500"
              value={tp.inputValue}
              onChange={(e) => {
                const value = e.target.value
                const pct = parseFloat(value)
                const newPrice = tp.avgPrice && !isNaN(pct) && pct > 0
                  ? (tp.avgPrice * (1 + pct / 100)).toFixed(2)
                  : tp.priceValue
                setTp(prev => ({ ...prev, inputValue: value, priceValue: newPrice }))
              }}
              onKeyDown={(e) => e.key === 'Enter' && onSubmit('pct')}
              data-dialog-initial-focus
              autoFocus
            />
            <span className="text-gray-400 text-sm">%</span>
          </div>
          {tp.currentTpPct && (
            <p className="text-gray-400 text-xs mt-1">Current: {tp.currentTpPct}%</p>
          )}
          {tp.avgPrice && tp.inputValue && !isNaN(parseFloat(tp.inputValue)) && (
            <p className="text-gray-400 text-xs mt-0.5">= ${usd(tp.avgPrice * (1 + parseFloat(tp.inputValue) / 100))}</p>
          )}
        </div>
      ) : (
        <div className="mb-1">
          <label htmlFor="tp-edit-price-input" className="text-gray-400 text-xs block mb-1">Limit sell price (USD)</label>
          <div className="flex items-center gap-2">
            <span className="text-gray-400 text-sm">$</span>
            <input
              id="tp-edit-price-input"
              type="number"
              step="0.01"
              min="0.01"
              className="flex-1 bg-gray-900 border border-gray-600 rounded-sm px-3 py-2 text-white font-mono text-sm focus:outline-hidden focus:border-cyan-500"
              value={tp.priceValue}
              onChange={(e) => {
                const value = e.target.value
                const price = parseFloat(value)
                const newPct = tp.avgPrice && !isNaN(price) && price > tp.avgPrice
                  ? (((price - tp.avgPrice) / tp.avgPrice) * 100).toFixed(2)
                  : tp.inputValue
                setTp(prev => ({ ...prev, priceValue: value, inputValue: newPct }))
              }}
              onKeyDown={(e) => e.key === 'Enter' && onSubmit('price')}
              data-dialog-initial-focus
              autoFocus
            />
          </div>
          {tp.currentPrice && (
            <p className="text-gray-400 text-xs mt-1">Current: ${usd(tp.currentPrice)}</p>
          )}
          {tp.avgPrice && tp.priceValue && !isNaN(parseFloat(tp.priceValue)) && parseFloat(tp.priceValue) > tp.avgPrice && (
            <p className="text-gray-400 text-xs mt-0.5">= {(((parseFloat(tp.priceValue) - tp.avgPrice) / tp.avgPrice) * 100).toFixed(2)}% above avg cost</p>
          )}
          {tp.avgPrice && (
            <p className="text-gray-400 text-xs mt-0.5">Avg cost: ${usd(tp.avgPrice)}</p>
          )}
        </div>
      )}
      <div className="flex justify-end gap-3 mt-4">
        <Button variant="cancel"
          onClick={close}
          disabled={busy}
        >
          Cancel
        </Button>
        {tp.mode === 'pct' ? (
          <Button variant="accent"
            onClick={() => onSubmit('pct')}
            disabled={busy || !tp.inputValue || parseFloat(tp.inputValue) <= 0}
          >
            {busy ? 'Placing...' : 'Set TP%'}
          </Button>
        ) : (
          <Button variant="accent"
            onClick={() => onSubmit('price')}
            disabled={busy || !tp.priceValue || parseFloat(tp.priceValue) <= (tp.avgPrice || 0)}
          >
            {busy ? 'Placing...' : 'Set Price'}
          </Button>
        )}
      </div>
    </ModalDialog>
  )
}
