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

    socket.on('connect', () => {
      setConnected(true)
      socket.emit('sentinel:subscribe')
    })

    socket.on('disconnect', () => {
      setConnected(false)
    })

    // New alert
    socket.on('sentinel:alert', (alert) => {
      setLatestAlert(alert)
    })

    // Status update
    socket.on('sentinel:status', (data) => {
      setStatus(data)
    })

    return () => {
      socket.emit('sentinel:unsubscribe')
      socket.off('connect')
      socket.off('disconnect')
      socket.off('sentinel:alert')
      socket.off('sentinel:status')
      socket.disconnect()
    }
  }, [autoConnect])

  return { connected, latestAlert, status }
}

export default useSentinelSocket
