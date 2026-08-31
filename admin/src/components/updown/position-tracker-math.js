export const PRICE_STALE_MS = 30_000
export const PERP_CONTRACT_SIZE_BTC = 0.01

export function isFreshTick(tick, now = Date.now(), maxAgeMs = PRICE_STALE_MS) {
  if (!Number.isFinite(tick?.price) || tick.price <= 0 || !Number.isFinite(tick?.timestamp)) return false

  const ageMs = now - tick.timestamp
  return ageMs >= 0 && ageMs <= maxAgeMs
}

export function calculateManualPositionPnl({ currentPrice, entryPrice, contracts, direction = 'Up' }) {
  const entry = Number(entryPrice)
  const amount = Number(contracts)
  const valid = Number.isFinite(currentPrice) && currentPrice > 0 &&
    Number.isFinite(entry) && entry > 0 && Number.isFinite(amount) && amount > 0

  if (!valid) return null

  const directionMultiplier = direction === 'Up' ? 1 : -1
  return {
    pnl: (currentPrice - entry) * amount * PERP_CONTRACT_SIZE_BTC * directionMultiplier,
    pnlPct: direction === 'Up'
      ? ((currentPrice - entry) / entry) * 100
      : ((entry - currentPrice) / entry) * 100,
  }
}
