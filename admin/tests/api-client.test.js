import { describe, it, expect, vi, afterEach } from 'vitest'
import { apiGet, apiPost, apiDelete, apiFetch, onUnauthorized, describeMutationFailure } from '../src/utils/apiClient'

const reply = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
})

afterEach(() => vi.unstubAllGlobals())

describe('apiClient', () => {
  it('treats a status-less ok response as HTTP 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ price: 1 }) }))
    expect(await apiGet('/api/x')).toMatchObject({ ok: true, status: 200, data: { price: 1 }, error: null })
  })

  it('returns parsed data on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { price: 5 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await apiGet('/api/x')).toEqual({ ok: true, status: 200, data: { price: 5 }, error: null })
    expect(fetchMock).toHaveBeenCalledWith('/api/x', { method: 'GET', signal: undefined })
  })

  it('sends JSON bodies with a content-type header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { success: true }))
    vi.stubGlobal('fetch', fetchMock)
    await apiPost('/api/x', { a: 1 })
    expect(fetchMock).toHaveBeenCalledWith('/api/x', {
      method: 'POST', signal: undefined, headers: { 'Content-Type': 'application/json' }, body: '{"a":1}',
    })
  })

  it('surfaces the server reason for an HTTP failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(400, { success: false, error: 'bad pair' })))
    expect(await apiPost('/api/x', {})).toMatchObject({ ok: false, status: 400, error: 'bad pair' })
  })

  it('treats a 2xx success:false body as a failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { success: false, message: 'engine busy' })))
    expect(await apiGet('/api/x')).toMatchObject({ ok: false, status: 200, error: 'engine busy' })
  })

  it('does not throw on a non-JSON 5xx body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(502, '<html>Bad gateway</html>')))
    const result = await apiDelete('/api/x')
    expect(result).toMatchObject({ ok: false, status: 502, data: null })
    expect(result.error).toContain('HTTP 502')
  })

  it('treats a 200 non-JSON body as a failure unless an empty reply is allowed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, '<html>proxy</html>')))
    expect(await apiGet('/api/x')).toMatchObject({ ok: false, status: 200, data: null })
    expect(await apiDelete('/api/x', { allowEmpty: true })).toMatchObject({ ok: true, data: null, error: null })
  })

  it('reports a network error as a failed result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    expect(await apiGet('/api/x')).toEqual({ ok: false, status: 0, data: null, error: 'Failed to fetch' })
  })

  it('rethrows an abort', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort))
    await expect(apiGet('/api/x')).rejects.toBe(abort)
  })
})

describe('describeMutationFailure', () => {
  it('flags an unread reply as possibly applied', () => {
    const text = describeMutationFailure({ status: 0, error: 'Failed to fetch' }, 'Import failed')
    expect(text).toContain('Failed to fetch')
    expect(text).toContain('may have reached the server')
  })

  it('passes a server rejection reason through unchanged', () => {
    expect(describeMutationFailure({ status: 400, error: 'Bad price' }, 'Import failed')).toBe('Bad price')
  })

  it('falls back when no reason is present', () => {
    expect(describeMutationFailure({ status: 500, error: null }, 'Import failed')).toBe('Import failed')
  })
})

describe('onUnauthorized', () => {
  it('notifies subscribers of a 401 from apiGet and still returns the failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(401, { error: 'Sign in required' })))
    const handler = vi.fn()
    const off = onUnauthorized(handler)
    expect(await apiGet('/api/x')).toMatchObject({ ok: false, status: 401, error: 'Sign in required' })
    expect(handler).toHaveBeenCalledTimes(1)
    off()
  })

  it('notifies on a 401 read through apiFetch and returns the raw response', async () => {
    const raw = reply(401, {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(raw))
    const handler = vi.fn()
    const off = onUnauthorized(handler)
    expect(await apiFetch('/api/x')).toBe(raw)
    expect(handler).toHaveBeenCalledTimes(1)
    off()
  })

  it('stays quiet for other failures and after unsubscribing', async () => {
    const handler = vi.fn()
    const off = onUnauthorized(handler)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(403, { error: 'no' })))
    await apiGet('/api/x')
    off()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(401, {})))
    await apiGet('/api/x')
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('request options', () => {
  it('merges custom headers with the JSON content type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { ok: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    await apiPost('/api/x', { a: 1 }, { headers: { 'X-Operator-Bootstrap': 's' } })
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'X-Operator-Bootstrap': 's', 'Content-Type': 'application/json' })
  })

  it('reads a plain-text body as a string with asText', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => 'saved prompt' }))
    expect(await apiGet('/api/p', { asText: true })).toMatchObject({ ok: true, data: 'saved prompt' })
  })
})

describe('run lifecycle transport', () => {
  it('reports a 401 from the run poller through onUnauthorized', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(401, {})))
    const { createRunLifecycle } = await import('../src/utils/runLifecycle.mjs')
    const handler = vi.fn()
    const off = onUnauthorized(handler)
    const lifecycle = createRunLifecycle({ setTimer: () => 0, clearTimer: () => {} })
    lifecycle.stop('r1')
    await vi.waitFor(() => expect(handler).toHaveBeenCalled())
    off()
  })
})
