// Shared display formatters (USD, percent, local timestamp, bytes). Pure, no React.

const pad2 = (n) => String(n).padStart(2, '0')

/**
 * USD with Intl. Renders '---' for null/non-finite.
 * decimals: fraction digits (default 2). compact: values >= 1000 render as "$1.6K"
 * (one decimal, trailing ".0" trimmed) to fit narrow panels.
 */
export function formatUsd(value, { compact = false, decimals = 2 } = {}) {
  if (value == null || !Number.isFinite(value)) return '---'
  if (compact) {
    const abs = Math.abs(value)
    if (abs >= 1000) return `${value < 0 ? '-' : ''}$${(abs / 1000).toFixed(1).replace(/\.0$/, '')}K`
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value + 0) // + 0 normalizes -0 to 0
}

// "12.34%" — nullish/NaN-ish input renders as 0.
export const formatPercent = (n, decimals = 2) => `${(n || 0).toFixed(decimals)}%`

// "YYYY-MM-DD HH:MM:SS" in the viewer's local timezone.
export function formatLocalStamp(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
