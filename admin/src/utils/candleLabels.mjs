/** Retain only labels in the latest displayed slice, scoped to one hook. */
export function createCandleLabelCache(formatter = formatBucketLabel) {
  let labels = new Map()
  let context = null

  return {
    get size() { return labels.size },
    clear() {
      labels = new Map()
      context = null
    },
    sync(entries, { exchange, bucketMs, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone }) {
      const compatible = context?.exchange === exchange &&
        context?.bucketMs === bucketMs && context?.timeZone === timeZone
      const next = new Map()
      const snapshot = entries.map(([key, bucket]) => {
        const label = next.has(key) ? next.get(key)
          : compatible && labels.has(key) ? labels.get(key) : formatter(key, bucketMs)
        next.set(key, label)
        return { ...bucket, label }
      })
      labels = next
      context = { exchange, bucketMs, timeZone }
      return snapshot
    },
  }
}

/**
 * Format a bucket timestamp for the X axis label
 * @param {number} ts - bucket timestamp
 * @param {number} bucketMs - bucket duration in ms
 * @returns {string}
 */
export function formatBucketLabel(ts, bucketMs) {
  const d = new Date(ts)
  if (bucketMs >= 86_400_000) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }
  if (bucketMs >= 3_600_000) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true })
  }
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}
