// Extract quote currency from product ID (e.g., "BTC-USDC" -> "USDC", "CRO_USD" -> "USD", "BTCUSD" -> "USD")
export function getQuoteCurrency(productId) {
  if (!productId) return 'USDC'
  if (productId.includes('-')) {
    return productId.split('-')[1]
  }
  if (productId.includes('_')) {
    return productId.split('_')[1]
  }
  // Gemini format: BTCUSD - extract quote by removing known quote suffixes
  const upper = productId.toUpperCase()
  if (upper.endsWith('USDC')) return 'USDC'
  if (upper.endsWith('USDT')) return 'USDT'
  if (upper.endsWith('USD')) return 'USD'
  const match = upper.match(/^(.+?)(EUR|GBP|SGD|BTC|ETH)$/)
  if (match) return match[2]
  return 'USD'
}

// Extract base currency from product ID (e.g., "BTC-USDC" -> "BTC", "CRO_USD" -> "CRO", "BTCUSD" -> "BTC", "ETHUSD" -> "ETH")
export function getBaseCurrency(productId) {
  if (!productId) return 'BTC'
  if (productId.includes('-')) {
    return productId.split('-')[0]
  }
  if (productId.includes('_')) {
    return productId.split('_')[0]
  }
  // Gemini format: BTCUSD - extract base by removing known quote suffixes
  const upper = productId.toUpperCase()
  if (upper.endsWith('USDC')) return upper.slice(0, -4)
  if (upper.endsWith('USDT')) return upper.slice(0, -4)
  if (upper.endsWith('USD')) return upper.slice(0, -3)
  const match = upper.match(/^(.+?)(EUR|GBP|SGD|BTC|ETH)$/)
  if (match) return match[1]
  return upper
}
