import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Overview from '../src/components/Overview'
import { nextRegimeStatusSeq, STATUS_STALE_MS } from '../src/utils/regimeStatusSnapshot.mjs'

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

describe('Overview status freshness and silent engine expiration', () => {
  it('expires silent running fund within STATUS_STALE_MS and probes status', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fetch.mockImplementation(async (url) => {
      if (url === '/api/exchanges') return { ok: true, json: async () => ({ exchanges: exchangeList }) }
      if (url.includes('/coinbase/')) return { ok: true, json: async () => ({ status: status(100, 7) }) }
      if (url.includes('/gemini/')) return { ok: true, json: async () => ({ status: status(900, 90) }) }
      return { ok: true, json: async () => ({}) }
    })

    render(<Overview />)
    await screen.findByText('$1,000.00')
    const runningBadges = screen.getAllByText('Running')
    expect(runningBadges.length).toBe(2)

    const geminiProbeCalls = () => fetch.mock.calls.filter(([url]) => url.includes('/gemini/regime/status')).length
    const initialGeminiCalls = geminiProbeCalls()

    // Advance to just before STATUS_STALE_MS
    await act(async () => { vi.advanceTimersByTime(STATUS_STALE_MS - 1000) })
    expect(screen.getAllByText('Running').length).toBe(2)
    expect(geminiProbeCalls()).toBe(initialGeminiCalls)

    // Advance past STATUS_STALE_MS
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(geminiProbeCalls()).toBeGreaterThan(initialGeminiCalls)
  })

  it('handles offline success: removes running indication and shows Stopped without error', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let geminiCalls = 0
    fetch.mockImplementation(async (url) => {
      if (url === '/api/exchanges') return { ok: true, json: async () => ({ exchanges: exchangeList }) }
      if (url.includes('/coinbase/')) return { ok: true, json: async () => ({ status: status(100, 7) }) }
      if (url.includes('/gemini/')) {
        geminiCalls++
        if (geminiCalls > 1) {
          // Probe returns stopped status
          return {
            ok: true,
            json: async () => ({
              status: {
                isRunning: false,
                position: { totalAsset: 1, totalCostBasis: 900, realizedPnL: 90 },
                market: { lastPrice: 10 },
                apy: { deployedInPosition: 900, estimatedApy: 0, availableCapital: 0 },
                health: { mode: 'STOPPED' },
              },
            }),
          }
        }
        return { ok: true, json: async () => ({ status: status(900, 90) }) }
      }
      return { ok: true, json: async () => ({}) }
    })

    render(<Overview />)
    await screen.findByText('$1,000.00')
    expect(screen.getAllByText('Running').length).toBe(2)

    await act(async () => { vi.advanceTimersByTime(STATUS_STALE_MS) })
    await waitFor(() => expect(screen.getAllByText('Running').length).toBe(1))
    expect(screen.getByText('Stopped')).toBeTruthy()
    expect(screen.queryByText('Status probe failed')).toBeNull()
  })

  it('handles probe failure: retains last financial values with stale label, excludes from totals, and retries inline', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let geminiCalls = 0
    fetch.mockImplementation(async (url) => {
      if (url === '/api/exchanges') return { ok: true, json: async () => ({ exchanges: exchangeList }) }
      if (url.includes('/coinbase/')) return { ok: true, json: async () => ({ status: status(100, 7) }) }
      if (url.includes('/gemini/')) {
        geminiCalls++
        if (geminiCalls > 1 && fetch.geminiFails) {
          return { ok: false, status: 504, json: async () => ({ error: 'Gateway timeout' }) }
        }
        return { ok: true, json: async () => ({ status: status(900, 90) }) }
      }
      return { ok: true, json: async () => ({}) }
    })
    fetch.geminiFails = true

    render(<Overview />)
    await screen.findByText('$1,000.00')
    expect(screen.getAllByText('Running').length).toBe(2)

    // Trigger silence and failed probe
    await act(async () => { vi.advanceTimersByTime(STATUS_STALE_MS) })
    expect(await screen.findByText('Status stale')).toBeTruthy()
    expect(screen.getByText('Status probe failed')).toBeTruthy()

    // Gemini last financial data is retained
    expect(screen.getByText('$900.00 cost')).toBeTruthy()

    // Excluded from totals
    expect(screen.getByText('1 fund unavailable; excluded from totals.')).toBeTruthy()
    const capital = screen.getByText('Capital').parentElement
    expect(within(capital).getByText('$100.00')).toBeTruthy()
    expect(within(capital).queryByText('$1,000.00')).toBeNull()

    // Retry inline
    fetch.geminiFails = false
    const geminiCard = screen.getByText('Status probe failed').closest('.bg-gray-800')
    fireEvent.click(within(geminiCard).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByText('Status stale')).toBeNull())
    expect(screen.queryByText('Status probe failed')).toBeNull()
    expect(within(capital).getByText('$1,000.00')).toBeTruthy()
  })

  it('two funds age independently; one active fund does not refresh another silent fund', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let geminiProbeCalled = false
    fetch.mockImplementation(async (url) => {
      if (url === '/api/exchanges') return { ok: true, json: async () => ({ exchanges: exchangeList }) }
      if (url.includes('/coinbase/')) return { ok: true, json: async () => ({ status: status(100, 7) }) }
      if (url.includes('/gemini/')) {
        if (geminiProbeCalled) {
          return { ok: false, status: 503, json: async () => ({}) }
        }
        return { ok: true, json: async () => ({ status: status(900, 90) }) }
      }
      return { ok: true, json: async () => ({}) }
    })

    const { rerender } = render(<Overview />)
    await screen.findByText('$1,000.00')
    expect(screen.getAllByText('Running').length).toBe(2)

    // At 15s, coinbase emits a fresh status via socket
    await act(async () => { vi.advanceTimersByTime(15000) })
    fixture.statuses = { 'coinbase::BTC-USDC': status(105, 8) }
    rerender(<Overview />)

    // At 30s, gemini has had 30s of silence, while coinbase only had 15s
    geminiProbeCalled = true
    await act(async () => { vi.advanceTimersByTime(15000) })

    // Gemini expired and probed (probe failed -> stale)
    expect(await screen.findByText('Status stale')).toBeTruthy()

    // Coinbase is still running and healthy
    expect(screen.getAllByText('Running').length).toBe(1)
  })

  it('does not treat another fund update as fresh evidence for a cached silent fund', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let geminiReads = 0
    fetch.mockImplementation(async (url) => {
      if (url === '/api/exchanges') return { ok: true, json: async () => ({ exchanges: exchangeList }) }
      if (url.includes('/coinbase/')) return { ok: true, json: async () => ({ status: status(100, 7) }) }
      if (url.includes('/gemini/')) {
        if (++geminiReads > 1) return { ok: false, status: 503, json: async () => ({}) }
        return { ok: true, json: async () => ({ status: status(900, 90) }) }
      }
      return { ok: true, json: async () => ({}) }
    })
    const { rerender } = render(<Overview />)
    await screen.findByText('$1,000.00')
    const silent = { status: status(900, 90), seq: nextRegimeStatusSeq() }
    fixture.snapshots = {
      'coinbase::BTC-USDC': { status: status(100, 7), seq: nextRegimeStatusSeq() },
      'gemini::ETH-USDC': silent,
    }
    rerender(<Overview />)
    await act(async () => { vi.advanceTimersByTime(15000) })
    fixture.snapshots = { ...fixture.snapshots, 'coinbase::BTC-USDC': { status: status(105, 8), seq: nextRegimeStatusSeq() } }
    rerender(<Overview />)
    await act(async () => { vi.advanceTimersByTime(15000) })
    expect(await screen.findByText('Status stale')).toBeTruthy()
    expect(geminiReads).toBe(2)
    fixture.snapshots = { ...fixture.snapshots, 'coinbase::BTC-USDC': { status: status(106, 8), seq: nextRegimeStatusSeq() } }
    rerender(<Overview />)
    expect(screen.getByText('Status stale')).toBeTruthy()
    expect(screen.getByText('1 fund unavailable; excluded from totals.')).toBeTruthy()
  })
})
