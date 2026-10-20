import { useId, useRef, useState } from 'react'
import ModalDialog from './ModalDialog'

export default function DestructiveConfirmation({ title, children, confirmLabel, onConfirm, onClose }) {
  const titleId = useId()
  const bodyId = useId()
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
    <ModalDialog labelledBy={titleId} describedBy={bodyId} dismissible={!busy} onClose={onClose}>
      <h2 id={titleId} className="text-lg font-semibold text-white">{title}</h2>
      <p id={bodyId} className="mt-3 text-gray-300">{children}</p>
      {error && <p role="alert" className="mt-3 text-red-300">{error}</p>}
      <div className="mt-5 flex justify-end gap-3">
        <button autoFocus disabled={busy} onClick={onClose} className="min-h-11 px-4 rounded-sm bg-gray-700 disabled:opacity-50">Cancel</button>
        <button disabled={busy} onClick={confirm} className="min-h-11 px-4 rounded-sm bg-red-700 disabled:opacity-50">{busy ? 'Working...' : confirmLabel}</button>
      </div>
    </ModalDialog>
  )
}
