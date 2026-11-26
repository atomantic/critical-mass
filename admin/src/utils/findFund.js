// Without a pair, select the first configured fund on the exchange (legacy URLs).
export default function findFund(exchanges, exchange, pair) {
  const exchangeKey = exchange?.toLowerCase()
  const pairKey = pair?.toUpperCase()
  return exchanges.find(fund =>
    fund.name.toLowerCase() === exchangeKey &&
    (!pairKey || (fund.pair ?? fund.productId)?.toUpperCase() === pairKey)
  )
}
