import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import SignalPanel from '../src/components/updown/SignalPanel'
import SignalBanner from '../src/components/updown/SignalBanner'

vi.mock('../src/utils/apiClient', () => ({ apiGet: async () => ({ data: { signals: [] } }) }))
afterEach(cleanup)

const signal = { type: 'SELL', action: 'HOLD', score: -14.8, confidence: 0.25, timestamp: 1 }

it('shows no score or strength from an old signal while there is no live one', async () => {
  render(<SignalPanel signal={signal} indicators={null} />)
  expect(screen.getByText('CALCULATING...')).toBeTruthy()
  expect(screen.queryByText(/composite score/i)).toBeNull()
  cleanup()
  render(<SignalBanner signal={signal} indicators={null} />)
  expect(screen.getByText('CALCULATING...')).toBeTruthy()
  expect(screen.queryByText(/strength/i)).toBeNull()
})

it('shows them once indicators are live', async () => {
  const indicators = { ...signal, timeframes: {} }
  render(<SignalPanel signal={signal} indicators={indicators} />)
  expect(screen.getByText('-14.8')).toBeTruthy()
  cleanup()
  render(<SignalBanner signal={signal} indicators={indicators} />)
  expect(screen.getByText('Strength 25%')).toBeTruthy()
})
