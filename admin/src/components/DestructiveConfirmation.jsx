import { useRef, useState } from 'react'
import ConfirmDialog from './ui/ConfirmDialog'

// ConfirmDialog plus the pending / error state of a single async confirm:
// runs onConfirm, closes on success, and keeps the dialog open with the
// failure message otherwise.
export default function DestructiveConfirmation({ title, children, confirmLabel, onConfirm, onClose }) {
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const confirm = async () => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await onConfirm()
      onClose()
    } catch (error) {
      setError(error.message || 'Unable to complete this action. Please try again.')
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return (
    <ConfirmDialog
      title={title}
      description={children}
      confirmLabel={confirmLabel}
      busyLabel="Working..."
      onConfirm={confirm}
      onClose={onClose}
      busy={busy}
      error={error}
      cancelVariant="secondary"
      touchTarget="always"
      titleAs="h2"
      titleClassName="text-lg font-semibold text-white"
      descriptionClassName="mt-3 text-gray-300"
      actionsClassName="mt-5 flex justify-end gap-3"
    />
  )
}
