import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import UpDipPanel from '../src/components/updown/UpDipPanel.jsx'

const api = vi.hoisted(() => ({ body: null }))
vi.mock('../src/utils/apiClient', () => ({ apiGet: async () => ({ data: api.body }) }))
vi.mock('../src/hooks/useRealtimeRefresh', () => ({ default: () => {} }))

afterEach(cleanup)

const AT = Date.parse('2026-11-23T18:55:00Z')
const contract = { floor: 59800, ceiling: 61800, expiryDate: '2026-11-28' }
const held = { contract: { floor: 60600, ceiling: 62600 }, contracts: 1, cost: 790.96, entryPrice: 62177.93, openedAt: AT - 7200000, pnl: -423 }
const body = (over = {}) => ({
  success: true,
  latest: {
    at: AT, features: { price: 61338 },
    decision: { action: 'HOLD', reasons: ['P&L -423.00'] },
    signal: { action: 'ENTER', size: 1, contract, reasons: ['1m turned up to the EMA'] },
  },
  position: held,
  lastEntrySignal: null,
  ...over,
})

it('headlines the market signal and labels the paper book decision separately', async () => {
  api.body = body()
  render(<UpDipPanel />)
  expect((await screen.findByTestId('up-dip-signal')).textContent).toContain('ENTER')
  expect(screen.getByTestId('up-dip-book').textContent).toContain('HOLD')
})

it('cautions on an ENTER signal while the paper book is holding', async () => {
  api.body = body()
  render(<UpDipPanel />)
  expect(await screen.findByText(/earlier paper entry is still open/i)).toBeTruthy()
})

it('shows the last ENTER signal once the window has closed', async () => {
  const b = body({ lastEntrySignal: { at: AT, btc: 61338, contract, bookHeld: true } })
  b.latest.signal = { action: 'STAND_ASIDE', reasons: ['no dip setup'] }
  api.body = b
  render(<UpDipPanel />)
  expect((await screen.findByTestId('up-dip-last-entry')).textContent).toContain('61,338')
})

it('falls back to the book decision when the gateway predates the signal field', async () => {
  const b = body()
  delete b.latest.signal
  delete b.lastEntrySignal
  api.body = b
  render(<UpDipPanel />)
  expect((await screen.findByTestId('up-dip-signal')).textContent).toContain('HOLD')
})

it('shows why the paper book is not taking a signal during its cooldown', async () => {
  const b = body({ position: null })
  b.latest.decision = { action: 'STAND_ASIDE', reasons: ['cooling down after exit (30 min)'] }
  api.body = b
  render(<UpDipPanel />)
  expect((await screen.findByTestId('up-dip-book')).textContent).toContain('cooling down')
})
