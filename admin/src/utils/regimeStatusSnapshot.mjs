import { createRequestOwner } from './requestOwner.mjs'

// Regime status snapshot handling shared by the socket hook and the dashboard (#1388).
//
// Status reaches the dashboard from two sources: `regime:status` socket emits
// and HTTP reads of /regime/status (initial load, Retry, post-action refresh).

// A running engine emits at most once a second, and only on market ticks. With
// no status from either source for this long, the engine (or the gateway path to
// it) is treated as unreachable.
export const STATUS_STALE_MS = 30000

// The fields a stopped/offline status carries (src/regime-status.js
// buildStoppedRegimeStatus). Everything else (risk, pause, macro, ladder,
// entryMode, autoSwitch, optimizers, fillTimeStats, dryRun, ...) describes a
// running engine only.
export const STOPPED_STATUS_FIELDS = [
  'isRunning', 'isDryRun', 'health', 'position', 'market', 'regime',
  'pendingOrders', 'apy', 'lifecycle', 'celestial', 'placementIntents', 'engineDown',
]

// Generation shared by every snapshot source so the newest one wins regardless
// of whether it arrived over the socket or over HTTP. An HTTP read takes its
// generation when the request starts, so a socket emit that lands while it is
// in flight (e.g. the stopped status right after Stop) beats its response.
let generation = 0
export const nextRegimeStatusSeq = () => ++generation
export const stampRegimeStatus = (status) => ({ status, seq: nextRegimeStatusSeq() })
export const EMPTY_SNAPSHOT = Object.freeze({ status: null, seq: 0 })

// A stopped payload is complete, so it replaces the snapshot, and so does any
// payload that changes the running state. Only running → running emits merge;
// merging a stopped payload would keep the last running snapshot's risk,
// ladder and optimizer fields on screen after Stop.
export function mergeRegimeStatus(prev, next) {
  if (!prev || prev.isRunning !== true || next?.isRunning !== true) return next
  return { ...prev, ...next }
}

// What the dashboard shows when no status has arrived within STATUS_STALE_MS:
// the last snapshot reduced to stopped-status fields, flagged as an unreachable
// engine so running-only panels and actions disappear.
export function toUnreachableStatus(status) {
  if (!status) return status
  const view = {}
  for (const field of STOPPED_STATUS_FIELDS) {
    if (field in status) view[field] = status[field]
  }
  return {
    ...view,
    isRunning: false,
    engineDown: true,
    statusSilent: true,
    health: { mode: 'ENGINE_DOWN' },
    market: status.market ? { ...status.market, stale: true } : null,
  }
}

/**
 * Shared per-fund status owner (#1816).
 *
 * Tracks freshness of accepted running snapshots across socket and HTTP sources.
 * Marks silent engines unreachable after STATUS_STALE_MS and triggers a probe.
 * Maintains explicit states for offline success and retryable probe failure,
 * while retaining the last financial snapshot with a stale marker.
 */
export function createFundStatusOwner({
  exchange,
  pair,
  pairQuery = pair ? `?pair=${encodeURIComponent(pair)}` : '',
  initialStatus = null,
  initialSeq = 0,
  staleMs = STATUS_STALE_MS,
  fetchImpl,
  fetchStatus,
  requestOwner = createRequestOwner({ fetchImpl }),
  onUpdate,
} = {}) {
  let latestSnapshot = initialStatus
    ? { status: initialStatus, seq: initialSeq || nextRegimeStatusSeq() }
    : EMPTY_SNAPSHOT
  let silentSeq = null
  let timer = null
  let probeInFlight = false
  let probeFailed = false
  let probeError = null
  let disposed = false
  const listeners = new Set()
  if (onUpdate) listeners.add(onUpdate)

  const getSnapshot = () => {
    const raw = latestSnapshot.status
    const isSilent = Boolean(raw) && silentSeq === latestSnapshot.seq
    const isStale = isSilent || probeFailed || Boolean(raw?.market?.stale)

    let effectiveStatus = raw
    if (isSilent) {
      effectiveStatus = toUnreachableStatus(raw)
    } else if (probeFailed && raw) {
      effectiveStatus = { ...toUnreachableStatus(raw), probeFailed: true }
    }

    return {
      status: effectiveStatus,
      rawStatus: raw,
      seq: latestSnapshot.seq,
      isRunning: effectiveStatus?.isRunning === true,
      isSilent,
      isStale,
      probeInFlight,
      probeFailed,
      probeError,
      retry,
    }
  }

  const notify = () => {
    if (disposed) return
    const current = getSnapshot()
    for (const listener of listeners) {
      try {
        listener(current)
      } catch {
        // preserve other listeners
      }
    }
  }

  const clearWatchdog = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const armWatchdog = (seq) => {
    clearWatchdog()
    if (disposed) return
    timer = setTimeout(() => {
      handleSilence(seq)
    }, staleMs)
  }

  const handleSilence = async (expectedSeq) => {
    if (disposed) return
    if (latestSnapshot.seq !== expectedSeq) return
    if (latestSnapshot.status?.isRunning !== true) return

    silentSeq = expectedSeq
    notify()

    await probe()
  }

  const probe = async () => {
    if (disposed || !exchange) return
    probeInFlight = true
    notify()

    let ok = false
    let status = null
    let errorMsg = null
    let handledByCustomFetch = false

    if (typeof fetchStatus === 'function') {
      const token = requestOwner.claim()
      const signal = requestOwner.getSignal()
      try {
        const result = await fetchStatus({ signal, exchange, pair, pairQuery })
        if (disposed || !requestOwner.owns(token)) return
        if (result !== undefined) {
          handledByCustomFetch = true
          if (result && typeof result === 'object') {
            ok = true
            status = result.status || result
          } else {
            ok = false
            errorMsg = 'Invalid status response'
          }
        }
      } catch (err) {
        if (disposed || !requestOwner.owns(token)) return
        handledByCustomFetch = true
        ok = false
        errorMsg = err.message || 'Status probe failed'
      }
    }

    if (!handledByCustomFetch) {
      const url = `/api/${exchange}/regime/status${pairQuery}`
      const res = await requestOwner.read(url)
      if (disposed || !res.owned) return
      ok = res.ok
      status = res.data?.status
      errorMsg = res.data?.error || (res.ok ? 'Invalid status response' : 'Status request failed')
    }

    probeInFlight = false
    const valid = ok && status && typeof status === 'object'

    if (valid) {
      probeFailed = false
      probeError = null
      silentSeq = null
      acceptSnapshot(status, nextRegimeStatusSeq(), { isSocket: false })
    } else {
      probeFailed = true
      probeError = errorMsg || 'Status probe failed'
      notify()
    }
  }

  const acceptSnapshot = (newStatus, seq, { isSocket = false } = {}) => {
    if (disposed || !newStatus) return
    const incomingSeq = seq ?? nextRegimeStatusSeq()

    if (latestSnapshot.status && incomingSeq < latestSnapshot.seq) return

    const merged = isSocket
      ? mergeRegimeStatus(latestSnapshot.status, newStatus)
      : newStatus

    latestSnapshot = { status: merged, seq: incomingSeq }
    silentSeq = null
    probeFailed = false
    probeError = null
    requestOwner.invalidate()

    if (merged?.isRunning === true) {
      armWatchdog(incomingSeq)
    } else {
      clearWatchdog()
    }

    notify()
    return latestSnapshot
  }

  const retry = () => probe()

  const subscribe = (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  const dispose = () => {
    disposed = true
    clearWatchdog()
    requestOwner.invalidate()
    listeners.clear()
  }

  if (latestSnapshot.status?.isRunning === true) {
    armWatchdog(latestSnapshot.seq)
  }

  return {
    acceptSnapshot,
    probe,
    retry,
    getSnapshot,
    subscribe,
    dispose,
    clearWatchdog,
    get isDisposed() { return disposed },
  }
}
