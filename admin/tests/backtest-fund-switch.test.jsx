import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import Backtest from '../src/components/Backtest'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const fund = (productId, holdbackPercent) => ({
  config: { productId, holdbackPercent, totalAllocation: 1000 },
})

it('loads and submits zero holdback', () => {
  const fetch = vi.fn(() => new Promise(() => {}))
  vi.stubGlobal('fetch', fetch)
  render(<Backtest exchange="coinbase" pair="BTC-USDC" summary={fund('BTC-USDC', 0)} />)

  expect(screen.getByLabelText('Holdback (%)').value).toBe('0')
  fireEvent.click(screen.getByRole('button', { name: 'Run Backtest' }))
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ holdbackPercent: 0 })
})

it('aborts the old fund and ignores its late response while the new fund runs', async () => {
  const pending = []
  const fetch = vi.fn((_url, { signal }) => new Promise(resolve => pending.push({ signal, resolve })))
  vi.stubGlobal('fetch', fetch)
  const { rerender, unmount } = render(
    <Backtest exchange="coinbase" pair="BTC-USDC" summary={fund('BTC-USDC', 5)} />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Run Backtest' }))
  expect(pending[0].signal.aborted).toBe(false)

  rerender(<Backtest exchange="coinbase" pair="ETH-USDC" summary={fund('ETH-USDC', 2)} />)
  expect(pending[0].signal.aborted).toBe(true)
  const run = screen.getByRole('button', { name: 'Run Backtest' })
  expect(run.disabled).toBe(false)
  fireEvent.click(run)
  expect(fetch.mock.calls[1][0]).toBe('/api/coinbase/backtest/run?pair=ETH-USDC')
  expect(JSON.parse(fetch.mock.calls[1][1].body).productId).toBe('ETH-USDC')

  await act(async () => {
    pending[0].resolve({ ok: false, status: 400, json: async () => ({ error: 'Old fund failure' }) })
  })
  expect(screen.queryByText(/Old fund failure/)).toBeNull()
  expect(screen.getByRole('button', { name: 'Running Backtest...' }).disabled).toBe(true)

  unmount()
  expect(pending[1].signal.aborted).toBe(true)
})
