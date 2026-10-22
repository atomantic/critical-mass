import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import OperatorLogin from '../src/components/OperatorLogin'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })

function sessionResponse(session = { required: true, authenticated: false }) {
  return { ok: true, status: 200, json: async () => session }
}

describe('OperatorLogin recovery', () => {
  it('treats a non-OK JSON session response as unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => ({ error: 'proxy error' }) })))
    render(<OperatorLogin><p>Private controls</p></OperatorLogin>)

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.queryByText('Private controls')).toBeNull()
    expect(screen.queryByLabelText('Password')).toBeNull()
  })

  it('offers a session retry without exposing the password form when the gateway is unreachable', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce(sessionResponse())
    vi.stubGlobal('fetch', fetchMock)
    render(<OperatorLogin><p>Private controls</p></OperatorLogin>)

    const retry = await screen.findByRole('button', { name: 'Try again' })
    expect(screen.getByRole('heading', { name: "Can't reach the gateway" })).toBeTruthy()
    expect(screen.queryByLabelText('Password')).toBeNull()
    fireEvent.click(retry)

    await screen.findByLabelText('Password')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('shows a clear error and keeps the form available when sign-in fetch rejects', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sessionResponse())
      .mockRejectedValueOnce(new Error('connection reset'))
    vi.stubGlobal('fetch', fetchMock)
    render(<OperatorLogin><p>Private controls</p></OperatorLogin>)
    const password = await screen.findByLabelText('Password')
    fireEvent.change(password, { target: { value: 'correct horse battery staple' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Your password was not checked')
    expect(screen.getByRole('button', { name: 'Sign in' }).disabled).toBe(false)
  })

  it.each([429, 502])('does not call HTTP %s a bad password when the response has no error body', async (status) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce({ ok: false, status, json: async () => { throw new Error('not JSON') } })
    vi.stubGlobal('fetch', fetchMock)
    render(<OperatorLogin><p>Private controls</p></OperatorLogin>)
    fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect((await screen.findByRole('alert')).textContent).toBe(`Sign-in failed (HTTP ${status}).`)
  })

  it('identifies an empty 401 response as a rejected password', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => { throw new Error('not JSON') } })
    vi.stubGlobal('fetch', fetchMock)
    render(<OperatorLogin><p>Private controls</p></OperatorLogin>)
    fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect((await screen.findByRole('alert')).textContent).toBe('That password was not accepted.')
  })

  it('preserves the first-password bootstrap screen after a successful retry', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('gateway restarting'))
      .mockResolvedValueOnce(sessionResponse({ required: true, authenticated: false, bootstrapRequired: true, bootstrapSecretRequired: true }))
    vi.stubGlobal('fetch', fetchMock)
    render(<OperatorLogin><p>Private controls</p></OperatorLogin>)
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('heading', { name: 'Set up operator access' })).toBeTruthy()
    expect(screen.getByLabelText('Bootstrap secret')).toBeTruthy()
    expect(screen.getByLabelText('New password')).toBeTruthy()
  })
})

describe('OperatorLogin session expiry', () => {
  it('returns to sign-in when any API call later answers 401', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sessionResponse({ required: true, authenticated: true }))
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: 'Sign in required' }) })
    vi.stubGlobal('fetch', fetchMock)
    const { apiGet } = await import('../src/utils/apiClient')
    render(<OperatorLogin><p>Private controls</p></OperatorLogin>)
    await screen.findByText('Private controls')
    await apiGet('/api/anything')
    expect(await screen.findByLabelText('Password')).toBeTruthy()
    expect(screen.queryByText('Private controls')).toBeNull()
  })

  it('does not patch window.fetch', async () => {
    const stub = vi.fn().mockResolvedValue(sessionResponse({ required: false, authenticated: false }))
    vi.stubGlobal('fetch', stub)
    render(<OperatorLogin><p>Private controls</p></OperatorLogin>)
    await screen.findByText('Private controls')
    expect(window.fetch).toBe(stub)
  })
})
