import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithToasts as render } from './renderWithToasts'
import AlertBanner from '../src/components/sentinel/AlertBanner'
import SentinelDashboard from '../src/components/sentinel/Dashboard'
import TradeHistory from '../src/components/updown/TradeHistory'
import { completePagedItems } from '../src/utils/pagedList.mjs'

vi.mock('../src/hooks/useSentinelSocket', () => ({ default: () => ({ connected: true }) }))
vi.mock('../src/lib/router', () => ({ Link: ({ children, to, ...props }) => <a href={to} {...props}>{children}</a> }))
HTMLDialogElement.prototype.showModal = function () { this.open = true }
HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')) }
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const ok = data => ({ ok: true, status: 200, json: async () => data })
const unavailable = { ok: false, status: 503, json: async () => ({}) }
const page = (items, total = items.length, summary) => ({ success: true, items, total, summary })
const alert = (id, severity = 'info') => ({ id, severity, title: `Synthetic alert ${id}` })
const first500 = Array.from({ length: 500 }, (_, i) => alert(i))
const critical = alert(500, 'critical')
const trade = (id, note) => ({ id, note, date: '2026-10-22', cost: 10, returnAmount: 20 })

it.each(['503', 'network', 'malformed', 'unreadable', 'empty'])('rejects an incomplete collection after a later-page %s and recovers', async failure => {
  let down = true
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (!down) return ok(page([critical]))
    if (failure === 'network') throw new Error('offline')
    if (failure === 'malformed') return ok({ items: {} })
    if (failure === 'unreadable') return { ok: true, json: async () => { throw new Error('invalid json') } }
    return failure === 'empty' ? ok(page([])) : unavailable
  }))
  await expect(completePagedItems('/api/sentinel/alerts', page(first500, 501))).rejects.toThrow()
  down = false
  await expect(completePagedItems('/api/sentinel/alerts', page(first500, 501))).resolves.toHaveLength(501)
  await expect(completePagedItems('/api/sentinel/alerts', page([critical]))).resolves.toEqual([critical])
})

it('keeps a visible global warning for the 501st active alert when its page fails, then recovers on Retry', async () => {
  let down = true
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (url.endsWith('/status')) return ok({ criticalAlerts: 1, warningAlerts: 0 })
    if (url.includes('offset=500')) return down ? unavailable : ok(page([critical]))
    return ok(page(first500, 501))
  }))
  render(<AlertBanner />)
  expect((await screen.findByRole('alert')).textContent).toContain('Sentinel alerts unavailable.')
  expect(screen.getByRole('link').getAttribute('href')).toBe('/sentinel')
  down = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('Synthetic alert 500')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
})

it('retains matching Sentinel data on later-page failure, blocks Clear-all, and retries the full collection', async () => {
  let mode = 'initial'
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (url.endsWith('/status')) return ok({ config: { feeds: [] } })
    if (url.includes('offset=500')) return mode === 'down' ? unavailable : ok(page([critical]))
    return ok(mode === 'initial' ? page([alert('saved', 'critical')]) : page(first500, 501))
  }))
  render(<SentinelDashboard />)
  await screen.findByText('Synthetic alert saved')
  mode = 'down'
  fireEvent.click(screen.getByRole('button', { name: 'Force Poll' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Showing the last loaded alerts.')
  expect(screen.getByText('Synthetic alert saved')).toBeTruthy()
  expect(screen.queryByText('Synthetic alert 0')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Clear all alerts' }))
  await screen.findByText('Unable to load alerts. Please try again before clearing them.')
  expect(screen.queryByRole('dialog')).toBeNull()
  mode = 'ready'
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('Synthetic alert 500')
  expect(screen.queryByText('Synthetic alert saved')).toBeNull()
  expect(screen.queryByText(/Showing the last loaded alerts/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Clear all alerts' }))
  expect(await screen.findByText('Clear all 501 alerts?')).toBeTruthy()
})

it('initial incomplete trade history is an error, and retry adopts all rows and their matching summary', async () => {
  let down = true
  vi.stubGlobal('fetch', vi.fn(async url => url.includes('offset=1')
    ? down ? unavailable : ok(page([trade(2, 'Second trade')]))
    : ok(page([trade(1, 'First trade')], 2, { count: 2, wins: 2 }))))
  render(<TradeHistory />)
  await screen.findByRole('alert')
  expect(screen.queryByTitle('First trade')).toBeNull()
  expect(screen.queryByText('2 trades')).toBeNull()
  expect(screen.queryByText(/No trades recorded yet/)).toBeNull()
  down = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByTitle('Second trade')
  expect(screen.getByTitle('First trade')).toBeTruthy()
  expect(screen.getByText('2 trades')).toBeTruthy()
})

it('trade refresh failure preserves its previous table and summary until a complete retry', async () => {
  let reads = 0, down = true
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (options?.method === 'POST') return ok({ success: true })
    if (url.includes('offset=1')) return down ? unavailable : ok(page([trade(3, 'Later trade')]))
    reads += 1
    return ok(reads === 1 ? page([trade(1, 'Saved snapshot')], 1, { count: 1, wins: 1 })
      : page([trade(2, 'Replacement snapshot')], 2, { count: 2, wins: 2 }))
  }))
  render(<TradeHistory />)
  await screen.findByTitle('Saved snapshot')
  fireEvent.click(screen.getByRole('button', { name: /Add Trade/ }))
  fireEvent.change(screen.getByLabelText('Cost (Open)'), { target: { value: '10' } })
  fireEvent.change(screen.getByLabelText('Return (Close)'), { target: { value: '20' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Showing the last loaded trades.'))
  expect(screen.getByTitle('Saved snapshot')).toBeTruthy()
  expect(screen.getByText('1 trade')).toBeTruthy()
  expect(screen.queryByTitle('Replacement snapshot')).toBeNull()
  down = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByTitle('Later trade')
  expect(screen.getByText('2 trades')).toBeTruthy()
  expect(screen.queryByTitle('Saved snapshot')).toBeNull()
})
