import { useEffect, useRef } from 'react'

/**
 * Run `fn` on an interval while mounted (#1598).
 *
 * Replaces the hand-rolled
 *   useEffect(() => { fetchX(); const t = setInterval(fetchX, MS); return () => clearInterval(t) }, [deps])
 * pattern. `fn` is read through a ref, so a new function identity never
 * restarts the timer; list anything that should restart polling (and re-run the
 * immediate call) in `deps`.
 *
 * Options:
 *  - immediate (true): call `fn` once right away when polling (re)starts.
 *  - enabled (true): when false nothing runs and no timer is held.
 *  - deps ([]): extra restart triggers, like an effect dependency list.
 *  - skipOverlap (false): skip a tick while the previous call's promise is
 *    still pending, for fetchers that have no request owner to supersede
 *    overlapping reads.
 *  - onCleanup: runs when polling stops or restarts (invalidate request
 *    owners, abort controllers). Read through a ref like `fn`.
 */
export function usePolling(fn, intervalMs, { immediate = true, enabled = true, deps = [], skipOverlap = false, onCleanup } = {}) {
  const fnRef = useRef(fn)
  const cleanupRef = useRef(onCleanup)
  fnRef.current = fn
  cleanupRef.current = onCleanup

  useEffect(() => {
    if (!enabled) return undefined
    let pending = false
    const tick = () => {
      if (skipOverlap && pending) return
      const result = fnRef.current()
      if (skipOverlap && result && typeof result.then === 'function') {
        pending = true
        const done = () => { pending = false }
        result.then(done, done)
      }
    }
    if (immediate) tick()
    const timer = setInterval(tick, intervalMs)
    return () => {
      clearInterval(timer)
      cleanupRef.current?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, enabled, immediate, skipOverlap, ...deps])
}

export default usePolling
