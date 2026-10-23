import { apiGet } from './apiClient.js'

// Only a complete collection may replace a consumer's last good snapshot.
export const completePagedItems = async (url, firstPage, { signal } = {}) => {
  if (!Array.isArray(firstPage?.items)) throw new Error('Invalid collection page.')
  const items = [...firstPage.items]
  const total = firstPage.total ?? items.length
  if (!Number.isSafeInteger(total) || total < items.length) throw new Error('Invalid collection total.')
  const sep = url.includes('?') ? '&' : '?'
  const checkAbort = () => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  }
  checkAbort()
  while (items.length < total) {
    const { ok, data } = await apiGet(`${url}${sep}offset=${items.length}`, { signal })
    checkAbort()
    if (!ok || !Array.isArray(data?.items) || data.items.length === 0) {
      throw new Error('Could not load the complete collection.')
    }
    items.push(...data.items)
  }
  return items
}
