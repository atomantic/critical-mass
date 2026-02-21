import { useSocketPrice } from './useSocketPrice'

const DEFAULT_TICKERS = ['BTC-USD']

/**
 * Custom hook for Kraken Socket.IO connection.
 * Thin wrapper around useSocketPrice with Kraken-specific events.
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
export const useKrakenSocket = (options = {}) => {
  const { initialTickers = DEFAULT_TICKERS, autoConnect = true } = options
  return useSocketPrice({
    subscribeEvent: 'kraken:subscribe',
    unsubscribeEvent: 'kraken:unsubscribe',
    priceEvent: 'kraken:price',
    initialTickers,
    autoConnect,
  })
}

export default useKrakenSocket
