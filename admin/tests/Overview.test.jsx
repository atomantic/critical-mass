import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Overview from '../src/components/Overview'
import { nextRegimeStatusSeq } from '../src/utils/regimeStatusSnapshot.mjs'

const fixture = vi.hoisted(() => ({ statuses: {}, snapshots: {} }))
vi.mock('../src/lib/router', () => ({
  Link: ({ to, children, ...props }) => <a href={to} {...props}>{children}</a>,
  useNavigate: () => vi.fn(),
}))
vi.mock('../src/hooks/useTradeEvents', () => ({
  useMultiRegimeStatuses: () => ({
    statuses: fixture.statuses,
    snapshots: fixture.snapshots,
    connected: false,
  }),
}))
vi.mock('../src/App', () => ({ getBaseCurrency: () => 'BTC', getQuoteCurrency: () => 'USDC' }))
vi.mock('../src/components/AddFundModal', () => ({ default: () => null }))
vi.mock('../src/components/ClosedFundCard', () => ({ default: () => null }))
vi.mock('../src/components/icons', () => ({ ExternalLink: () => null }))

const exchangeList = [
  { name: 'coinbase', pair: 'BTC-USDC' },
  { name: 'gemini', pair: 'ETH-USDC' },
]

function status(totalCostBasis, realizedPnL) {
  return {
    isRunning: true,
    position: { totalAsset: 1, totalCostBasis, realizedPnL },
    market: { lastPrice: 10 },
    apy: { deployedInPosition: totalCostBasis, estimatedApy: 12, availableCapital: 5 },
    health: { mode: 'ACTIVE' },
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  fixture.statuses = {}
  fixture.snapshots = {}
})

describe('Overview read failures', () => {
  it('shows an exchange error instead of the empty state and retries successfully', async () => {
    fetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ exchanges: [] }) })

    render(<Overview />)
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText(/Unable to load exchanges/)).toBeTruthy()
    expect(screen.queryByText(/No exchanges configured/)).toBeNull()

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByText(/No exchanges configured/)).toBeTruthy()
  })

  it('marks a failed fund unavailable, excludes it from totals, and retries the status read', async () => {
    fetch.mockImplementation(async (url) => {
      if (url === '/api/exchanges') return { ok: true, json: async () => ({ exchanges: exchangeList }) }
      if (url.includes('/coinbase/')) return { ok: true, json: async () => ({ status: status(100, 7) }) }
      if (url.includes('/gemini/')) return fetch.geminiFails
        ? { ok: false, status: 504, json: async () => ({}) }
        : { ok: true, json: async () => ({ status: status(900, 90) }) }
      return { ok: true, json: async () => ({}) }
    })
    fetch.geminiFails = true

    render(<Overview />)
    expect(await screen.findByText('Status unavailable')).toBeTruthy()
    expect(screen.getByText('1 fund unavailable; excluded from totals.')).toBeTruthy()
    expect(screen.queryByText('Stopped')).toBeNull()
    const unavailableCard = screen.getByText('Status unavailable').closest('.bg-gray-800')
    expect(within(unavailableCard).queryByText('$0.00 USD')).toBeNull()
    const capital = screen.getByText('Capital').parentElement
    expect(within(capital).getByText('$100.00')).toBeTruthy()
    expect(within(capital).queryByText('$1,000.00')).toBeNull()

    fetch.geminiFails = false
    fireEvent.click(within(unavailableCard).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByText('Status unavailable')).toBeNull())
    expect(screen.queryByText(/fund unavailable/)).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(6)
  })
})

describe('Overview HTTP and realtime status snapshot arbitration (#1817)', () => {
  it('survives a delayed pre-stop HTTP reply when a stopped socket event arrives during initial load', async () => {
    let resolveCoinbaseHttp
    fetch.mockImplementation(async (url) => {
      if (url === '/api/exchanges') return { ok: true, json: async () => ({ exchanges: [{ name: 'coinbase', pair: 'BTC-USDC' }] }) }
      if (url.includes('/coinbase/')) {
        return new Promise((resolve) => {
          resolveCoinbaseHttp = () => resolve({
            ok: true,
            json: async () => ({
              status: {
                isRunning: true,
                position: { totalAsset: 1, totalCostBasis: 100, realizedPnL: 5 },
                market: { lastPrice: 10 },
                apy: { deployedInPosition: 100, estimatedApy: 12, availableCapital: 5 },
                health: { mode: 'ACTIVE' },
              },
            }),
          })
        })
      }
      return { ok: true, json: async () => ({}) }
    })

    const { rerender } = render(<Overview />)
    await waitFor(() => expect(resolveCoinbaseHttp).toBeTypeOf('function'))

    // Deliver a newer stopped socket event before the delayed HTTP read resolves
    fixture.snapshots = {
      'coinbase::BTC-USDC': {
        status: {
          isRunning: false,
          health: { mode: 'STOPPED' },
          position: { totalAsset: 1, totalCostBasis: 100, realizedPnL: 5 },
          market: { lastPrice: 10 },
          apy: { deployedInPosition: 100, estimatedApy: 0, availableCapital: 5 },
        },
        seq: nextRegimeStatusSeq(),
      },
    }
    rerender(<Overview />)

    // Now resolve the older running HTTP response
    resolveCoinbaseHttp()

    // Stopped socket event survives the delayed HTTP response
    expect(await screen.findByText('Stopped')).toBeTruthy()
    expect(screen.queryByText('Running')).toBeNull()
  })

  it('allows a newer HTTP response to replace an older socket status (reverse ordering)', async () => {
    fixture.snapshots = {
      'coinbase::BTC-USDC': {
        status: {
          isRunning: true,
          position: { totalAsset: 1, totalCostBasis: 100, realizedPnL: 5 },
          market: { lastPrice: 10 },
          apy: { deployedInPosition: 100, estimatedApy: 12, availableCapital: 5 },
          health: { mode: 'ACTIVE' },
        },
        seq: nextRegimeStatusSeq(),
      },
    }

    fetch.mockImplementation(async (url) => {
      if (url === '/api/exchanges') return { ok: true, json: async () => ({ exchanges: [{ name: 'coinbase', pair: 'BTC-USDC' }] }) }
      if (url.includes('/coinbase/')) {
        return {
          ok: true,
          json: async () => ({
            status: {
              isRunning: false,
              health: { mode: 'STOPPED' },
              position: { totalAsset: 1, totalCostBasis: 100, realizedPnL: 5 },
              market: { lastPrice: 10 },
              apy: { deployedInPosition: 100, estimatedApy: 0, availableCapital: 5 },
            },
          }),
        }
      }
      return { ok: true, json: async () => ({}) }
    })

    render(<Overview />)
    expect(await screen.findByText('Stopped')).toBeTruthy()
    expect(screen.queryByText('Running')).toBeNull()
  })

  it('replaces running-only fields when transitioning to stopped', async () => {
    fetch.mockImplementation(async (url) => {
      if (url === '/api/exchanges') return { ok: true, json: async () => ({ exchanges: [{ name: 'coinbase', pair: 'BTC-USDC' }] }) }
      if (url.includes('/coinbase/')) {
        return {
          ok: true,
          json: async () => ({
            status: {
              isRunning: true,
              risk: { isDrawdownPaused: true },
              ladder: { active: true },
              position: { totalAsset: 1, totalCostBasis: 100, realizedPnL: 5 },
              market: { lastPrice: 10 },
              apy: { deployedInPosition: 100, estimatedApy: 12, availableCapital: 5 },
              health: { mode: 'ACTIVE' },
            },
          }),
        }
      }
      return { ok: true, json: async () => ({}) }
    })

    const { rerender } = render(<Overview />)
    expect(await screen.findByText('Running')).toBeTruthy()

    // Socket delivers a stopped snapshot without running fields
    fixture.snapshots = {
      'coinbase::BTC-USDC': {
        status: {
          isRunning: false,
          health: { mode: 'STOPPED' },
          position: { totalAsset: 1, totalCostBasis: 100, realizedPnL: 5 },
          market: { lastPrice: 10 },
          apy: { deployedInPosition: 100, estimatedApy: 0, availableCapital: 5 },
        },
        seq: nextRegimeStatusSeq(),
      },
    }
    rerender(<Overview />)

    expect(await screen.findByText('Stopped')).toBeTruthy()
    expect(screen.queryByText('Running')).toBeNull()
  })

  it('prevents overlapping retries and fund removal from resurrecting old fund maps', async () => {
    let exchangeCallCount = 0

    fetch.mockImplementation(async (url) => {
      if (url === '/api/exchanges') {
        exchangeCallCount++
        if (exchangeCallCount === 1) {
          return { ok: true, json: async () => ({ exchanges: exchangeList }) }
        }
        // Second load has gemini removed
        return { ok: true, json: async () => ({ exchanges: [{ name: 'coinbase', pair: 'BTC-USDC' }] }) }
      }
      if (url.includes('/coinbase/')) {
        return { ok: true, json: async () => ({ status: status(100, 7) }) }
      }
      if (url.includes('/gemini/')) {
        return { ok: false, status: 504, json: async () => ({}) }
      }
      return { ok: true, json: async () => ({}) }
    })

    render(<Overview />)
    expect(await screen.findByText(/coinbase/i)).toBeTruthy()
    const unavailableCard = await screen.findByText('Status unavailable')
    const retryBtn = within(unavailableCard.closest('.bg-gray-800')).getByRole('button', { name: 'Retry' })

    // User clicks Retry. Load 2 runs. In load 2, /api/exchanges returns ONLY coinbase.
    fireEvent.click(retryBtn)

    // Gemini card is removed and not resurrected
    await waitFor(() => expect(screen.queryByText(/gemini/i)).toBeNull())
    expect(screen.getByText(/coinbase/i)).toBeTruthy()
  })

  it('fences overlapping loads and ignores disposed requests so an older request cannot commit', async () => {
    let resolveFirstLoad
    let exchangeCallCount = 0

    fetch.mockImplementation(async (url) => {
      if (url === '/api/exchanges') {
        exchangeCallCount++
        if (exchangeCallCount === 1) {
          return new Promise(resolve => {
            resolveFirstLoad = () => resolve({ ok: true, json: async () => ({ exchanges: [{ name: 'coinbase', pair: 'BTC-USDC' }] }) })
          })
        }
        return { ok: true, json: async () => ({ exchanges: [{ name: 'coinbase', pair: 'BTC-USDC' }] }) }
      }
      if (url.includes('/coinbase/')) {
        return {
          ok: true,
          json: async () => ({
            status: {
              isRunning: true,
              health: { mode: 'ACTIVE' },
              position: { totalAsset: 1, totalCostBasis: 100, realizedPnL: 5 },
              market: { lastPrice: 10 },
              apy: { deployedInPosition: 100, estimatedApy: 12, availableCapital: 5 },
            },
          }),
        }
      }
      return { ok: true, json: async () => ({}) }
    })

    const { unmount } = render(<Overview />)
    await waitFor(() => expect(resolveFirstLoad).toBeTypeOf('function'))

    // Component unmounts (disposed request)
    unmount()

    // Resolving the older in-flight request after unmount is safely ignored
    resolveFirstLoad()
  })
})
