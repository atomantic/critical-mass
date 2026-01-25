// D3 Chart Utilities - Following EscapeMint patterns

// Compact currency formatting for axes
export function formatCurrencyCompact(value) {
  const absValue = Math.abs(value)
  if (absValue >= 1000000) return `$${(value / 1000000).toFixed(1)}M`
  if (absValue >= 1000) return `$${(value / 1000).toFixed(1)}K`
  return `$${value.toFixed(0)}`
}

// Full currency format (fixed 2 decimals for totals/balances)
export function formatCurrency(value) {
  return `$${(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// Smart price format - adjusts decimals based on price magnitude
// For high prices like BTC ($100k): 2 decimals
// For low prices like CRO ($0.10): up to 5 decimals
export function formatPrice(value) {
  const absValue = Math.abs(value || 0)
  if (absValue === 0) return '$0.00'
  if (absValue >= 100) return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  if (absValue >= 1) return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
  if (absValue >= 0.01) return `$${value.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 5 })}`
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 5, maximumFractionDigits: 8 })}`
}

// Compact price format for axes/charts
export function formatPriceCompact(value) {
  const absValue = Math.abs(value || 0)
  if (absValue >= 1000000) return `$${(value / 1000000).toFixed(1)}M`
  if (absValue >= 1000) return `$${(value / 1000).toFixed(1)}K`
  if (absValue >= 100) return `$${value.toFixed(0)}`
  if (absValue >= 1) return `$${value.toFixed(2)}`
  if (absValue >= 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(5)}`
}

// BTC format
export function formatBTC(value) {
  return `${(value || 0).toFixed(8)} BTC`
}

// Short BTC format for axes
export function formatBTCCompact(value) {
  const absValue = Math.abs(value)
  if (absValue >= 1) return `${value.toFixed(2)}`
  if (absValue >= 0.01) return `${value.toFixed(4)}`
  return `${value.toFixed(6)}`
}

// Date formatting
export function formatDate(date) {
  return new Date(date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

export function formatDateTime(date) {
  return new Date(date).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function formatTime(date) {
  return new Date(date).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function formatDateTimeFull(date) {
  return new Date(date).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })
}

// Smart date formatter based on time span
export function getSmartDateFormatter(startDate, endDate) {
  const spanMs = endDate - startDate
  const spanHours = spanMs / (1000 * 60 * 60)
  const spanDays = spanHours / 24

  if (spanHours < 24) {
    // Less than a day: show time only
    return (d) => formatTime(d)
  } else if (spanDays < 3) {
    // Less than 3 days: show day + time
    return (d) => {
      const date = new Date(d)
      return `${date.getDate()} ${formatTime(d)}`
    }
  } else if (spanDays < 14) {
    // Less than 2 weeks: show date + time
    return (d) => formatDateTime(d)
  } else {
    // More than 2 weeks: show date only
    return (d) => formatDate(d)
  }
}

// Get appropriate tick count based on time span
export function getSmartTickCount(spanMs, containerWidth) {
  const baseTicks = containerWidth < 400 ? 4 : containerWidth < 600 ? 6 : 8
  const spanHours = spanMs / (1000 * 60 * 60)

  if (spanHours < 6) return Math.min(baseTicks, 6)
  if (spanHours < 24) return baseTicks
  return baseTicks
}

// Responsive margin calculation based on container width
export function getResponsiveMargin(containerWidth) {
  return {
    top: 10,
    right: 15,
    bottom: 30,
    left: containerWidth < 300 ? 40 : containerWidth < 400 ? 50 : 60,
  }
}

// Responsive font size for axes
export function getAxisFontSize(containerWidth) {
  if (containerWidth < 300) return '9px'
  if (containerWidth < 400) return '10px'
  return '11px'
}

// Chart color palette (Tailwind-inspired dark theme)
export const colors = {
  blue: '#3b82f6',
  green: '#10b981',
  yellow: '#f59e0b',
  purple: '#8b5cf6',
  red: '#ef4444',
  cyan: '#06b6d4',
  gray: '#64748b',
  lightGray: '#94a3b8',
  darkGray: '#334155',
  darkBg: '#1e293b',
  gridLine: '#374151',
}

// Opacity variants for fills
export const colorWithOpacity = (color, opacity = 0.3) => {
  const hex = color.replace('#', '')
  const r = parseInt(hex.substring(0, 2), 16)
  const g = parseInt(hex.substring(2, 4), 16)
  const b = parseInt(hex.substring(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${opacity})`
}
