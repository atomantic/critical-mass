import { useSocketPrice } from './useSocketPrice'

/**
 * Custom hook for Coinbase Socket.IO connection.
 * Thin wrapper around useSocketPrice with Coinbase-specific events.
 * @param {Object} [options] - Hook options
 * @param {string[]} [options.initialTickers] - Initial tickers to subscribe to
 * @param {boolean} [options.autoConnect=true] - Auto-connect on mount
 * @returns {{
 *   connected: boolean,
 *   prices: Map<string, Object>,
 *   subscribe: (tickers: string[]) => void,
 *   unsubscribe: (tickers: string[]) => void,
 *   getPrice: (ticker: string) => Object | null
 * }}
 */
export const useCoinbaseSocket = (options = {}) => {
  const { initialTickers = ['BTC-USD'], autoConnect = true } = options
  return useSocketPrice({
    subscribeEvent: 'coinbase:subscribe',
    unsubscribeEvent: 'coinbase:unsubscribe',
    priceEvent: 'coinbase:price',
    initialTickers,
    autoConnect,
  })
}

export default useCoinbaseSocket
