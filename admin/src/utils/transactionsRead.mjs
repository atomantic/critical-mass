import { createRequestOwner } from './requestOwner.mjs'

// One owner covers the whole fund/page snapshot, including the stale-revision
// retry and body parsing. An obsolete response cannot commit any sibling data.
export function createTransactionsReader(fetchImpl = (...args) => fetch(...args)) {
  const owner = createRequestOwner({
    fetchImpl: async (_url, { signal, exchange, pairQuery, query }) => {
      const params = new URLSearchParams(query)
      const [initialFills, status, orders] = await Promise.all([
        fetchImpl(`/api/${exchange}/regime/fills?${params}`, { signal }),
        fetchImpl(`/api/${exchange}/regime/status${pairQuery}`, { signal }),
        fetchImpl(`/api/${exchange}/regime/open-orders${pairQuery}`, { signal }),
      ])
      let fills = initialFills
      if (fills.status === 409 && !signal.aborted) {
        params.delete('revision')
        params.set('page', '0')
        fills = await fetchImpl(`/api/${exchange}/regime/fills?${params}`, { signal })
      }
      const [fillsData, statusData, ordersData] = await Promise.all([
        fills.json().catch(() => null), status.ok ? status.json() : null,
        orders.json().catch(() => null),
      ])
      return { ok: true, json: async () => ({ fillsOk: fills.ok, fillsStatus: fills.status, fillsData, statusData, ordersOk: orders.ok, ordersStatus: orders.status, ordersData }) }
    },
  })
  return {
    read: options => owner.read('', options),
    invalidate: owner.invalidate,
  }
}
