import ConfirmDialog from '../ui/ConfirmDialog'
import { plural } from '../../utils/plural.mjs'
import { getBaseCurrency, getQuoteCurrency } from '../../utils/productId.mjs'

// DCA-to-regime conversion confirmation, owned by useDcaConversion. `preview`
// is the server's conversion preview; the dialog is closed while it is null.
export default function DcaConvertDialog({ preview, busy, onClose, onConfirm }) {
  if (!preview) return null
  const asset = getBaseCurrency(preview.productId)
  const quote = getQuoteCurrency(preview.productId)
  return (
    <ConfirmDialog
      id="convert-dca"
      title={preview.merge ? 'Import DCA Orders' : 'Upgrade DCA Orders'}
      description={preview.merge
        ? `Merge DCA positions into the existing regime engine (${plural(preview.existingBodies, 'body', 'bodies')}, ${preview.existingAsset?.toFixed(8)} ${asset}). Existing DCA sell orders may remain open on the exchange, but the regime engine will not track them. Before starting the regime engine, cancel those DCA sell orders on the exchange and confirm that they are no longer open. The regime engine will place new take-profit orders when started.`
        : 'Import DCA positions into the regime engine. Existing DCA sell orders may remain open on the exchange, but the regime engine will not track them. Before starting the regime engine, cancel those DCA sell orders on the exchange and confirm that they are no longer open. The regime engine will place new take-profit orders when started.'}
      variant="default"
      confirmLabel={preview.merge ? 'Confirm Import' : 'Confirm Upgrade'}
      busyLabel={preview.merge ? 'Importing…' : 'Upgrading…'}
      busy={busy}
      onClose={onClose}
      onConfirm={onConfirm}
    >
      <div className="bg-gray-900 rounded-lg p-3 mb-4 text-sm space-y-1.5">
        <div className="flex justify-between">
          <span className="text-gray-400">Open positions (pending sells)</span>
          <span className="text-white font-mono">{preview.pending}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">Completed orders</span>
          <span className="text-white font-mono">{preview.filled}</span>
        </div>
        {preview.skipped > 0 && (
          <div className="flex justify-between">
            <span className="text-gray-400">Skipped (consolidated sources)</span>
            <span className="text-gray-400 font-mono">{preview.skipped}</span>
          </div>
        )}
        <div className="border-t border-gray-700 pt-1.5 flex justify-between">
          <span className="text-gray-400">Pending {asset}</span>
          <span className="text-yellow-400 font-mono">{preview.pendingBaseQty?.toFixed(8)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">Pending cost basis</span>
          <span className="text-yellow-400 font-mono">{quote.startsWith('USD') ? '$' : ''}{preview.pendingCostBasis?.toFixed(2)}{!quote.startsWith('USD') ? ` ${quote}` : ''}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">Total filled {asset}</span>
          <span className="text-green-400 font-mono">{preview.totalBaseQty?.toFixed(8)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">Total cost basis</span>
          <span className="text-green-400 font-mono">{quote.startsWith('USD') ? '$' : ''}{preview.totalCostBasis?.toFixed(2)}{!quote.startsWith('USD') ? ` ${quote}` : ''}</span>
        </div>
      </div>
      <p className="text-gray-400 text-xs mb-4">
        {preview.merge
          ? 'This will create backup files and add celestial bodies to the existing regime position. Before starting the regime engine, cancel any remaining DCA sell orders on the exchange and confirm that they are no longer open.'
          : 'This will disable the DCA engine, create backup files, and build regime state with celestial bodies for each open position. Before starting the regime engine, cancel any remaining DCA sell orders on the exchange and confirm that they are no longer open.'}
      </p>
    </ConfirmDialog>
  )
}
