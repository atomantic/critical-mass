// Harness stand-in for admin/src/utils/apiClient.js.
// Rolldown externalizes the client, and these renders call the harness `fetch`,
// so the real module (which uses the global fetch) cannot be loaded instead.
const apiClientStub = (fetchImpl) => {
  const describe = (status, body) => {
    const data = body && typeof body === 'object' ? body : {}
    return data.error || data.message || (status ? `HTTP ${status}` : 'Network error')
  }
  const apiRequest = async (method, url, { body, rawBody, contentType, signal, allowEmpty = false, asText = false, headers } = {}) => {
    // Harness fetch stubs treat any `method` as a write, so a GET goes out without one.
    const init = method === 'GET' ? { signal } : { method, signal }
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
      res = await fetchImpl(url, init)
    } catch (err) {
      if (err?.name === 'AbortError') throw err
      return { ok: false, status: 0, data: null, error: err?.message || 'Network error' }
    }
    let data = null
    try {
      data = asText
        ? (typeof res.text === 'function' ? await res.text() : null)
        : (typeof res.json === 'function' ? await res.json() : null)
    } catch {
      data = null
    }
    const status = typeof res.status === 'number' ? res.status : (res.ok ? 200 : 0)
    const ok = Boolean(res.ok) && data?.success !== false && (allowEmpty || data !== null)
    return { ok, status, data, error: ok ? null : describe(res.ok && data === null ? 0 : status, data) }
  }
  return {
    apiRequest,
    apiGet: (url, opts) => apiRequest('GET', url, opts),
    apiPost: (url, body, opts) => apiRequest('POST', url, { ...opts, body }),
    apiPut: (url, body, opts) => apiRequest('PUT', url, { ...opts, body }),
    apiPatch: (url, body, opts) => apiRequest('PATCH', url, { ...opts, body }),
    apiFetch: (url, init) => fetchImpl(url, init),
    onUnauthorized: () => () => {},
    apiDelete: (url, opts) => apiRequest('DELETE', url, opts),
    describeMutationFailure: (result, fallback = 'Request failed') => (
      result.status === 0
        ? `${result.error || fallback}. The request may have reached the server; refresh status before retrying.`
        : result.error || fallback
    ),
  }
}

module.exports = { apiClientStub }
