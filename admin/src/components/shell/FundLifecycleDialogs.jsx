import ModalDialog from '../ModalDialog'
import AddFundModal from '../AddFundModal'
import Button from '../ui/Button'

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
        <ModalDialog
          onClose={() => setCloseFundDialogOpen(false)}
          dismissible={!closing}
          labelledBy="close-fund-title"
          describedBy="close-fund-description"
        >
          <h3 id="close-fund-title" className="text-white text-lg font-medium mb-3">
            Close <span className="font-mono text-yellow-400">{currentExchange}/{currentPair}</span>?
          </h3>
          <p id="close-fund-description" className="text-gray-300 text-sm mb-2">
            This blocks all new entries immediately. Existing take-profit orders
            will remain in place, and the fund will close automatically
            after the current cycle's TP fills.
          </p>
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
          <div className="flex justify-end gap-3">
            <Button variant="cancel"
              onClick={() => setCloseFundDialogOpen(false)}
              disabled={closing}
              autoFocus
            >
              Cancel
            </Button>
            <Button variant="warning"
              onClick={submitCloseFund}
              disabled={closing}
            >
              {closing ? 'Closing...' : 'Close Fund'}
            </Button>
          </div>
        </ModalDialog>
      )}

      {/* Add Fund modal (triggered from ExchangeSelector dropdown) */}
      <AddFundModal
        open={addFundDialogOpen}
        onClose={() => setAddFundDialogOpen(false)}
        exchanges={exchanges}
        onCreated={async ({ exchange, pair }) => {
          const refreshed = await fetchExchanges()
          navigate(`/${exchange}/${pair}/config`)
          addToast({
            type: 'success',
            title: `Fund created: ${exchange}/${pair}`,
            message: 'Review the config, then press Start in the fund header to begin trading.',
          })
          if (!refreshed) {
            addToast({
              type: 'warning',
              title: 'Fund list not refreshed',
              message: `${exchange}/${pair} was created, but the fund list could not be reloaded. Do not create it again; use Refresh Exchanges.`,
            })
          }
        }}
      />

      {/* Reopen Fund confirmation dialog */}
      {reopenFundDialogOpen && (
        <ModalDialog
          onClose={() => setReopenFundDialogOpen(false)}
          dismissible={!reopening}
          labelledBy="reopen-fund-title"
          describedBy="reopen-fund-description"
        >
          <h3 id="reopen-fund-title" className="text-white text-lg font-medium mb-3">
            Reopen <span className="font-mono text-blue-400">{currentExchange}/{currentPair}</span>?
          </h3>
          <p id="reopen-fund-description" className="text-gray-300 text-sm mb-2">
            This restores the fund's lifecycle to <span className="text-green-400">active</span> so the
            regime engine can run again.
          </p>
          <p className="text-gray-400 text-xs mb-4">
            Reopening does <strong>not</strong> restart the engine. After confirming, click
            <span className="font-mono text-green-400"> Start </span>
            to resume trading.
          </p>
          <div className="flex justify-end gap-3">
            <Button variant="cancel"
              onClick={() => setReopenFundDialogOpen(false)}
              disabled={reopening}
              autoFocus
            >
              Cancel
            </Button>
            <Button
              onClick={submitReopenFund}
              disabled={reopening}
            >
              {reopening ? 'Reopening...' : 'Reopen Fund'}
            </Button>
          </div>
        </ModalDialog>
      )}

      {/* Reset Dry-Run confirmation dialog */}
      {resetDryRunConfirm && (
        <ModalDialog
          onClose={() => setResetDryRunConfirm(false)}
          dismissible={!resetting}
          labelledBy="reset-dry-run-title"
          describedBy="reset-dry-run-description"
        >
          <h3 id="reset-dry-run-title" className="text-white text-lg font-medium mb-3">Reset Dry-Run State</h3>
          <p id="reset-dry-run-description" className="text-gray-300 text-sm mb-4">
            Clear simulated trading history for <span className="font-mono text-purple-400">{currentExchange}/{currentPair}</span>?
          </p>
          <p className="text-gray-400 text-xs mb-4">
            This wipes the in-memory dry-run history. Live positions and fills are not affected.
          </p>
          <div className="flex justify-end gap-3">
            <Button variant="cancel"
              onClick={() => setResetDryRunConfirm(false)}
              disabled={resetting}
              autoFocus
            >
              Cancel
            </Button>
            <Button variant="purple"
              onClick={handleExecuteResetDryRun}
              disabled={resetting}
            >
              {resetting ? 'Resetting…' : 'Reset Dry-Run'}
            </Button>
          </div>
        </ModalDialog>
      )}
    </>
  )
}
