import ConfirmDialog from '../ui/ConfirmDialog'

// The confirmations for the actions owned by useRegimeDashboardActions. Each is
// mounted by the dashboard next to the control state it reads, renders nothing
// while closed, and is given only its own open flag, pending flag and handlers.

export function CancelLadderConfirmation({ open, busy, orderCount, onClose, onConfirm }) {
  if (!open) return null
  return (
    <ConfirmDialog
      id="cancel-ladder"
      title="Cancel ladder orders?"
      description={<>
        Cancels <span className="text-amber-300 font-medium">{orderCount}</span> resting ladder buy order{orderCount !== 1 ? 's' : ''} on the exchange and switches this fund's Entry mode from LADDER to REACTIVE.
      </>}
      cancelLabel="Keep ladder"
      confirmLabel="Cancel ladder orders"
      busyLabel="Cancelling orders…"
      busy={busy}
      onClose={onClose}
      onConfirm={onConfirm}
    >
      <p className="text-gray-400 text-xs mb-4">
        The fund will no longer place new ladder orders and will only enter positions through reactive buys (market, fill-or-kill).
      </p>
    </ConfirmDialog>
  )
}

export function CollapseAllConfirmation({ open, busy, bodyCount, onClose, onConfirm }) {
  if (!open) return null
  return (
    <ConfirmDialog
      id="collapse-all"
      title="Collapse All Bodies"
      description={<>
        Cancel <span className="text-amber-300 font-medium">{bodyCount}</span> body TP orders, combine all buys into a single body, and place one new TP order.
      </>}
      cancelLabel="Keep bodies"
      confirmLabel="Collapse All"
      busyLabel="Collapsing…"
      confirmVariant="caution"
      busy={busy}
      onClose={onClose}
      onConfirm={onConfirm}
    >
      <p className="text-gray-400 text-xs mb-4">
        Aborts if any TP has a partial fill. Final TP% is capped at the highest body's pre-merge TP%, so the combined sell price can only move down.
      </p>
    </ConfirmDialog>
  )
}

export function ResetCycleConfirmation({ open, busy, cycleBuys, maxCycleBuys, onClose, onConfirm }) {
  if (!open) return null
  return (
    <ConfirmDialog
      id="reset-cycle"
      title="Reset Cycle & Resume Buying"
      description="Starts a new accumulation cycle so the bot resumes buying. Your open positions and their take-profit orders are preserved."
      confirmLabel="Reset cycle & resume buying"
      busyLabel="Resetting…"
      confirmVariant="warning"
      busy={busy}
      onClose={onClose}
      onConfirm={onConfirm}
    >
      <p className="text-gray-400 text-xs mb-4">
        Resets the cycle buy counter ({cycleBuys}/{maxCycleBuys}) to 0. The reset is persistent and survives an engine restart.
      </p>
    </ConfirmDialog>
  )
}

// No in-flight flag: the handler closes the dialog before it posts.
export function ResumeDrawdownConfirmation({ open, onClose, onConfirm }) {
  if (!open) return null
  return (
    <ConfirmDialog
      id="drawdown-resume"
      title="Resume from Drawdown Pause"
      description="Resume trading from the drawdown pause? This resets the peak equity to current levels."
      confirmLabel="Resume Trading"
      confirmVariant="success"
      onClose={onClose}
      onConfirm={onConfirm}
    />
  )
}

export function RollUpConfirmation({ rollUp, busy, onClose, onConfirm }) {
  if (!rollUp) return null
  return (
    <ConfirmDialog
      id="roll-up"
      title="Roll Up Body"
      description={<>
        Merge body <span className="font-mono text-yellow-400">{rollUp.bodyLabel}</span> into <span className="font-mono text-green-400">{rollUp.targetLabel}</span>?
      </>}
      cancelLabel="Keep separate"
      confirmLabel="Roll Up"
      busyLabel="Merging..."
      confirmVariant="warning"
      busy={busy}
      onClose={onClose}
      onConfirm={() => onConfirm(rollUp.bodyId)}
    >
      <p className="text-gray-400 text-xs mb-4">
        Both TP orders will be cancelled, buys combined, and a new TP placed for the merged body.
      </p>
    </ConfirmDialog>
  )
}
