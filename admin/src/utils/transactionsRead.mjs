import { apiFetch } from './apiClient.js'
import { readRegimeStatus } from './readRegimeStatus.js'
import { createRequestOwner } from './requestOwner.mjs'

// One owner covers the whole fund/page snapshot, including the stale-revision
// retry and body parsing. An obsolete response cannot commit any sibling data.
export function createTransactionsReader(fetchImpl = apiFetch, readInitialStatus) {
  const readStatus = fetchImpl === apiFetch ? readRegimeStatus : async (url, options) => {
    const response = await fetchImpl(url, options)
    return { ok: response.ok, status: response.status, data: response.ok ? await response.json().catch(() => null) : null }
  }
  let attempted = false
  const owner = createRequestOwner({
    fetchImpl: async (_url, { signal, exchange, pairQuery, query }) => {
      const getStatus = attempted ? readStatus : (readInitialStatus ?? readStatus)
      attempted = true
      const params = new URLSearchParams(query)
      const [initialFills, status, orders] = await Promise.all([
        fetchImpl(`/api/${exchange}/regime/fills?${params}`, { signal }),
        getStatus(`/api/${exchange}/regime/status${pairQuery}`, { signal }),
        fetchImpl(`/api/${exchange}/regime/open-orders${pairQuery}`, { signal }),
      ])
      let fills = initialFills
      if (fills.status === 409 && !signal.aborted) {
        params.delete('revision')
        params.set('page', '0')
        fills = await fetchImpl(`/api/${exchange}/regime/fills?${params}`, { signal })
      }
      const [fillsData, ordersData] = await Promise.all([
        fills.json().catch(() => null),
        orders.json().catch(() => null),
      ])
      return { ok: true, json: async () => ({ fillsOk: fills.ok, fillsStatus: fills.status, fillsData, statusOk: status.ok, statusStatus: status.status, statusData: status.ok ? status.data : null, ordersOk: orders.ok, ordersStatus: orders.status, ordersData }) }
    },
  })
  return {
    read: options => owner.read('', options),
    invalidate: owner.invalidate,
  }
}
