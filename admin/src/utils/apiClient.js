/**
 * Shared admin API client.
 *
 * Every call resolves to `{ ok, status, data, error }` and never throws for an
 * HTTP failure, a non-JSON body (proxy 5xx page) or a network error. `ok` is
 * false for `!res.ok` AND for a 2xx body carrying `success: false`; `error` is
 * then the operator-facing reason from `describeActionFailure`. The one thing
 * that does throw is an AbortError, so callers using an AbortSignal can ignore
 * it the way they already do. Pass `allowEmpty: true` for replies that legitimately carry no body.
 *
 * Every request made here (and by `apiFetch`, for helpers that need the raw
 * Response) tells `onUnauthorized` subscribers about a 401, so the operator
 * sign-in boundary does not have to patch `window.fetch`.
 */
import { describeActionFailure } from './actionFailure.mjs'

// A non-JSON body (proxy 5xx page, empty 204) reads as null rather than throwing.
// `asText` reads a plain-text body (e.g. a stored prompt) as a string instead.
const parseBody = (res, asText) => (asText ? res.text() : res.json()).catch(() => null)

const unauthorizedHandlers = new Set()

// Subscribe to 401 replies from any API request. Returns the unsubscribe function.
export function onUnauthorized(handler) {
  unauthorizedHandlers.add(handler)
  return () => { unauthorizedHandlers.delete(handler) }
}

// fetch that reports a 401 reply to `onUnauthorized` subscribers. For low-level
// helpers that inject their own transport and need the raw Response; everything
// else should call apiGet/apiPost/apiPut/apiDelete.
export async function apiFetch(url, init) {
  const res = await fetch(url, init)
  if (res.status === 401) unauthorizedHandlers.forEach(handler => handler())
  return res
}

// `headers` adds request headers; `rawBody` sends a File/Blob as-is under `contentType` (e.g. a screenshot upload) instead of JSON.
export async function apiRequest(method, url, { body, rawBody, contentType, signal, allowEmpty = false, asText = false, headers } = {}) {
  const init = { method, signal }
  if (headers) init.headers = { ...headers }
  if (rawBody !== undefined) {
    init.headers = { ...init.headers, 'Content-Type': contentType }
    init.body = rawBody
  } else if (body !== undefined) {
    init.headers = { ...init.headers, 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  let res
  try {
    res = await apiFetch(url, init)
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    return { ok: false, status: 0, data: null, error: err?.message || 'Network error' }
  }
  const data = await parseBody(res, asText)
  // A fetch Response always carries a numeric status. A stand-in that only sets
  // `ok` is treated as 200 or as no status at all, so callers can keep using status.
  const status = typeof res.status === 'number' ? res.status : (res.ok ? 200 : 0)
  // A 2xx page that is not JSON (a proxy HTML page) is a failure unless the caller expects an empty reply.
  const ok = res.ok && data?.success !== false && (allowEmpty || data !== null)
  if (ok) return { ok, status, data, error: null }
  return { ok, status, data, error: describeActionFailure(res.ok && data === null ? 0 : status, data) }
}

export const apiGet = (url, opts) => apiRequest('GET', url, opts)
export const apiPost = (url, body, opts) => apiRequest('POST', url, { ...opts, body })
export const apiPut = (url, body, opts) => apiRequest('PUT', url, { ...opts, body })
export const apiPatch = (url, body, opts) => apiRequest('PATCH', url, { ...opts, body })
export const apiDelete = (url, opts) => apiRequest('DELETE', url, opts)

// Operator-facing reason for a failed mutation. status 0 means no reply was
// read, so the request may still have reached the server: say so instead of a
// bare "Failed to fetch".
export const describeMutationFailure = (result, fallback = 'Request failed') => (
  result.status === 0
    ? `${result.error || fallback}. The request may have reached the server; refresh status before retrying.`
    : result.error || fallback
)
