import { useState } from 'react'
import { describeActionFailure } from '../../utils/actionFailure.mjs'
import { apiPost } from '../../utils/apiClient'

export default function useRegimeDashboardActions({ exchange, pairQuery, addToast, setSocketStatus, fetchStatus, fetchConfig, fetchFills }) {
  const [rollUpConfirm, setRollUpConfirm] = useState(null)
  const [rollingUp, setRollingUp] = useState(false)
  const [collapseAllConfirm, setCollapseAllConfirm] = useState(false)
  const [drawdownResumeConfirm, setDrawdownResumeConfirm] = useState(false)
  const [resumingAuth, setResumingAuth] = useState(false)
  const [collapsingAll, setCollapsingAll] = useState(false)
  const [resetCycleConfirm, setResetCycleConfirm] = useState(false)
  const [resettingCycle, setResettingCycle] = useState(false)
  const [tpEditModal, setTpEditModal] = useState(null) // { bodyId, currentTpPct, currentPrice, avgPrice, bodyLabel, inputValue, priceValue, mode: 'pct'|'price' }
  const [settingTp, setSettingTp] = useState(false)
  const [cancellingLadder, setCancellingLadder] = useState(false)
  const [cancelLadderConfirm, setCancelLadderConfirm] = useState(false)
  // Shared client: network failures throw so the existing catch copy stays, and
  // HTTP / success:false failures keep the parsed body for status side effects.
  const post = async (path, body) => {
    const result = await apiPost(`/api/${exchange}/regime/${path}${pairQuery}`, body)
    if (result.status === 0) throw new Error(result.error || 'Network error')
    return result
  }
  const failureMessage = (result, data) => result.error || describeActionFailure(result.status, data)
  // Resume from drawdown pause (confirmed via modal — project forbids window.confirm)
  const handleResumeDrawdown = async () => {
    setDrawdownResumeConfirm(false)
    try {
      const result = await post('resume-drawdown')
      if (result.ok) await fetchStatus()
      // Surface the engine's actual reason (e.g. "Fund equity is depleted ($0.00)
      // — cannot re-base the drawdown peak") instead of a bare HTTP status —
      // that reason is the whole point of a failed resume attempt.
      else addToast({ type: 'error', title: 'Resume failed', message: failureMessage(result, result.data) })
    } catch (err) {
      addToast({ type: 'error', title: 'Resume failed', message: err.message || 'Network error' })
    }
  }

  // Resume after an API-key/IP-allowlist denial. The engine also auto-resumes
  // once an authenticated call succeeds, but this lets the operator retry
  // immediately after fixing the allowlist.
  const handleResumeFromAuthDenied = async () => {
    setResumingAuth(true)
    try {
      const result = await post('resume')
      if (result.ok) {
        await fetchStatus()
        addToast({ type: 'success', title: 'Resumed', message: 'Engine resumed — retrying API access' })
      } else {
        addToast({ type: 'error', title: 'Resume failed', message: failureMessage(result, result.data) })
      }
    } catch (err) {
      addToast({ type: 'error', title: 'Resume failed', message: err.message || 'Network error' })
    } finally {
      setResumingAuth(false)
    }
  }

  // Manual body roll-up merge
  const handleRollUp = async (bodyId) => {
    setRollingUp(true)
    try {
      const result = await post('rollup-body', { bodyId })
      const data = result.data ?? {}
      if (result.ok && data.success && data.status) {
        // Directly update socket status from API response for immediate visual refresh
        // (avoids race where socketStatus overrides stale localStatus from fetchStatus)
        setSocketStatus(data.status)
        // Re-fetch fills so buy order annotations (bodyId, sellOrderId) reflect the merge
        fetchFills()
      } else {
        addToast({ type: 'error', title: 'Roll-up failed', message: failureMessage(result, data) })
      }
    } catch (err) {
      addToast({ type: 'error', title: 'Roll-up failed', message: err.message })
    } finally {
      setRollingUp(false)
      setRollUpConfirm(null)
    }
  }

  // Collapse every celestial body into one (cancels all TPs, places one combined TP)
  const handleCollapseAll = async () => {
    setCollapsingAll(true)
    try {
      const result = await post('rollup-all')
      const data = result.data ?? {}
      if (result.ok && data.success) {
        addToast({ type: 'success', title: 'Collapse complete', message: data.message || 'Bodies merged' })
        if (data.status) setSocketStatus(data.status)
        fetchFills()
      } else {
        addToast({ type: 'error', title: 'Collapse failed', message: failureMessage(result, data) })
        if (data.status) setSocketStatus(data.status)
      }
    } catch (err) {
      addToast({ type: 'error', title: 'Collapse failed', message: err.message })
    } finally {
      setCollapsingAll(false)
      setCollapseAllConfirm(false)
    }
  }

  // Operator: reset the accumulation cycle to resume buying after the cycle
  // buy-limit paused new entries. Open positions and their TPs are preserved.
  const handleResetCycle = async () => {
    setResettingCycle(true)
    try {
      const result = await post('reset-cycle')
      const data = result.data ?? {}
      if (result.ok && data.success) {
        addToast({ type: 'success', title: 'Cycle reset', message: data.message || 'Buying re-enabled' })
        if (data.status) setSocketStatus(data.status)
        fetchFills()
      } else {
        addToast({ type: 'error', title: 'Cycle reset failed', message: failureMessage(result, data) })
        if (data.status) setSocketStatus(data.status)
      }
    } catch (err) {
      addToast({ type: 'error', title: 'Cycle reset failed', message: err.message })
    } finally {
      setResettingCycle(false)
      setResetCycleConfirm(false)
    }
  }
  // Manually set TP target (by % or limit price) for a celestial body
  const handleSetTp = async (mode) => {
    if (settingTp) return // re-entry guard: Enter key bypasses the disabled button state
    const value = parseFloat(mode === 'pct' ? tpEditModal.inputValue : tpEditModal.priceValue)
    if (isNaN(value) || value <= 0) return
    if (mode === 'price' && value <= (tpEditModal.avgPrice || 0)) {
      // Mirror the "Set Price" button's disabled guard: never allow a TP at or below avg cost.
      addToast({ type: 'error', title: 'Set TP failed', message: 'Limit price must be above average cost' })
      return
    }
    const endpoint = mode === 'pct' ? 'set-body-tp' : 'set-body-tp-price'
    const payload = mode === 'pct' ? { bodyId: tpEditModal.bodyId, tpPct: value } : { bodyId: tpEditModal.bodyId, limitPrice: value }
    setSettingTp(true)
    try {
      const result = await post(endpoint, payload)
      const data = result.data ?? {}
      if (result.ok && data.success && data.status) {
        setSocketStatus(data.status)
        fetchFills()
        setTpEditModal(null)
      } else {
        // Keep the modal open on failure so the operator can retry — the old TP
        // is still resting on the exchange, so silently closing misled them.
        addToast({ type: 'error', title: 'Set TP failed', message: failureMessage(result, data) })
      }
    } catch (err) {
      addToast({ type: 'error', title: 'Set TP failed', message: err.message })
    } finally {
      setSettingTp(false)
    }
  }

  const handleCancelLadder = () => {
    setCancelLadderConfirm(true)
  }

  const handleExecuteCancelLadder = async () => {
    setCancellingLadder(true)
    try {
      const result = await post('cancel-ladder')
      const data = result.data ?? {}
      if (result.ok && data.success) {
        addToast({ type: 'success', title: 'Ladder Cancelled', message: data.message })
        if (data.status) setSocketStatus(data.status)
        fetchConfig()
      } else {
        addToast({ type: 'error', title: 'Cancel ladder failed', message: failureMessage(result, data) })
      }
    } catch (err) {
      addToast({ type: 'error', title: 'Cancel ladder failed', message: err.message })
    } finally {
      setCancellingLadder(false)
      setCancelLadderConfirm(false)
    }
  }

  return {
    rollUpConfirm, setRollUpConfirm, rollingUp, collapseAllConfirm,
    setCollapseAllConfirm, drawdownResumeConfirm, setDrawdownResumeConfirm, resumingAuth,
    collapsingAll, resetCycleConfirm, setResetCycleConfirm, resettingCycle,
    tpEditModal, setTpEditModal, settingTp, cancellingLadder,
    cancelLadderConfirm, setCancelLadderConfirm, handleResumeDrawdown, handleResumeFromAuthDenied,
    handleRollUp, handleCollapseAll, handleResetCycle, handleSetTp,
    handleCancelLadder, handleExecuteCancelLadder,
  }
}
