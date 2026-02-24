/**
 * Compute Heikin Ashi candles from OHLC bucket data.
 * Returns array aligned by index with the input array.
 * Each entry: { haOpen, haHigh, haLow, haClose }
 *
 * @param {Array<{open: number, high: number, low: number, price: number}>} buckets
 * @returns {Array<{haOpen: number, haHigh: number, haLow: number, haClose: number}>}
 */
export default function computeHeikinAshi(buckets) {
  if (!buckets?.length) return []

  const result = new Array(buckets.length)

  for (let i = 0; i < buckets.length; i++) {
    const { open: o, high: h, low: l, price: c } = buckets[i]
    const haClose = (o + h + l + c) / 4

    let haOpen
    if (i === 0) {
      haOpen = (o + c) / 2
    } else {
      haOpen = (result[i - 1].haOpen + result[i - 1].haClose) / 2
    }

    const haHigh = Math.max(h, haOpen, haClose)
    const haLow = Math.min(l, haOpen, haClose)

    result[i] = { haOpen, haHigh, haLow, haClose }
  }

  return result
}
