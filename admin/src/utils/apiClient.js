/**
 * Shared admin API client.
 *
 * Every call resolves to `{ ok, status, data, error }` and never throws for an
 * HTTP failure, a non-JSON body (proxy 5xx page) or a network error. `ok` is
 * false for `!res.ok` AND for a 2xx body carrying `success: false`; `error` is
 * then the operator-facing reason from `describeActionFailure`. The one thing
 * that does throw is an AbortError, so callers using an AbortSignal can ignore
 * it the way they already do.
 *
 * The wire format is plain fetch, so the global 401 hook in OperatorLogin keeps
 * working and call sites can adopt this file by file.
 */
import { describeActionFailure } from './actionFailure.mjs'

// A non-JSON body (proxy 5xx page, empty 204) reads as null rather than throwing.
const parseBody = (res) => res.json().catch(() => null)

export async function apiRequest(method, url, { body, signal } = {}) {
  const init = { method, signal }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  let res
  try {
    res = await fetch(url, init)
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    return { ok: false, status: 0, data: null, error: err?.message || 'Network error' }
  }
  const data = await parseBody(res)
  const ok = res.ok && data?.success !== false
  return { ok, status: res.status, data, error: ok ? null : describeActionFailure(res.status, data) }
}

export const apiGet = (url, opts) => apiRequest('GET', url, opts)
export const apiPost = (url, body, opts) => apiRequest('POST', url, { ...opts, body })
export const apiPut = (url, body, opts) => apiRequest('PUT', url, { ...opts, body })
export const apiDelete = (url, opts) => apiRequest('DELETE', url, opts)
