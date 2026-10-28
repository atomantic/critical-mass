import { useEffect, useRef } from 'react'
import { getRealtimeClient } from '../lib/realtime'

/**
 * Push replacement for polling `/regime/status` from the app shell (#1878).
 *
 * The gateway sends a compact `regime:state` event ({ exchange, pair,
 * isRunning, isDryRun, lifecycle }) to every socket whenever a fund's
 * header-level state changes, so the shell needs neither the full status
 * stream nor a timer. Events carry no replay, so `onReconcile` runs for the
 * transitions that can hide a change: the socket reconnecting and the tab
 * becoming visible again. Callbacks are read through refs, so only the fund
 * restarts the subscription.
 */
export function useRegimeStateEvents({ exchange, pair, enabled = true, onState, onReconcile }) {
  const stateRef = useRef(onState)
  const reconcileRef = useRef(onReconcile)
  stateRef.current = onState
  reconcileRef.current = onReconcile

  useEffect(() => {
    if (!enabled || !exchange) return undefined
    const socket = getRealtimeClient()
    const handleState = (data) => {
      if (!data || data.exchange !== exchange) return
      if (pair && data.pair && data.pair !== pair) return
      stateRef.current?.(data)
    }
    const reconcile = () => reconcileRef.current?.()
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') reconcile()
    }
    socket.on('regime:state', handleState)
    socket.on('connect', reconcile)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      socket.off('regime:state', handleState)
      socket.off('connect', reconcile)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [exchange, pair, enabled])
}

export default useRegimeStateEvents
