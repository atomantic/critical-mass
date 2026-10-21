import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import BTCPriceChart from '../src/components/charts/BTCPriceChart'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const now = Math.floor(Date.now() / 1000)
const okBody = { candles: { '1m': Array.from({ length: 5 }, (_, i) => ({ time: now - (5 - i) * 60, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 1 })) } }

describe('BTCPriceChart candle history failure', () => {
  it('shows an error with Retry on a 503, and recovers on retry', async () => {
    let healthy = false
    vi.stubGlobal('fetch', vi.fn(async () => healthy
      ? { ok: true, json: async () => okBody }
      : { ok: false, status: 503, json: async () => ({}) }))
    render(<BTCPriceChart exchange="coinbase" defaultInterval="1m" />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByText(/Waiting for price data/)).toBeNull()
    healthy = true
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('shows the error on a rejected fetch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    render(<BTCPriceChart exchange="coinbase" defaultInterval="1m" />)
    expect((await screen.findByRole('alert')).textContent).toContain('network down')
  })
})
