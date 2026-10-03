// Pure helpers for the regime Transactions table: sort, whole-history summary
// and fixed-size pagination (issue #852). Kept out of the component so the
// page-slice / clamp / summary-parity behavior is unit-testable.

export const TRANSACTIONS_PAGE_SIZE = 100

/** Sort P&L-enriched fills (new array) by a column and direction. */
export function sortFills(fills, sortField, sortDir) {
  const dir = sortDir === 'asc' ? 1 : -1
  return [...fills].sort((a, b) => {
    const aVal = a[sortField]
    const bVal = b[sortField]
    const compared = typeof aVal === 'number' || typeof bVal === 'number'
      ? ((aVal ?? 0) - (bVal ?? 0)) * dir
      : String(aVal ?? '').localeCompare(String(bVal ?? '')) * dir
    return compared || String(a.tradeId ?? '').localeCompare(String(b.tradeId ?? ''))
  })
}

/** Totals over the complete (filtered) history, independent of page. */
export function summarizeFills(fills) {
  let totalBuys = 0, totalSells = 0, totalAssetBought = 0, totalBtcSold = 0
  let totalFees = 0, totalPnL = 0, totalHoldbackBtc = 0, totalHoldbackValue = 0
  for (const f of fills) {
    if (f.side === 'buy') {
      totalBuys++
      totalAssetBought += f.size
    } else {
      totalSells++
      totalBtcSold += f.size
    }
    totalFees += f.netFee || f.fee || 0
    if (f.pnl !== null) totalPnL += f.pnl
    if (f.holdbackAsset !== null) totalHoldbackBtc += f.holdbackAsset
    if (f.holdbackValue !== null) totalHoldbackValue += f.holdbackValue
  }
  return { totalBuys, totalSells, totalAssetBought, totalBtcSold, totalFees, totalPnL, totalHoldbackBtc, totalHoldbackValue }
}

/** Number of pages (always >= 1, so an empty history is "page 1 of 1"). */
export function pageCount(total, pageSize = TRANSACTIONS_PAGE_SIZE) {
  return Math.max(1, Math.ceil(total / pageSize))
}

/** Clamp a 0-based page index into [0, lastPage]; non-finite input -> 0. */
export function clampPage(page, total, pageSize = TRANSACTIONS_PAGE_SIZE) {
  const last = pageCount(total, pageSize) - 1
  if (!Number.isFinite(page)) return 0
  return Math.min(Math.max(0, Math.trunc(page)), last)
}

/**
 * Slice one page out of the full sorted list. Returns the clamped page, the
 * rows, and a 1-based inclusive range (start/end are 0 when empty).
 */
export function paginate(items, page, pageSize = TRANSACTIONS_PAGE_SIZE) {
  const total = items.length
  const current = clampPage(page, total, pageSize)
  const from = current * pageSize
  const rows = items.slice(from, from + pageSize)
  return {
    page: current,
    pageCount: pageCount(total, pageSize),
    rows,
    total,
    start: total === 0 ? 0 : from + 1,
    end: from + rows.length,
    hasPrev: current > 0,
    hasNext: current < pageCount(total, pageSize) - 1,
  }
}
