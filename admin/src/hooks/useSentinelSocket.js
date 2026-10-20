import { useEffect, useState } from 'react'
import { getRealtimeClient } from '../lib/realtime'

/**
 * Realtime hook for Sentinel news alert data.
 * Subscribes to the sentinel room and listens for new alerts and status updates.
 */
export const useSentinelSocket = (options = {}) => {
  const { autoConnect = true } = options

  const [connected, setConnected] = useState(false)
  const [latestAlert, setLatestAlert] = useState(null)
  const [status, setStatus] = useState(null)

  useEffect(() => {
    if (!autoConnect) return

    const socket = getRealtimeClient()

    const onConnect = () => setConnected(true)
    const onDisconnect = () => setConnected(false)

    // New alert
    const onAlert = (alert) => {
      setLatestAlert(alert)
    }

    // Status update
    const onStatus = (data) => {
      setStatus(data)
    }

    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('sentinel:alert', onAlert)
    socket.on('sentinel:status', onStatus)
    // The client re-sends the subscription after every reconnect.
    socket.subscribe('sentinel')
    setConnected(socket.connected)

    return () => {
      socket.unsubscribe('sentinel')
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('sentinel:alert', onAlert)
      socket.off('sentinel:status', onStatus)
    }
  }, [autoConnect])

  return { connected, latestAlert, status }
}

export default useSentinelSocket
