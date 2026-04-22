import { useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'

/**
 * Socket.IO hook for Sentinel news alert data.
 * Subscribes to the sentinel room and listens for new alerts and status updates.
 */
export const useSentinelSocket = (options = {}) => {
  const { autoConnect = true } = options

  const socketRef = useRef(null)
  const [connected, setConnected] = useState(false)
  const [latestAlert, setLatestAlert] = useState(null)
  const [status, setStatus] = useState(null)

  useEffect(() => {
    if (!autoConnect) return

    const socket = io(window.location.origin, {
      transports: ['websocket', 'polling']
    })

    socketRef.current = socket

    const onConnect = () => {
      setConnected(true)
      socket.emit('sentinel:subscribe')
    }

    const onDisconnect = () => {
      setConnected(false)
    }

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

    return () => {
      socket.emit('sentinel:unsubscribe')
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('sentinel:alert', onAlert)
      socket.off('sentinel:status', onStatus)
      socket.disconnect()
    }
  }, [autoConnect])

  return { connected, latestAlert, status }
}

export default useSentinelSocket
