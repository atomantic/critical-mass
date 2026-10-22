/** @vitest-environment jsdom */
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithToasts as render } from './renderWithToasts'
import GatewayAccess from '../src/components/GatewayAccess'

vi.mock('../src/lib/router', () => ({ Link: ({ children, ...props }) => <a {...props}>{children}</a> }))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('GatewayAccess', () => {
  it('shows loading and a retry control when the session status cannot be read', async () => {
    let resolveSession
    const fetch = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSession = resolve }))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ required: true }) })
    vi.stubGlobal('fetch', fetch)

    render(<GatewayAccess />)
    expect(screen.getByRole('status').textContent).toBe('Checking…')
    expect(screen.queryByLabelText('Current password')).toBeNull()

    resolveSession({ ok: false, status: 500, json: async () => ({}) })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByLabelText('Current password')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByLabelText('Current password')).toBeTruthy()
    expect(screen.getByText('Password set')).toBeTruthy()
    expect(screen.queryByText('open')).toBeNull()
    expect(screen.queryByText('Require sign-in')).toBeNull()
  })

  it('sends the current password for password changes and removal', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ required: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
    vi.stubGlobal('fetch', fetch)

    render(<GatewayAccess />)
    await screen.findByLabelText('Current password')
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'old-secret' } })
    fireEvent.change(screen.getByLabelText('New password (min 8 characters)'), { target: { value: 'new-secret' } })
    fireEvent.change(screen.getByLabelText('Confirm'), { target: { value: 'new-secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ password: 'new-secret', currentPassword: 'old-secret' })
    expect(await screen.findByText('Password changed.')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'old-secret' } })
    vi.stubGlobal('setTimeout', vi.fn())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove password' }))
      await Promise.resolve()
    })
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ password: 'old-secret' })
    expect(screen.getByText(/Password removed\. The gateway will ask you to create a new one/)).toBeTruthy()
  })
})
