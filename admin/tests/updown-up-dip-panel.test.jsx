import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import UpDipPanel from '../src/components/updown/UpDipPanel.jsx'

const api = vi.hoisted(() => ({ body: null }))
vi.mock('../src/utils/apiClient', () => ({ apiGet: async () => ({ data: api.body }) }))
vi.mock('../src/hooks/useRealtimeRefresh', () => ({ default: () => {} }))
vi.mock('../src/components/updown/AppQuoteForm', () => ({ default: () => <div data-testid="quote-form" /> }))

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

it('keeps held-contract controls visible when the paper books are collapsed', async () => {
  api.body = body({ held: null })
  render(<UpDipPanel />)
  const controls = await screen.findByText('Your contract')
  expect(controls.closest('details')).toBeNull()
  const paper = screen.getByTestId('up-dip-signal').closest('details')
  expect(paper.open).toBe(false)
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

describe('real costs', () => {
  const HOUR = 3_600_000
  const quotes = (over = {}) => ({
    spread: { 2000: { value: 49, source: 'quote', capturedAt: AT, ageMs: 3 * HOUR }, 500: { value: 0, source: 'default', capturedAt: null, ageMs: null } },
    listingSeen: true, last: { range: 2000, up: 61172, floor: 60200 }, lastRecorded: null, comparison: { coinbase: { n: 3 }, index: { n: 1 } }, ...over,
  })
  const show = async (over) => { api.body = body(over); const view = render(<UpDipPanel />); await screen.findByTestId('up-dip-signal'); return view }
  const costs = () => screen.getByTestId('up-dip-costs').textContent

  it('names the spread in force, its age and what a round trip costs', async () => {
    await show({ quotes: quotes() })
    expect(costs()).toContain('Spread $49 a side (your quote, 3h old)')
    expect(costs()).toContain('Round trip $52.98 a contract (10.9% of cost)')
    expect(screen.getByTestId('quote-form')).toBeTruthy()
  })

  it('says when the default spread applies', async () => {
    await show({ quotes: quotes({ spread: { 2000: { value: 35, source: 'default', capturedAt: null, ageMs: null }, 500: { value: 0 } }, last: null }) })
    expect(costs()).toContain('Spread $35 a side (default: no quote in 24h)')
    expect(costs()).toContain('Round trip $38.98 a contract')
    expect(costs()).not.toContain('% of cost')
    cleanup()
    await show({ quotes: quotes({ spread: { 2000: { value: 35, source: 'default', capturedAt: null, ageMs: null }, 500: { value: 0 } } }) })
    expect(costs()).toContain('Round trip $38.98 a contract (8.0% of cost)')
  })

  it('asks for a quote when no contract has been seen this week', async () => {
    await show({ quotes: quotes({ listingSeen: false }) })
    expect(costs()).toContain('No contract seen this week: record a quote to paper-trade')
    cleanup()
    await show({ quotes: quotes() })
    expect(costs()).not.toContain('No contract seen')
  })

  it('compares the app price with both sources only from ten quotes', async () => {
    await show({ quotes: quotes() })
    expect(costs()).toContain('Coinbase not enough yet (3/10)')
    expect(costs()).toContain('Crypto.com index not enough yet (1/10)')
    cleanup()
    await show({ quotes: quotes({ comparison: { coinbase: { n: 12, median: -4.31, p90: 10.2 }, index: { n: 12, median: 6, p90: 22 } } }) })
    expect(costs()).toContain('Coinbase -$4.31, 90% within $10.20')
    expect(costs()).toContain('Crypto.com index +$6.00, 90% within $22.00')
    expect(costs()).toContain('late uploads are noisy')
  })

  it('always says the rule lost money after costs', async () => {
    await show()
    expect(screen.getByText(/lost money out of sample after costs/i)).toBeTruthy()
  })

  it('states the backtest spread and floors', async () => {
    const backtest = { split: '2026-05-01', train: null, test: null }
    await show({ backtest: { ...backtest, spread: 35, listing: 'legacy' } })
    expect(screen.getByText(/spread \$35 a side, any \$100 floor/)).toBeTruthy()
    cleanup()
    await show({ backtest: { ...backtest, spread: 35, listing: 'grid' } })
    expect(screen.getByText(/spread \$35 a side, listed floors only/)).toBeTruthy()
    cleanup()
    await show({ backtest: { ...backtest, spread: null, listing: null } })
    expect(screen.getByText(/no spread/)).toBeTruthy()
    cleanup()
    await show({ backtest: { ...backtest, spread: 0, listing: 'legacy' } })
    expect(screen.getByText(/no spread/)).toBeTruthy()
  })

  it('shows the archived book with its open loss', async () => {
    await show({ archived: { pricing: null, closedCycles: 14, pnl: 714.55, openPosition: { pnl: -527.53 } } })
    expect(screen.getByTestId('up-dip-archived').textContent).toBe('Previous book (no spread): 14 closed, +$714.55, open -$527.53 at archive')
    cleanup()
    await show({ archived: { pricing: { spread: true }, closedCycles: 2, pnl: -10, openPosition: null } })
    expect(screen.getByTestId('up-dip-archived').textContent).toBe('Previous book: 2 closed, -$10.00')
    cleanup()
    await show({ archived: { pricing: null, closedCycles: 1, pnl: 5, openPosition: { pnl: null } } })
    expect(screen.getByTestId('up-dip-archived').textContent).toContain('open position unpriced')
    cleanup()
    await show({ archived: { unreadable: true } })
    expect(screen.getByTestId('up-dip-archived').textContent).toContain('could not be read')
  })

  it('shows the shadow book archive too', async () => {
    await show({ shadow: { summary: null, archived: { pricing: null, closedCycles: 3, pnl: -12, openPosition: null } } })
    expect(screen.getByTestId('up-dip-archived').textContent).toContain('3 closed, -$12.00')
  })

  it('marks a knock-out that was assumed', async () => {
    await show({ cycles: [{ openedAt: AT, closedAt: AT + 1, reason: 'knock_out_floor', entryBtc: 1, exitBtc: 2, pnl: -700, coinbaseTouched: null, uncertain: true }] })
    expect(screen.getByText(/KO floor · assumed/)).toBeTruthy()
  })

  it('says a frozen book position stopped being tracked, without the holding caution', async () => {
    await show({ needsReset: true, frozenAt: AT, position: held })
    expect(screen.getByText(/paper position · frozen/i)).toBeTruthy()
    expect(screen.queryByText(/earlier paper entry is still open/i)).toBeNull()
  })

  it('says when a book needs a reset, and which', async () => {
    await show({ needsReset: true, shadow: { needsReset: true, summary: null } })
    expect(screen.getByText(/needs reset: run scripts\/reset-up-dip-paper\.js$/i)).toBeTruthy()
    expect(screen.getByText(/reset-up-dip-paper\.js --book shadow/i)).toBeTruthy()
  })

  it('says when it is waiting for index data', async () => {
    await show({ candles: { ready: false, waitingFor: null } })
    expect(screen.getByText(/waiting for candle history/i)).toBeTruthy()
    cleanup()
    await show({ candles: { ready: true, waitingFor: AT } })
    expect(screen.getByText(/waiting for index data/i)).toBeTruthy()
    cleanup()
    await show({ candles: { ready: true, waitingFor: null } })
    expect(screen.queryByText(/waiting for/i)).toBeNull()
  })

  it('marks a knock-out only the index saw', async () => {
    const cycle = (over) => ({ openedAt: AT, closedAt: AT + 1, reason: 'knock_out_floor', entryBtc: 1, exitBtc: 2, pnl: -700, ...over })
    await show({ cycles: [cycle({ coinbaseTouched: false })] })
    expect(screen.getByText(/KO floor · index only/)).toBeTruthy()
    cleanup()
    await show({ cycles: [cycle({ coinbaseTouched: true })] })
    expect(screen.queryByText(/index only/)).toBeNull()
  })

  it('works with a gateway that sends none of this', async () => {
    await show()
    expect(screen.queryByTestId('up-dip-costs')).toBeNull()
    expect(screen.queryByTestId('up-dip-archived')).toBeNull()
  })
})
