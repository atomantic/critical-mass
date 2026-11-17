import { useId } from 'react'
import Button from './Button'
import ModalDialog from '../ModalDialog'

// Shared confirmation dialog: title / description / extra body / Cancel / Confirm
// on the native-<dialog> ModalDialog. Controlled: the owner of the action keeps
// the pending (`busy`) and failure (`error`) state, and the dialog is mounted
// only while open (ModalDialog's mount-once contract).
//
// - `busy` disables Cancel and Confirm, swaps the Confirm label for `busyLabel`,
//   and makes Escape / backdrop dismissal a no-op (`dismissible={!busy}`).
// - Cancel always carries autoFocus; put inputs in `children` only when the
//   default focus on Cancel is still right (a dialog that must focus an input
//   is bespoke, like the TP editor).
// - `extraActions` renders after Confirm (e.g. a guarded "force" action).
// - `variant` picks the Confirm colour: `danger` is the destructive red,
//   `default` the primary blue. `confirmVariant` names any other Button variant
//   (warning, caution, success, purple) for flows that keep a distinct tone.
const VARIANT_BUTTON = { danger: 'destructive', default: 'primary' }

export default function ConfirmDialog({
  id,
  title,
  description,
  children,
  confirmLabel,
  busyLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  onClose,
  variant = 'danger',
  confirmVariant,
  cancelVariant = 'cancel',
  busy = false,
  confirmDisabled = false,
  error = '',
  touchTarget,
  titleAs: Title = 'h3',
  titleClassName = 'text-white text-lg font-medium mb-3',
  descriptionClassName = 'text-gray-300 text-sm mb-4',
  actionsClassName = 'flex justify-end gap-3',
  errorClassName = 'mt-3 text-red-300',
  buttonClassName,
  extraActions,
}) {
  const autoId = useId()
  const base = id ?? autoId
  const titleId = `${base}-title`
  const descriptionId = `${base}-description`
  return (
    <ModalDialog labelledBy={titleId} describedBy={descriptionId} dismissible={!busy} onClose={onClose}>
      <Title id={titleId} className={titleClassName}>{title}</Title>
      <p id={descriptionId} className={descriptionClassName}>{description}</p>
      {children}
      {error && <p role="alert" className={errorClassName}>{error}</p>}
      <div className={actionsClassName}>
        <Button variant={cancelVariant} touchTarget={touchTarget} className={buttonClassName} onClick={onClose} disabled={busy} autoFocus>
          {cancelLabel}
        </Button>
        <Button variant={confirmVariant ?? VARIANT_BUTTON[variant] ?? 'destructive'} touchTarget={touchTarget} className={buttonClassName} onClick={onConfirm} disabled={busy || confirmDisabled}>
          {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
        </Button>
        {extraActions}
      </div>
    </ModalDialog>
  )
}
