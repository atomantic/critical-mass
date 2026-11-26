import ConfirmDialog from '../ui/ConfirmDialog'
import AddFundModal from '../AddFundModal'
import findFund from '../../utils/findFund'

// Fund lifecycle confirmation dialogs (close, reopen, reset dry-run) and the
// Add Fund modal, in the DOM order the shell has always used.
export default function FundLifecycleDialogs({
  currentExchange, currentPair, exchanges, navigate, addToast, fetchExchanges,
  closeFundDialogOpen, setCloseFundDialogOpen, closeFundReason, setCloseFundReason, closing, submitCloseFund,
  addFundDialogOpen, setAddFundDialogOpen,
  reopenFundDialogOpen, setReopenFundDialogOpen, reopening, submitReopenFund,
  resetDryRunConfirm, setResetDryRunConfirm, resetting, handleExecuteResetDryRun,
}) {
  return (
    <>
      {/* Close Fund confirmation dialog */}
      {closeFundDialogOpen && (
        <ConfirmDialog
          id="close-fund"
          title={<>Close <span className="font-mono text-yellow-400">{currentExchange}/{currentPair}</span>?</>}
          description={<>
            This blocks all new entries immediately. Existing take-profit orders
            will remain in place, and the fund will close automatically
            after the current cycle's TP fills.
          </>}
          descriptionClassName="text-gray-300 text-sm mb-2"
          confirmLabel="Close Fund"
          busyLabel="Closing..."
          confirmVariant="warning"
          busy={closing}
          onConfirm={submitCloseFund}
          onClose={() => setCloseFundDialogOpen(false)}
        >
          <p className="text-gray-400 text-xs mb-4">
            You can reopen the fund later, but it will not auto-resume on engine restart.
          </p>
          <div className="mb-4">
            <label htmlFor="close-fund-reason" className="block text-xs uppercase tracking-wider text-gray-400 mb-1">
              Reason (optional)
            </label>
            <input
              id="close-fund-reason"
              type="text"
              value={closeFundReason}
              onChange={(e) => setCloseFundReason(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitCloseFund()}
              placeholder="e.g. winding down for tax season"
              className="w-full bg-gray-900 border border-gray-700 rounded-sm px-3 py-2 text-white text-sm focus:border-yellow-500 focus:outline-hidden"
              disabled={closing}
            />
          </div>
        </ConfirmDialog>
      )}

      {/* Add Fund modal (triggered from Overview or ExchangeSelector) */}
      <AddFundModal
        open={addFundDialogOpen}
        onClose={() => setAddFundDialogOpen(false)}
        exchanges={exchanges}
        onCreated={async ({ exchange, pair }) => {
          const funds = await fetchExchanges()
          const fundAvailable = funds && findFund(funds, exchange, pair)
          if (fundAvailable) navigate(`/${exchange}/${pair}/config`)
          addToast({
            type: 'success',
            title: `Fund created: ${exchange}/${pair}`,
            message: 'Review the config, then press Start in the fund header to begin trading.',
          })
          if (!fundAvailable) {
            addToast({
              type: 'warning',
              title: 'Fund list not refreshed',
              message: `${exchange}/${pair} was created, but the fund list does not show it yet. Reload the page before making more changes.`,
            })
          }
        }}
      />

      {/* Reopen Fund confirmation dialog */}
      {reopenFundDialogOpen && (
        <ConfirmDialog
          id="reopen-fund"
          title={<>Reopen <span className="font-mono text-blue-400">{currentExchange}/{currentPair}</span>?</>}
          description={<>
            This restores the fund's lifecycle to <span className="text-green-400">active</span> so the
            regime engine can run again.
          </>}
          descriptionClassName="text-gray-300 text-sm mb-2"
          confirmLabel="Reopen Fund"
          busyLabel="Reopening..."
          variant="default"
          busy={reopening}
          onConfirm={submitReopenFund}
          onClose={() => setReopenFundDialogOpen(false)}
        >
          <p className="text-gray-400 text-xs mb-4">
            Reopening does <strong>not</strong> restart the engine. After confirming, click
            <span className="font-mono text-green-400"> Start </span>
            to resume trading.
          </p>
        </ConfirmDialog>
      )}

      {/* Reset Dry-Run confirmation dialog */}
      {resetDryRunConfirm && (
        <ConfirmDialog
          id="reset-dry-run"
          title="Reset Dry-Run State"
          description={<>Clear simulated trading history for <span className="font-mono text-purple-400">{currentExchange}/{currentPair}</span>?</>}
          confirmLabel="Reset Dry-Run"
          busyLabel="Resetting…"
          confirmVariant="purple"
          busy={resetting}
          onConfirm={handleExecuteResetDryRun}
          onClose={() => setResetDryRunConfirm(false)}
        >
          <p className="text-gray-400 text-xs mb-4">
            This wipes the in-memory dry-run history. Live positions and fills are not affected.
          </p>
        </ConfirmDialog>
      )}
    </>
  )
}
