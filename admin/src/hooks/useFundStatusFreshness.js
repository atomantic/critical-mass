import { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from 'react'
import {
  createFundStatusOwner,
  nextRegimeStatusSeq,
  STATUS_STALE_MS,
} from '../utils/regimeStatusSnapshot.mjs'

const EMPTY_FRESHNESS = Object.freeze({
  status: null,
  rawStatus: null,
  seq: 0,
  isRunning: false,
  isSilent: false,
  isStale: false,
  probeInFlight: false,
  probeFailed: false,
  probeError: null,
})

/**
 * React hook bridging a fund's socket and HTTP statuses with the
 * shared freshness watchdog (#1816).
 */
export function useFundStatusFreshness({
  exchange,
  pair,
  initialStatus = null,
  socketStatus = null,
  socketSeq,
  staleMs = STATUS_STALE_MS,
  fetchStatus,
} = {}) {
  const fetchStatusRef = useRef(fetchStatus)
  fetchStatusRef.current = fetchStatus
  const initialStatusRef = useRef(initialStatus)
  initialStatusRef.current = initialStatus
  const ownerRef = useRef(null)
  // A new visit to the same fund has a distinct identity, fencing callbacks
  // from an earlier visit even after navigating A -> B -> A.
  const selection = useMemo(() => ({}), [exchange, pair])
  const [snapshotState, setSnapshotState] = useState(null)

  useLayoutEffect(() => {
    const owner = createFundStatusOwner({
      exchange,
      pair,
      initialStatus: initialStatusRef.current,
      staleMs,
      fetchStatus: fetchStatusRef.current ? (args) => fetchStatusRef.current(args) : undefined,
    })
    ownerRef.current = { selection, owner }
    const unsubscribe = owner.subscribe((snap) => {
      setSnapshotState({ selection, owner, snap })
    })
    setSnapshotState({ selection, owner, snap: owner.getSnapshot() })
    return () => {
      unsubscribe()
      owner.dispose()
      if (ownerRef.current?.owner === owner) ownerRef.current = null
    }
  }, [selection, exchange, pair, staleMs])

  // Accept socket updates
  useEffect(() => {
    const active = ownerRef.current
    if (socketStatus && active?.selection === selection && !active.owner.isDisposed) {
      active.owner.acceptSnapshot(socketStatus, socketSeq ?? nextRegimeStatusSeq(), { isSocket: true })
    }
  }, [socketStatus, socketSeq, selection, staleMs])

  const acceptSnapshot = useCallback((status, seq, options) => {
    const active = ownerRef.current
    if (active?.selection === selection && !active.owner.isDisposed) {
      return active.owner.acceptSnapshot(status, seq, options)
    }
  }, [selection])

  const retry = useCallback(() => {
    const active = ownerRef.current
    if (active?.selection === selection) return active.owner.retry()
  }, [selection])

  const active = ownerRef.current
  const snapshot = snapshotState?.selection === selection && snapshotState.owner === active?.owner
    ? snapshotState.snap
    : EMPTY_FRESHNESS

  return {
    ...snapshot,
    acceptSnapshot,
    retry,
    owner: active?.selection === selection ? active.owner : null,
  }
}

export default useFundStatusFreshness
