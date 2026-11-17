import { createContext, useContext } from 'react'

// Live last price, published separately from the status-derived props so the
// few leaves that mark values to market (the Filled Orders grand total) update
// on each tick while the heavy tables around them stay memoised.
export const LastPriceContext = createContext(0)
export const useLastPrice = () => useContext(LastPriceContext)
