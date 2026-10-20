import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import TradeHistory from '../src/components/updown/TradeHistory'
import SentinelDashboard from '../src/components/sentinel/Dashboard'
import AIProviders from '../src/components/ai/Providers'
vi.mock('../src/components/Toast', () => ({ useToast: () => ({ addToast: vi.fn() }) }))
vi.mock('../src/hooks/useSentinelSocket', () => ({ default: () => ({ connected: true }) }))
HTMLDialogElement.prototype.showModal = function () { this.open = true; this.querySelector('[autofocus]')?.focus() }
HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')) }
const trade = { id: 7, date: '2026-09-09', direction: 'up', cost: 500, returnAmount: 600 }
let alerts, writes, fail, failMessage, release, providers
beforeEach(() => {
  alerts = [{ id: 1, title: 'News', severity: 'critical', dismissed: false }]
  writes = []; fail = false; failMessage = 'Delete failed'; release = null
  providers = [{ id: 'provider-1', name: 'OpenAI', type: 'api', enabled: true, endpoint: 'https://api.example.com' }]
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (options) {
      writes.push({ url, ...options })
      if (release) await release
      if (options.method === 'DELETE' && !fail) providers = []
      return { ok: !fail, status: fail ? 400 : 200, json: async () => fail ? { error: failMessage } : ({}) }
    }
    return { ok: true, json: async () => url === '/api/providers' ? { providers, activeProvider: 'provider-1' } : url === '/api/runs?limit=20' ? { runs: [] } : url.includes('updown') ? { success: true, trades: [trade] } : url.endsWith('status') ? { config: { feeds: [{ name: 'Example', url: 'https://example.com/rss', enabled: true }] } } : { alerts } }
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function escape() {
  const dialog = screen.getByRole('dialog')
  const event = new Event('cancel', { cancelable: true })
  if (dialog.dispatchEvent(event)) dialog.close()
  return event
}
it('trade delete requires confirmation; Cancel and Escape preserve data; failed writes retain dialog and rows', async () => {
  render(<TradeHistory />)
  const trigger = await screen.findByRole('button', { name: /Delete trade from/ })
  fireEvent.click(trigger)
  expect(writes).toHaveLength(0)
  expect(document.activeElement.textContent).toBe('Cancel')
  expect(screen.getByText(/Trade from 2026-09-09.*cost \$500.00/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  fireEvent.click(trigger); act(() => { escape() })
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(trigger); fail = true
  fireEvent.click(screen.getByRole('button', { name: 'Delete trade' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.getByRole('button', { name: /Delete trade from/ })).toBeTruthy()
  expect(writes).toHaveLength(1)
})
it('provider delete names the default provider, waits for confirmation, and stays open with the server error', async () => {
  render(<AIProviders />)
  const trigger = await screen.findByRole('button', { name: 'Delete' })
  fireEvent.click(trigger)
  expect(writes).toHaveLength(0)
  expect(screen.getByRole('heading', { name: 'Delete provider "OpenAI"?' })).toBeTruthy()
  expect(screen.getByText(/This is your default provider\./)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(trigger)
  act(() => { escape() })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(writes).toHaveLength(0)
  fireEvent.click(trigger)
  fail = true
  failMessage = 'Provider is in use by a running prompt'
  fireEvent.click(screen.getByRole('button', { name: 'Delete provider' }))
  expect((await screen.findByRole('alert')).textContent).toContain(failMessage)
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Delete provider "OpenAI"?' })).toBeTruthy()
  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatchObject({ url: '/api/providers/provider-1', method: 'DELETE' })
  fail = false
  fireEvent.click(screen.getByRole('button', { name: 'Delete provider' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(writes).toHaveLength(2)
})
it.each([1, 3])('clear counts all %i alerts including those hidden by filtering and guards pending dismissal', async count => {
  alerts = Array.from({ length: count }, (_, id) => ({ id, title: 'News', severity: 'info', dismissed: id > 0 }))
  render(<SentinelDashboard />)
  fireEvent.click(await screen.findByRole('button', { name: 'Clear all alerts' }))
  await screen.findByRole('heading', { name: `Clear all ${count} ${count === 1 ? 'alert' : 'alerts'}?` })
  expect(screen.getByText(/including 1 undismissed/)).toBeTruthy()
  expect(writes).toHaveLength(0)
  expect(document.activeElement.textContent).toBe('Cancel')
  let finish; release = new Promise(resolve => { finish = resolve })
  fireEvent.click(screen.getByRole('button', { name: 'Clear alerts' }))
  expect(escape().defaultPrevented).toBe(true)
  expect(screen.getByRole('button', { name: 'Cancel' }).disabled).toBe(true)
  finish()
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(writes[0].method).toBe('DELETE')
})
it('feed removal confirms the named feed, preserves it on failure, and succeeds on retry', async () => {
  render(<SentinelDashboard />)
  fireEvent.click(await screen.findByRole('button', { name: 'Remove Example feed' }))
  expect(writes).toHaveLength(0)
  expect(screen.getByRole('heading', { name: 'Remove feed "Example"?' })).toBeTruthy()
  fail = true
  fireEvent.click(screen.getByRole('button', { name: 'Remove feed' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: 'Remove Example feed' })).toBeTruthy()
  fail = false
  fireEvent.click(screen.getByRole('button', { name: 'Remove feed' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(JSON.parse(writes[1].body).feeds).toEqual([])
})

it('clearing alerts retains rows after a failed write', async () => {
  render(<SentinelDashboard />)
  fireEvent.click(await screen.findByRole('button', { name: 'Clear all alerts' }))
  await screen.findByRole('button', { name: 'Clear alerts' })
  fail = true
  fireEvent.click(screen.getByRole('button', { name: 'Clear alerts' }))
  await screen.findByRole('alert')
  expect(screen.getByText('News')).toBeTruthy()
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(writes).toHaveLength(1)
})
