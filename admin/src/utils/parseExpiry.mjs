/**
 * Parse expiry to ms timestamp.
 * @param {number | string} expiry - Unix ms timestamp or ISO 8601 date string
 * @returns {number} Epoch ms, or NaN if invalid/missing
 */
export const parseExpiry = (expiry) => {
  if (!expiry) return NaN
  if (typeof expiry === 'number') return expiry
  const ms = new Date(expiry).getTime()
  return Number.isFinite(ms) ? ms : NaN
}
