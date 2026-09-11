// Ownership fence for overlapping dashboard reads (#508).
//
// Dashboards refresh the same snapshot from several triggers at once — initial
// load, an interval/marker poll, and post-action refreshes. Without sequencing,
// whichever response lands last wins, so a slow *older* request can overwrite a
// newer snapshot (a fresh fill disappearing from Filled Orders, or a stopped
// UpDown service flipping back to Running after a successful Stop).
//
// Each owner is created per mount and hands out a monotonically increasing
// generation token before the first await. Only the newest token may commit,
// and every await boundary (transport + JSON parse) is re-checked because a
// newer read can start in between. Superseded requests are also aborted, so the
// browser stops work nobody will read.

export const createRequestOwner = ({
  fetchImpl = (...args) => fetch(...args),
  createAbortController = () => new AbortController(),
} = {}) => {
  const state = { generation: 0, controller: null }

  const owns = (token) => state.generation === token

  // Drop authority over any in-flight read: the bumped generation invalidates
  // every outstanding token and the transport is aborted.
  const invalidate = () => {
    state.generation += 1
    state.controller?.abort()
    state.controller = null
  }

  // Take authority for a new read. Synchronous, and called before the first
  // await so no continuation can slip in ahead of the claim.
  const claim = () => {
    invalidate()
    state.controller = createAbortController()
    return state.generation
  }

  /**
   * Owned JSON read.
   *
   * Resolves to `{ owned, ok, data }`. `owned` is false when a newer read (or
   * `invalidate()`) superseded this one at any await boundary — callers must
   * commit nothing in that case, including loading/error resets, so an obsolete
   * request cannot clear newer state. Network failures, non-OK responses and
   * unparseable bodies resolve with `data: null` rather than throwing.
   */
  const read = async (url, options = {}) => {
    const token = claim()
    const response = await fetchImpl(url, { ...options, signal: state.controller?.signal }).catch(() => null)
    if (!owns(token)) return { owned: false, ok: false, data: null }

    const ok = response?.ok === true
    const data = ok ? await response.json().catch(() => null) : null
    if (!owns(token)) return { owned: false, ok: false, data: null }

    return { owned: true, ok, data }
  }

  return { read, claim, owns, invalidate }
}
