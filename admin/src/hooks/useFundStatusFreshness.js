import { useState, useEffect, useCallback, useRef } from 'react'
import {
  createFundStatusOwner,
  nextRegimeStatusSeq,
  STATUS_STALE_MS,
} from '../utils/regimeStatusSnapshot.mjs'

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

  const ownerRef = useRef(null)
  const currentKey = `${exchange}::${pair || ''}`
  const keyRef = useRef(currentKey)

  if (!ownerRef.current || keyRef.current !== currentKey) {
    ownerRef.current?.dispose()
    keyRef.current = currentKey
    ownerRef.current = createFundStatusOwner({
      exchange,
      pair,
      initialStatus,
      staleMs,
      fetchStatus: fetchStatusRef.current ? (args) => fetchStatusRef.current(args) : undefined,
    })
  }

  const [snapshotState, setSnapshotState] = useState(() => ownerRef.current.getSnapshot())

  useEffect(() => {
    const owner = ownerRef.current
    if (!owner) return
    const unsubscribe = owner.subscribe((snap) => {
      setSnapshotState(snap)
    })
    // Sync current snapshot
    setSnapshotState(owner.getSnapshot())
    return () => {
      unsubscribe()
    }
  }, [currentKey])

  useEffect(() => {
    return () => {
      ownerRef.current?.dispose()
      ownerRef.current = null
    }
  }, [])

  // Accept socket updates
  useEffect(() => {
    if (socketStatus && ownerRef.current && !ownerRef.current.isDisposed) {
      ownerRef.current.acceptSnapshot(socketStatus, socketSeq ?? nextRegimeStatusSeq(), { isSocket: true })
    }
  }, [socketStatus, socketSeq, currentKey])

  const acceptSnapshot = useCallback((status, seq, options) => {
    if (ownerRef.current && !ownerRef.current.isDisposed) {
      return ownerRef.current.acceptSnapshot(status, seq, options)
    }
  }, [])

  const retry = useCallback(() => {
    return ownerRef.current?.retry()
  }, [])

  return {
    ...snapshotState,
    acceptSnapshot,
    retry,
    owner: ownerRef.current,
  }
}

export default useFundStatusFreshness
