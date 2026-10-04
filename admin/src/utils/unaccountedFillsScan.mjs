// Manual Trades unaccounted-fills read (issue #966).
//
// A long exchange history is scanned by an engine-owned job: the start request
// answers promptly with either the complete result or `pending: true` plus a
// `jobId`, and the job's status route is polled until it is complete or has
// genuinely failed. Polling only ever reads status — it never starts another
// scan — and a partial traversal is never shown as a result.

export const UNACCOUNTED_POLL_MS = 1500
// Consecutive transport failures tolerated while polling before giving up.
export const UNACCOUNTED_MAX_POLL_ERRORS = 3

const readJson = async (fetchImpl, url) => {
  const res = await fetchImpl(url)
  return res.json()
}

/**
 * Describe scan progress for display.
 * @param {{fraction?: number, pages?: number}|null|undefined} progress
 * @returns {string}
 */
export const describeScanProgress = (progress) => {
  if (!progress) return 'Scanning exchange history...'
  const pct = Math.max(0, Math.min(100, Math.floor((progress.fraction || 0) * 100)))
  const pages = Number.isFinite(progress.pages) ? `, ${progress.pages} page${progress.pages === 1 ? '' : 's'}` : ''
  return `Scanning exchange history... ${pct}%${pages}`
}

/**
 * Start (or join) the scan and wait for its complete result.
 * @param {Object} params
 * @param {string} params.exchange
 * @param {string} params.pairQuery - `?pair=...` or ''
 * @param {string} params.startDate
 * @param {(url: string) => Promise<{json: () => Promise<any>}>} [params.fetchImpl]
 * @param {(ms: number) => Promise<void>} [params.sleep]
 * @param {() => boolean} [params.isCancelled] - true once the caller no longer wants the result
 * @param {(progress: any) => void} [params.onProgress]
 * @param {number} [params.pollMs]
 * @returns {Promise<{status: 'complete', data: any} | {status: 'failed', error: string} | {status: 'cancelled'}>}
 */
export const runUnaccountedFillsScan = async ({
  exchange,
  pairQuery,
  startDate,
  fetchImpl = (url) => fetch(url),
  sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  isCancelled = () => false,
  onProgress = () => {},
  pollMs = UNACCOUNTED_POLL_MS,
}) => {
  const sep = pairQuery ? '&' : '?'
  let data
  try {
    data = await readJson(fetchImpl, `/api/${exchange}/regime/unaccounted-fills${pairQuery}${sep}startDate=${encodeURIComponent(startDate)}`)
  } catch (err) {
    return isCancelled() ? { status: 'cancelled' } : { status: 'failed', error: err?.message || 'Failed to fetch' }
  }

  let pollErrors = 0
  while (true) {
    if (isCancelled()) return { status: 'cancelled' }
    if (!data?.success) return { status: 'failed', error: data?.error || 'Failed to fetch' }
    if (!data.pending) return { status: 'complete', data }

    onProgress(data.progress || null)
    const jobId = data.jobId
    if (!jobId) return { status: 'failed', error: 'Scan is pending but returned no job id' }
    await sleep(pollMs)
    if (isCancelled()) return { status: 'cancelled' }
    try {
      const next = await readJson(fetchImpl, `/api/${exchange}/regime/unaccounted-fills/jobs/${encodeURIComponent(jobId)}${pairQuery}`)
      pollErrors = 0
      data = next
    } catch (err) {
      // A transient gateway hiccup must not abandon a scan that is still
      // running in the engine; keep the last status and poll again.
      if (++pollErrors >= UNACCOUNTED_MAX_POLL_ERRORS) {
        return { status: 'failed', error: err?.message || 'Failed to read scan status' }
      }
    }
  }
}
