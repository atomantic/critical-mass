import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithToasts as render } from './renderWithToasts'
import SentinelDashboard from '../src/components/sentinel/Dashboard.jsx'

vi.mock('../src/hooks/useSentinelSocket.js', () => ({
  default: () => ({ connected: true, latestAlert: null }),
}))

const status = {
  running: true,
  config: { enabled: true, feeds: [{ name: 'Market News', url: 'https://news.example/rss', enabled: true }] },
  pollCount: 1, totalAlerts: 1, activeAlerts: 1,
}
const alert = { id: 'alert-1', severity: 'warning', source: 'Market News', title: 'Test alert', publishedAt: Date.now() }
const ok = (body = {}) => ({ ok: true, status: 200, json: async () => body })

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (url === '/api/sentinel/status') return ok(status)
    if (url.startsWith('/api/sentinel/alerts')) return ok({ alerts: [alert], items: [alert] })
    if (url === '/api/sentinel/config' && options?.method === 'PUT') return ok({ success: true })
    return ok()
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('keeps every operational control at a 44px target and the feed switch operable', async () => {
  render(<SentinelDashboard />)
  await screen.findByText('Test alert')

  const controls = [
    screen.getByRole('button', { name: 'Stop' }),
    screen.getByRole('button', { name: 'Remove Market News feed' }),
    screen.getByRole('button', { name: 'Add Feed' }),
    screen.getByRole('button', { name: 'Dismiss' }),
    screen.getByRole('button', { name: /Clear all alerts/ }),
    screen.getByRole('switch', { name: 'Enable Market News feed' }),
  ]
  for (const control of controls) expect(control.className, control.textContent).toContain('min-h-11')

  const toggle = screen.getByRole('switch', { name: 'Enable Market News feed' })
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(toggle)
  await waitFor(() => expect(fetch.mock.calls.some(([url, o]) => url === '/api/sentinel/config' && o?.method === 'PUT')).toBe(true))
})
