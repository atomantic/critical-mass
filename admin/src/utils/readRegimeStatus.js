import { apiGet } from './apiClient.js'
import { nextRegimeStatusSeq } from './regimeStatusSnapshot.mjs'
import { createSharedGet } from './sharedGet.js'

const stamp = () => ({ seq: nextRegimeStatusSeq() })
const sharedRead = createSharedGet({ stamp })

// Action and reconciliation reads can require a new snapshot after a mutation,
// even while the page is still waiting on a pre-action response.
export async function readRegimeStatus(url, { signal, fresh = false } = {}) {
  if (!fresh) return sharedRead(url, { signal })
  const metadata = stamp()
  return { ...await apiGet(url, { signal }), ...metadata }
}
