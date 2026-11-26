import { useEffect, useState } from 'react'
import { getRealtimeClient } from '../lib/realtime'
import { apiGet } from '../utils/apiClient'
import { mergeByT } from '../utils/btcSeconds.mjs'

const CLOCK_INTERVAL_MS = 500
const READ_TIMEOUT_MS = 10_000
const RETRY_MS = 5_000
const EMPTY = { bars: [], index: [], status: null, receivedAt: 0 }

// Live BTC 1s bars and index values for the last `rangeSeconds`.
//
// Ages come from the gateway's clock at receipt plus time elapsed here since, so a
// wrong browser clock cannot make a stalled feed look live, and the ages keep growing
// when updates stop.
export default function useBtcSeconds(rangeSeconds) {
  const [data, setData] = useState(EMPTY)
  const [error, setError] = useState(null)
  const [elapsedAt, setElapsedAt] = useState(() => performance.now())

  useEffect(() => {
    let timer
    const updateClock = () => {
      setElapsedAt(performance.now())
    }
    const onVisibility = () => {
      clearInterval(timer)
      if (document.visibilityState === 'hidden') return
      updateClock()
      timer = setInterval(updateClock, CLOCK_INTERVAL_MS)
    }
    onVisibility()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  useEffect(() => {
    const socket = getRealtimeClient()
    let request = 0
    let retryTimer = null
    let abortRead = null
    // Seconds pushed since the pending read began: newer than that read's snapshot.
    let pushed = { bars: new Set(), index: new Set() }

    const apply = ({ bars, index, status }, receivedAt, isRead = false) => {
      setElapsedAt(performance.now())
      setData((prev) => {
        // A read overtaken by a push must not put an older clock back.
        const newer = !isRead || !prev.status || status.now >= prev.status.now
        const current = newer ? { status, receivedAt } : { status: prev.status, receivedAt: prev.receivedAt }
        const cutoff = current.status.now - rangeSeconds * 1000
        return { bars: mergeByT(prev.bars, bars, cutoff), index: mergeByT(prev.index, index, cutoff), ...current }
      })
    }
    const onUpdate = (update) => {
      if (!update?.status || !Array.isArray(update.bars) || !Array.isArray(update.index)) return
      for (const { t } of update.bars) pushed.bars.add(t)
      for (const { t } of update.index) pushed.index.add(t)
      apply(update, performance.now())
    }
    const read = async () => {
      const mine = ++request
      clearTimeout(retryTimer)
      abortRead?.abort()
      const controller = new AbortController()
      abortRead = controller
      const timeout = setTimeout(() => controller.abort(), READ_TIMEOUT_MS)
      pushed = { bars: new Set(), index: new Set() }
      // Stamped at the request: however long the reply takes counts towards the age.
      const requestedAt = performance.now()
      let res
      try {
        res = await apiGet(`/api/btc-feed/seconds?seconds=${rangeSeconds}`, { signal: controller.signal })
      } catch {
        res = { ok: false, error: 'request timed out' }
      } finally {
        clearTimeout(timeout)
      }
      if (mine !== request) return
      if (res.ok && res.data?.status) {
        setError(null)
        const { bars, index, status } = res.data
        apply({
          bars: bars.filter(({ t }) => !pushed.bars.has(t)),
          index: index.filter(({ t }) => !pushed.index.has(t)),
          status,
        }, requestedAt, true)
      } else {
        setError(res.error || 'BTC feed unavailable')
        retryTimer = setTimeout(read, RETRY_MS)
      }
    }

    socket.on('btc-feed:update', onUpdate)
    socket.on('connect', read)
    socket.subscribe('btc-feed')
    read()
    return () => {
      request = -1
      clearTimeout(retryTimer)
      abortRead?.abort()
      socket.unsubscribe('btc-feed')
      socket.off('btc-feed:update', onUpdate)
      socket.off('connect', read)
    }
  }, [rangeSeconds])

  const { bars, index, status, receivedAt } = data
  const elapsed = Math.max(0, elapsedAt - receivedAt)
  const age = (source) => (status && source?.lastEventAt != null ? Math.max(0, status.now - source.lastEventAt + elapsed) : null)
  return {
    bars,
    index,
    nowMs: status ? status.now + elapsed : null,
    ages: { coinbase: age(status?.coinbase), index: age(status?.index) },
    error,
  }
}
