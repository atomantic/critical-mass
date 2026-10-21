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
