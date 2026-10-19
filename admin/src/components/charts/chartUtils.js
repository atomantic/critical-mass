// Chart utilities - formatting, layout and palette shared by the admin charts
import { bisectLeft } from '../../lib/chart-math'

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

// Full currency format via Intl.NumberFormat (locale-standard negative sign placement,
// e.g. "-$5.00" instead of formatCurrency's "$-5.00"). Renders '---' for null/undefined.
export function formatCurrencyIntl(value) {
  if (value == null) return '---'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value)
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

// Dynamic decimal count for a price, by magnitude tier (2/4/5 decimals).
// Distinct from formatPrice's own magnitude breakpoints below — used by formatPriceByMagnitude.
export function getPriceDecimals(price) {
  if (!price || price >= 100) return 2
  if (price >= 1) return 4
  return 5
}

// Price formatted with getPriceDecimals' fixed decimal count and no currency symbol
// (callers that prepend their own "$"). Renders '-' for null/NaN.
export function formatPriceByMagnitude(price) {
  if (price == null || isNaN(price)) return '-'
  const d = getPriceDecimals(price)
  return price.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
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

// Asset format. Pass `currency` to append a unit suffix (omit/empty for a bare number).
// `stripTrailingZeros` drops trailing zeros from the 8-decimal value (e.g. "0.5" instead of "0.50000000").
export function formatAsset(value, currency = '', { stripTrailingZeros = false } = {}) {
  const fixed = (value || 0).toFixed(8)
  const formatted = stripTrailingZeros ? String(parseFloat(fixed)) : fixed
  return currency ? `${formatted} ${currency}` : formatted
}

// Short asset format for axes
export function formatAssetCompact(value) {
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

// Faint dashed horizontal grid behind the time-series charts
export const DASHED_GRID = { stroke: colors.gridLine, strokeDasharray: '3,3', strokeOpacity: 0.5 }

// Opacity variants for fills
export const colorWithOpacity = (color, opacity = 0.3) => {
  const hex = color.replace('#', '')
  const r = parseInt(hex.substring(0, 2), 16)
  const g = parseInt(hex.substring(2, 4), 16)
  const b = parseInt(hex.substring(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${opacity})`
}

// BTC chart shared tooltip style (dark theme)
export const BTC_TOOLTIP_STYLE = {
  backgroundColor: '#1f2937',
  border: '1px solid #374151',
  borderRadius: '8px',
  fontSize: '12px',
}

// Format BTC price for chart display ($XX,XXX)
export function formatBTCPrice(value) {
  if (value == null) return ''
  return `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

// Adds a Date `parsedDate` to every sample, parsing `dateKey` unless it already is one.
export const parseDates = (data, dateKey) => data.map((d) => ({
  ...d,
  parsedDate: d[dateKey] instanceof Date ? d[dateKey] : new Date(d[dateKey]),
}))

// Nearest parsed sample to a date: the bisected neighbour on whichever side is closer.
export function nearestByDate(parsedData, date) {
  const i = bisectLeft(parsedData, date, (d) => d.parsedDate, 1)
  const d0 = parsedData[i - 1]
  const d1 = parsedData[i]
  if (!d0) return null
  return d1 && date - d0.parsedDate > d1.parsedDate - date ? d1 : d0
}

// Background band per regime: from its start (clamped to the plotted window) to the next
// regime's start, or the right edge for the latest one; bands entirely off-plot are dropped.
export function regimeZones(sortedRegimes, xScale, windowStart, innerWidth) {
  return sortedRegimes
    .map((regime, i) => ({
      mode: regime.mode,
      startX: xScale(Math.max(regime.timestamp, windowStart)),
      endX: i < sortedRegimes.length - 1 ? xScale(sortedRegimes[i + 1].timestamp) : innerWidth,
    }))
    .filter(({ startX, endX }) => startX < innerWidth && endX > 0)
    .map(({ mode, startX, endX }) => ({ mode, x: Math.max(0, startX), width: Math.min(innerWidth, endX) - Math.max(0, startX) }))
}
