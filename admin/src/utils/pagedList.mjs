import { apiGet } from './apiClient.js'

// List endpoints return one bounded page `{ items, total, limit, offset }`. Callers
// that need the whole collection (alert banner, trade totals) follow the remaining
// pages here instead of silently showing only the first page.
export const completePagedItems = async (url, firstPage) => {
  const items = [...(firstPage?.items ?? [])]
  const total = firstPage?.total ?? items.length
  const sep = url.includes('?') ? '&' : '?'
  while (items.length < total) {
    const { ok, data } = await apiGet(`${url}${sep}offset=${items.length}`)
    if (!ok || !Array.isArray(data?.items) || data.items.length === 0) break
    items.push(...data.items)
  }
  return items
}
