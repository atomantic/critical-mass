import { useState, useEffect, useCallback } from 'react'
import { plural } from '../../utils/plural.mjs'
import { describeActionFailure } from '../../utils/actionFailure.mjs'

// Shared by Dashboard and the regime dashboard: POST the merge preview and toast on
// failure. Resolves to the preview payload, or null when it failed.
export async function fetchConvertPreview({ exchange, pairQuery, addToast }) {
  try {
    const res = await fetch(`/api/${exchange}/regime/convert-dca${pairQuery}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preview: true, merge: true }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      addToast({ type: 'error', title: 'Preview Failed', message: describeActionFailure(res.status, err) })
      return null
    }
    return await res.json()
  } catch (err) {
    addToast({ type: 'error', title: 'Preview Failed', message: err.message || 'Network error' })
    return null
  }
}

export default function useDcaConversion({ exchange, pairQuery, isRunning, addToast, fetchStatus, fetchFills }) {
  const [dcaState, setDcaState] = useState(null)
  const [dcaStateError, setDcaStateError] = useState(null)
  const [dcaStateAttempt, setDcaStateAttempt] = useState(0)
  const retryDcaState = useCallback(() => setDcaStateAttempt(n => n + 1), [])
  const [convertPreview, setConvertPreview] = useState(null)
  const [converting, setConverting] = useState(false)
  const [showConvertConfirm, setShowConvertConfirm] = useState(false)
  // Fetch DCA state when engine is not running (for upgrade button)
  useEffect(() => {
    if (!isRunning) {
      const controller = new AbortController()
      setDcaStateError(null)
      fetch(`/api/${exchange}/state${pairQuery}`, { signal: controller.signal })
        .then(async r => {
          const data = await r.json().catch(() => ({}))
          if (!r.ok) throw new Error(describeActionFailure(r.status, data))
          setDcaState(data)
        })
        .catch(err => {
          if (err.name === 'AbortError') return
          setDcaState(null)
          setDcaStateError(err.message || 'Network error')
        })
      return () => controller.abort()
    } else {
      setDcaState(null)
      setDcaStateError(null)
    }
  }, [exchange, isRunning, pairQuery, dcaStateAttempt])
  // DCA conversion handlers
  const handlePreviewConvert = useCallback(async () => {
    const data = await fetchConvertPreview({ exchange, pairQuery, addToast })
    if (!data) return
    setConvertPreview(data)
    setShowConvertConfirm(true)
  }, [exchange, pairQuery, addToast])

  const handleExecuteConvert = useCallback(async () => {
    // Same verb as the confirmation dialog the operator just accepted.
    const [doneTitle, failedTitle] = convertPreview?.merge
      ? ['DCA Orders Imported', 'Import Failed']
      : ['DCA Orders Upgraded', 'Upgrade Failed']
    setConverting(true)
    try {
      const res = await fetch(`/api/${exchange}/regime/convert-dca${pairQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preview: false, merge: convertPreview?.merge }),
      })
      setShowConvertConfirm(false)
      setConvertPreview(null)

      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        addToast({ type: 'error', title: failedTitle, message: describeActionFailure(res.status, err) })
        return
      }

      const data = await res.json()
      addToast({
        type: 'success',
        title: doneTitle,
        message: `${plural(data.summary?.pendingOrders || 0, "position")} imported. ${data.summary?.totalBodies ? `Total bodies: ${data.summary.totalBodies}.` : ''} Before starting the regime engine, cancel any remaining DCA sell orders on the exchange and confirm that they are no longer open.`,
      })
      // Refresh status and fills
      fetchStatus()
      fetchFills()
      setDcaState(null)
    } catch (err) {
      setShowConvertConfirm(false)
      setConvertPreview(null)
      addToast({ type: 'error', title: failedTitle, message: err.message || 'Network error' })
    } finally {
      setConverting(false)
    }
  }, [exchange, addToast, fetchStatus, fetchFills, convertPreview?.merge])

  return { dcaState, dcaStateError, retryDcaState, convertPreview, converting, showConvertConfirm, setShowConvertConfirm, handlePreviewConvert, handleExecuteConvert }
}
