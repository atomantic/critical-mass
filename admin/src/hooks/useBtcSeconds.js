import { useEffect, useRef, useState } from 'react'
import { getRealtimeClient } from '../lib/realtime'
import { apiGet } from '../utils/apiClient'
import { mergeByT } from '../utils/btcSeconds.mjs'

const CLOCK_INTERVAL_MS = 500
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
  const bufferRef = useRef(null)

  useEffect(() => {
    const timer = setInterval(() => setElapsedAt(performance.now()), CLOCK_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    const socket = getRealtimeClient()
    let request = 0

    const apply = (update) => {
      const receivedAt = performance.now()
      setElapsedAt(receivedAt)
      setData((prev) => {
        const cutoff = update.status.now - rangeSeconds * 1000
        return {
          bars: mergeByT(prev.bars, update.bars, cutoff),
          index: mergeByT(prev.index, update.index, cutoff),
          status: update.status,
          receivedAt,
        }
      })
    }
    const onUpdate = (update) => {
      if (!update?.status || !Array.isArray(update.bars) || !Array.isArray(update.index)) return
      // Events during a read are newer than its snapshot: hold them and apply them on top.
      if (bufferRef.current) bufferRef.current.push(update)
      else apply(update)
    }
    const read = async () => {
      const mine = ++request
      // A read that overtakes another keeps what that one had buffered.
      const buffer = (bufferRef.current ??= [])
      const res = await apiGet(`/api/btc-feed/seconds?seconds=${rangeSeconds}`)
      if (mine !== request) return
      bufferRef.current = null
      if (res.ok && res.data?.status) {
        setError(null)
        apply(res.data)
      } else {
        setError(res.error || 'BTC feed unavailable')
      }
      buffer.forEach(apply)
    }

    socket.on('btc-feed:update', onUpdate)
    socket.on('connect', read)
    socket.subscribe('btc-feed')
    read()
    return () => {
      request = -1
      bufferRef.current = null
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
