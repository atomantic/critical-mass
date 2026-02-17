import { useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'

const THROTTLE_MS = 250

/**
 * Custom hook for composite price + order book Socket.IO events.
 * Throttles state updates to avoid render storms from high-frequency WebSocket data.
 * @param {Object} [options]
 * @param {boolean} [options.autoConnect=true]
 * @returns {{
 *   compositePrice: Object | null,
 *   orderBook: Object | null
 * }}
 */
export const useCompositeSocket = (options = {}) => {
  const { autoConnect = true } = options

  const socketRef = useRef(null)
  const [compositePrice, setCompositePrice] = useState(null)
  const [orderBook, setOrderBook] = useState(null)

  const compositePriceRef = useRef(null)
  const orderBookRef = useRef(null)
  const compositeThrottleRef = useRef(null)
  const orderBookThrottleRef = useRef(null)

  useEffect(() => {
    if (!autoConnect) return

    const socket = io(window.location.origin, {
      transports: ['websocket', 'polling']
    })

    socketRef.current = socket

    socket.on('connect', () => {
      socket.emit('composite:subscribe')
      socket.emit('coinbase:subscribe', ['BTC-USD'])
    })

    socket.on('composite:price', (data) => {
      compositePriceRef.current = data
      if (!compositeThrottleRef.current) {
        compositeThrottleRef.current = setTimeout(() => {
          compositeThrottleRef.current = null
          setCompositePrice(compositePriceRef.current)
        }, THROTTLE_MS)
      }
    })

    socket.on('coinbase:orderbook', (data) => {
      orderBookRef.current = data
      if (!orderBookThrottleRef.current) {
        orderBookThrottleRef.current = setTimeout(() => {
          orderBookThrottleRef.current = null
          setOrderBook(orderBookRef.current)
        }, THROTTLE_MS)
      }
    })

    return () => {
      if (compositeThrottleRef.current) clearTimeout(compositeThrottleRef.current)
      if (orderBookThrottleRef.current) clearTimeout(orderBookThrottleRef.current)
      socket.disconnect()
    }
  }, [autoConnect])

  return { compositePrice, orderBook }
}

export default useCompositeSocket
