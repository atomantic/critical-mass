import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import AIProviders from '../src/components/ai/Providers'

vi.mock('../src/components/Toast', () => ({ useToast: () => ({ addToast: vi.fn() }) }))

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const providers = { providers: [{ id: 'p1', name: 'Example API', type: 'api', enabled: true, endpoint: 'https://api.example.com' }], activeProvider: 'p1' }

const stubProviders = (write) => vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
  if (init.method && init.method !== 'GET') return write(url, init)
  if (url === '/api/providers') return reply(200, providers)
  if (url === '/api/runs?limit=20') return reply(200, { runs: [] })
  return reply(200, {})
}))

it('joins validation errors when a provider write is rejected', async () => {
  stubProviders(() => reply(400, { errors: ['endpoint is required', 'timeout must be positive'] }))
  render(<AIProviders />)
  fireEvent.click(await screen.findByRole('button', { name: 'Disable' }))
  expect((await screen.findByRole('alert')).textContent).toBe('endpoint is required, timeout must be positive')
})

it('says a provider write may have been applied when the reply never arrived', async () => {
  stubProviders(() => { throw new TypeError('Failed to fetch') })
  render(<AIProviders />)
  fireEvent.click(await screen.findByRole('button', { name: 'Disable' }))
  expect((await screen.findByRole('alert')).textContent).toMatch(/Failed to fetch.*may have reached the server/)
})

it('accepts a provider write that answers without a body', async () => {
  stubProviders(() => ({ ok: true, status: 204, json: async () => { throw new SyntaxError('Unexpected end of JSON input') } }))
  render(<AIProviders />)
  fireEvent.click(await screen.findByRole('button', { name: 'Disable' }))
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/providers/p1', expect.objectContaining({ method: 'PUT' })))
  expect(screen.queryByRole('alert')).toBeNull()
})

it('reads a finished run that recorded success:false as done, not unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    if (url === '/api/providers') return reply(200, providers)
    if (url === '/api/runs?limit=20') return reply(200, { runs: [{ id: 'r1', providerId: 'p1', prompt: 'x', startTime: '2026-10-10T00:00:00.000Z' }] })
    if (url === '/api/runs/r1') return reply(200, { id: 'r1', success: false, endTime: '2026-10-10T00:01:00.000Z' })
    return reply(200, {})
  }))
  render(<AIProviders />)
  await screen.findByText('Example API')
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/runs/r1', expect.anything()))
  expect(screen.queryByText('Status unavailable')).toBeNull()
})
