import { useEffect, useRef } from 'react'

/**
 * ModalDialog — shared native <dialog> wrapper for fund-operation confirmations.
 *
 * Wraps the ad-hoc `<div class="fixed inset-0 ...">` overlays used for fund
 * close/reopen and regime body actions (collapse, reset cycle, resume from
 * drawdown, roll-up, TP edit, DCA conversion) in a single native `<dialog>`
 * element so the browser provides real modal semantics for free: an
 * accessible dialog role, focus containment within the dialog, and
 * background-inert behavior — instead of hand-rolled focus-trap code.
 *
 * This component is designed to be mounted only while the dialog should be
 * open (`{someFlag && <ModalDialog>...}`), matching the existing call-site
 * pattern. It calls `showModal()` on mount and lets the browser own focus
 * containment; put `autoFocus` on whichever child element should receive
 * initial focus (usually the Cancel button, or a labelled input for the TP
 * editor) — `<dialog>.showModal()` honors the `autofocus` attribute.
 *
 * `dismissible` gates both Escape and backdrop-click dismissal so pending
 * in-flight actions (e.g. `disabled={closing}` on the existing buttons) can
 * keep the dialog open the same way they already disable Cancel/Confirm.
 */
function ModalDialog({ onClose, labelledBy, describedBy, dismissible = true, maxWidthClassName = 'max-w-md', className = '', children }) {
  const dialogRef = useRef(null)
  const previouslyFocusedRef = useRef(null)
  const dismissibleRef = useRef(dismissible)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    dismissibleRef.current = dismissible
  }, [dismissible])

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  // Mount-once: this component only exists in the tree while the dialog
  // should be open, so opening/closing is driven by mount/unmount rather
  // than a separate `open` prop.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return undefined

    previouslyFocusedRef.current = document.activeElement
    dialog.showModal()

    const handleCancel = (event) => {
      // Escape fires 'cancel' before closing — block it while a pending
      // action guard is active, mirroring the disabled Cancel/Confirm buttons.
      if (!dismissibleRef.current) event.preventDefault()
    }
    const handleClose = () => {
      previouslyFocusedRef.current?.focus?.()
      onCloseRef.current?.()
    }

    dialog.addEventListener('cancel', handleCancel)
    dialog.addEventListener('close', handleClose)
    return () => {
      dialog.removeEventListener('cancel', handleCancel)
      dialog.removeEventListener('close', handleClose)
      // Restore focus even if the parent unmounted us directly (e.g. its
      // "open" state flipped to null/false without going through the
      // dialog's own close()).
      previouslyFocusedRef.current?.focus?.()
    }
  }, [])

  const handleBackdropClick = (event) => {
    // The <dialog> box is sized to exactly match its single child (the
    // padded wrapper below), so a click whose target is the dialog itself —
    // rather than the wrapper or anything inside it — landed on the
    // ::backdrop area outside the visible card, i.e. a real backdrop click.
    if (event.target === dialogRef.current && dismissibleRef.current) {
      dialogRef.current?.close()
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onClick={handleBackdropClick}
      className={`bg-gray-800 border border-gray-600 rounded-lg ${maxWidthClassName} w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] overflow-y-auto backdrop:bg-black/60 ${className}`}
    >
      <div className="p-6">{children}</div>
    </dialog>
  )
}

export default ModalDialog
