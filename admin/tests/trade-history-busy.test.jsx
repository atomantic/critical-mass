import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithToasts as render } from './renderWithToasts'
import TradeHistory from '../src/components/updown/TradeHistory'

// Replaces the 'binds every form and row control to mutation busy state'
// source-text test in tests/updown-trade-actions.test.js.
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const ok = data => ({ ok: true, status: 200, json: async () => data })
const trade = { id: 7, date: '2026-09-09', cost: 500, returnAmount: 650, note: 'test', direction: 'up' }

it('every form and row control is disabled while a trade mutation is pending, and re-enabled afterwards', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => options.method === 'POST'
    ? gate
    : ok({ success: true, items: [trade], total: 1, summary: { count: 1, wins: 1 } })))
  const { container } = render(<TradeHistory />)
  await screen.findByRole('button', { name: /Edit trade/ })
  fireEvent.click(screen.getByRole('button', { name: /Add Trade/ }))
  fireEvent.change(screen.getByLabelText('Cost (Open)'), { target: { value: '10' } })
  fireEvent.change(screen.getByLabelText('Return (Close)'), { target: { value: '20' } })
  const controls = () => [...container.querySelectorAll('button, input, select, textarea')]
  expect(controls().some(c => !c.disabled)).toBe(true)

  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(controls().every(c => c.disabled)).toBe(true))
  expect(controls().length).toBeGreaterThan(8)

  await act(async () => release(ok({ success: true })))
  await waitFor(() => expect(controls().some(c => !c.disabled)).toBe(true))
})
