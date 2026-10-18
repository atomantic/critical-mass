import { useState, useEffect, useCallback } from 'react'

export default function useDcaConversion({ exchange, pairQuery, isRunning, addToast, fetchStatus, fetchFills }) {
  const [dcaState, setDcaState] = useState(null)
  const [convertPreview, setConvertPreview] = useState(null)
  const [converting, setConverting] = useState(false)
  const [showConvertConfirm, setShowConvertConfirm] = useState(false)
  // Fetch DCA state when engine is not running (for upgrade button)
  useEffect(() => {
    if (!isRunning) {
      const controller = new AbortController()
      fetch(`/api/${exchange}/state${pairQuery}`, { signal: controller.signal }).then(r => r.json()).then(setDcaState).catch(() => {})
      return () => controller.abort()
    } else {
      setDcaState(null)
    }
  }, [exchange, isRunning, pairQuery])
  // DCA conversion handlers
  const handlePreviewConvert = useCallback(async () => {
    try {
      const res = await fetch(`/api/${exchange}/regime/convert-dca${pairQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preview: true, merge: true }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        addToast({ type: 'error', title: 'Preview Failed', message: err.error || 'Could not preview conversion' })
        return
      }
      const data = await res.json()
      setConvertPreview(data)
      setShowConvertConfirm(true)
    } catch (err) {
      addToast({ type: 'error', title: 'Preview Failed', message: err.message || 'Network error' })
    }
  }, [exchange, addToast])

  const handleExecuteConvert = useCallback(async () => {
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
        addToast({ type: 'error', title: 'Conversion Failed', message: err.error || 'Could not convert DCA orders' })
        return
      }

      const data = await res.json()
      addToast({
        type: 'success',
        title: data.summary?.totalBodies ? 'DCA Orders Merged' : 'DCA Orders Converted',
        message: `${data.summary?.pendingOrders || 0} positions imported. ${data.summary?.totalBodies ? `Total bodies: ${data.summary.totalBodies}.` : ''} Before starting the regime engine, cancel any remaining DCA sell orders on the exchange and confirm that they are no longer open.`,
      })
      // Refresh status and fills
      fetchStatus()
      fetchFills()
      setDcaState(null)
    } catch (err) {
      setShowConvertConfirm(false)
      setConvertPreview(null)
      addToast({ type: 'error', title: 'Conversion Failed', message: err.message || 'Network error' })
    } finally {
      setConverting(false)
    }
  }, [exchange, addToast, fetchStatus, fetchFills, convertPreview?.merge])

  return { dcaState, convertPreview, converting, showConvertConfirm, setShowConvertConfirm, handlePreviewConvert, handleExecuteConvert }
}
