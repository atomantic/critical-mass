import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import UpDipHeld from '../src/components/updown/UpDipHeld.jsx'

const api = vi.hoisted(() => ({ put: vi.fn(), del: vi.fn() }))
vi.mock('../src/utils/apiClient', () => ({
  apiPut: api.put, apiDelete: api.del,
  describeMutationFailure: (res, fallback) => res.data?.error || fallback,
}))
afterEach(() => { cleanup(); vi.clearAllMocks() })

const held = { contract: { floor: 59800, ceiling: 61800, expiryDate: '2026-11-28' }, contracts: 1, cost: 751.99, entryPrice: 61300, pnl: 33.52,
  decision: { action: 'EXIT', reasons: ['up 4.46% of cost after fees'] } }

it('saves a fill with the ceiling derived from the range', async () => {
  api.put.mockResolvedValue({ ok: true, data: { success: true } })
  const onChange = vi.fn()
  render(<UpDipHeld held={null} onChange={onChange} />)
  fireEvent.change(screen.getByLabelText(/floor/i), { target: { value: '59800' } })
  fireEvent.change(screen.getByLabelText(/contracts/i), { target: { value: '1' } })
  fireEvent.change(screen.getByLabelText(/total cost/i), { target: { value: '751.99' } })
  fireEvent.click(screen.getByRole('button', { name: /track/i }))
  await waitFor(() => expect(onChange).toHaveBeenCalled())
  expect(api.put).toHaveBeenCalledWith('/api/updown/up-dip/held', { floor: 59800, ceiling: 61800, contracts: 1, cost: 751.99 })
})

it('shows the server reason when a fill is rejected', async () => {
  api.put.mockResolvedValue({ ok: false, data: { error: 'contracts must be a whole number of at least 1' } })
  render(<UpDipHeld held={null} onChange={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: /track/i }))
  expect((await screen.findByRole('alert')).textContent).toContain('contracts must be')
})

it('shows the exit call on the operator contract and clears it', async () => {
  api.del.mockResolvedValue({ ok: true, data: { success: true } })
  const onChange = vi.fn()
  render(<UpDipHeld held={held} onChange={onChange} />)
  expect(screen.getByTestId('up-dip-held').textContent).toContain('EXIT')
  expect(screen.getByTestId('up-dip-held').textContent).toContain('33.52')
  fireEvent.click(screen.getByRole('button', { name: /clear/i }))
  await waitFor(() => expect(onChange).toHaveBeenCalled())
  expect(api.del).toHaveBeenCalledWith('/api/updown/up-dip/held')
})

it('shows no P&L while candles are stale', () => {
  render(<UpDipHeld held={{ ...held, pnl: null, decision: { action: 'STALE', reasons: ['no fresh candles'] } }} onChange={() => {}} />)
  expect(screen.getByTestId('up-dip-held').textContent).toContain('---')
})
