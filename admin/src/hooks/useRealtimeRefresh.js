import { useEffect, useRef } from 'react'
import { getRealtimeClient } from '../lib/realtime'

/**
 * Re-read data when the gateway says it changed, instead of on a timer (#1880).
 *
 * `onRefresh` runs when any of `events` arrives (at most once per
 * `minIntervalMs`, with a trailing run so the last change is never dropped),
 * when the socket reconnects, and when the tab becomes visible again. All
 * triggers share the interval. Events carry no replay, so those last two close
 * the gaps a push cannot. The caller
 * owns the first read; `rooms` are subscribed for the hook's lifetime. An
 * optional `filter(payload)` drops events for other funds. Callbacks are read
 * through refs, so only the lists restart it.
 */
export function useRealtimeRefresh({ events = [], rooms = [], enabled = true, minIntervalMs = 0, filter, onRefresh }) {
  const refreshRef = useRef(onRefresh)
  const filterRef = useRef(filter)
  refreshRef.current = onRefresh
  filterRef.current = filter
  const eventKey = events.join('|')
  const roomKey = rooms.join('|')

  useEffect(() => {
    if (!enabled) return undefined
    const socket = getRealtimeClient()
    const eventNames = eventKey ? eventKey.split('|') : []
    const roomNames = roomKey ? roomKey.split('|') : []
    // The caller's first read happens at mount, so it counts against the interval.
    let lastRun = Date.now()
    let timer = null
    const run = () => {
      clearTimeout(timer)
      timer = null
      lastRun = Date.now()
      refreshRef.current?.()
    }
    const schedule = () => {
      const wait = lastRun + minIntervalMs - Date.now()
      if (wait <= 0) run()
      else if (!timer) timer = setTimeout(run, wait)
    }
    const onEvent = (payload) => {
      if (filterRef.current && !filterRef.current(payload)) return
      schedule()
    }
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') schedule()
    }
    for (const name of eventNames) socket.on(name, onEvent)
    for (const room of roomNames) socket.subscribe(room)
    socket.on('connect', schedule)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      clearTimeout(timer)
      for (const name of eventNames) socket.off(name, onEvent)
      for (const room of roomNames) socket.unsubscribe(room)
      socket.off('connect', schedule)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [eventKey, roomKey, enabled, minIntervalMs])
}

export default useRealtimeRefresh
