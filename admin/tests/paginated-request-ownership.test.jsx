import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithToasts as render } from './renderWithToasts'
import SentinelDashboard from '../src/components/sentinel/Dashboard'
import TradeHistory from '../src/components/updown/TradeHistory'

vi.mock('../src/hooks/useSentinelSocket', () => ({ default: () => ({ connected: true }) }))
HTMLDialogElement.prototype.showModal = function () { this.open = true }
HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')) }
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const ok = data => ({ ok: true, status: 200, json: async () => data })
const alert = (id, title) => ({ id, title, severity: 'critical' })
const trade = (id, note) => ({ id, note, date: '2026-10-22', cost: 10, returnAmount: 20 })
const page = (items, total = items.length) => ({ success: true, items, total, summary: { count: total, wins: total, totalCost: total * 10, totalReturn: total * 20 } })
function heldPage() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function release(held, response) { await act(async () => { held.resolve(response); await held.promise }) }

it.each(['success', 'failure'])('keeps the completed Critical selection when an obsolete All page returns %s despite abort', async outcome => {
  const held = heldPage()
  let firstSignal, laterSignal
  vi.stubGlobal('fetch', vi.fn((url, options) => {
    if (url.includes('/status')) return Promise.resolve(ok({ config: { feeds: [] } }))
    if (url.includes('offset=')) { laterSignal = options.signal; return held.promise }
    if (url.includes('severity=')) return Promise.resolve(ok(page([alert(3, 'Current critical')])))
    firstSignal = options.signal
    return Promise.resolve(ok(page([alert(1, 'Old first')], 3)))
  }))
  render(<SentinelDashboard />)
  await waitFor(() => expect(laterSignal).toBeTruthy())
  expect(laterSignal).toBe(firstSignal)
  fireEvent.change(screen.getByLabelText('Alert filter'), { target: { value: 'critical' } })
  await screen.findByText('Current critical')
  expect(laterSignal.aborted).toBe(true)
  await release(held, outcome === 'success' ? ok(page([alert(2, 'Old last')])) : { ok: false, status: 500, json: async () => ({}) })
  expect(screen.getByText('Current critical')).toBeTruthy()
  expect(screen.queryByText('Loading...')).toBeNull()
  expect(screen.queryByText('Could not load alerts.')).toBeNull()
  expect(fetch.mock.calls.filter(([url]) => url.includes('offset='))).toHaveLength(1)
})

it('keeps a post-save list and summary when the old mount page ignores abort', async () => {
  const held = heldPage()
  let reads = 0, signal
  vi.stubGlobal('fetch', vi.fn((url, options) => {
    if (options?.method === 'POST') return Promise.resolve(ok({ success: true }))
    if (url.includes('offset=')) { signal = options.signal; return held.promise }
    return Promise.resolve(ok(++reads === 1 ? page([trade(1, 'Old first')], 2) : page([trade(1, 'Old first'), trade(2, 'Old last'), trade(3, 'Saved trade')])))
  }))
  render(<TradeHistory />)
  await waitFor(() => expect(signal).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: /Add Trade/i }))
  fireEvent.change(screen.getByLabelText('Cost (Open)'), { target: { value: '10' } })
  fireEvent.change(screen.getByLabelText('Return (Close)'), { target: { value: '20' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByTitle('Saved trade')
  expect(signal.aborted).toBe(true)
  await release(held, ok(page([trade(2, 'Old last')])))
  expect(screen.getByTitle('Saved trade')).toBeTruthy()
  expect(screen.getByText('3 trades')).toBeTruthy()
  expect(screen.queryByText('Loading trades...')).toBeNull()
})

it.each([['alerts', SentinelDashboard], ['trades', TradeHistory]])('aborts the entire %s walk on unmount and consumes an abort rejection', async (kind, Component) => {
  const held = heldPage()
  let signal
  vi.stubGlobal('fetch', vi.fn((url, options) => {
    if (url.includes('/status')) return Promise.resolve(ok({ config: { feeds: [] } }))
    if (url.includes('offset=')) { signal = options.signal; return held.promise }
    return Promise.resolve(ok(page([kind === 'alerts' ? alert(1, 'Old') : trade(1, 'Old')], 3)))
  }))
  const mounted = render(<Component />)
  await waitFor(() => expect(signal).toBeTruthy())
  mounted.unmount()
  expect(signal.aborted).toBe(true)
  await act(async () => { held.reject(new DOMException('Aborted', 'AbortError')); await Promise.resolve() })
  expect(fetch.mock.calls.filter(([url]) => url.includes('offset='))).toHaveLength(1)
})

it('clearing alerts invalidates a later page of a refresh even when it ignores abort', async () => {
  const held = heldPage()
  let reads = 0, signal
  vi.stubGlobal('fetch', vi.fn((url, options) => {
    if (options?.method && options.method !== 'GET') return Promise.resolve(ok({ success: true }))
    if (url.includes('/status')) return Promise.resolve(ok({ config: { feeds: [] } }))
    if (url.includes('offset=')) { signal = options.signal; return held.promise }
    return Promise.resolve(ok(page([alert(1, 'Visible alert')], ++reads === 2 ? 2 : 1)))
  }))
  render(<SentinelDashboard />)
  await screen.findByText('Visible alert')
  fireEvent.click(screen.getByRole('button', { name: 'Force Poll' }))
  await waitFor(() => expect(signal).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Clear all alerts' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Clear alerts' }))
  await screen.findByText(/No alerts yet/)
  expect(signal.aborted).toBe(true)
  await release(held, ok(page([alert(2, 'Obsolete alert')])))
  expect(screen.queryByText('Visible alert')).toBeNull()
  expect(screen.queryByText('Obsolete alert')).toBeNull()
  expect(screen.getByText(/No alerts yet/)).toBeTruthy()
})

it('unmount aborts a held post-delete refresh as well as initial reads', async () => {
  const held = heldPage()
  let reads = 0, signal
  const existing = trade(1, 'Existing trade')
  vi.stubGlobal('fetch', vi.fn((url, options) => {
    if (options?.method && options.method !== 'GET') return Promise.resolve(ok({ success: true }))
    if (url.includes('offset=')) { signal = options.signal; return held.promise }
    reads += 1
    return Promise.resolve(ok(reads === 1 ? page([existing]) : reads === 2 ? page([existing], 2) : page([])))
  }))
  render(<TradeHistory />)
  await screen.findByTitle('Existing trade')
  fireEvent.click(screen.getByRole('button', { name: /Delete trade from/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Delete trade' }))
  await waitFor(() => expect(signal).toBeTruthy())
  // Unmount must also revoke post-action refreshes, not just initial reads.
  cleanup()
  expect(signal.aborted).toBe(true)
  await release(held, ok(page([trade(2, 'Obsolete trade')])))
  expect(document.body.textContent).not.toContain('Obsolete trade')
})

it('an obsolete page cannot clear a newer trade read error or finish its loading state', async () => {
  const held = heldPage()
  let reads = 0, signal
  vi.stubGlobal('fetch', vi.fn((url, options) => {
    if (options?.method === 'POST') return Promise.resolve(ok({ success: true }))
    if (url.includes('offset=')) { signal = options.signal; return held.promise }
    return Promise.resolve(ok(++reads === 1 ? page([trade(1, 'Stale trade')], 2) : { success: false, error: 'Current read failed' }))
  }))
  render(<TradeHistory />)
  await waitFor(() => expect(signal).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: /Add Trade/i }))
  fireEvent.change(screen.getByLabelText('Cost (Open)'), { target: { value: '10' } })
  fireEvent.change(screen.getByLabelText('Return (Close)'), { target: { value: '20' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByText('Current read failed')
  await release(held, ok(page([trade(2, 'Stale last')])) )
  expect(screen.getByText('Current read failed')).toBeTruthy()
  expect(screen.queryByTitle('Stale trade')).toBeNull()
  expect(screen.queryByText('2 trades')).toBeNull()
})
