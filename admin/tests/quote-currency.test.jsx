import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ConfigEditor from '../src/components/ConfigEditor'
import CostBasisRegime from '../src/components/CostBasisRegime'
import Overview from '../src/components/Overview'
import RiskLimitsPanel from '../src/components/regime/RiskLimitsPanel'
import LadderPanel from '../src/components/regime/LadderPanel'

vi.mock('../src/components/Toast', () => ({ useToast: () => ({ addToast: vi.fn() }) }))
vi.mock('../src/hooks/useTradeEvents', () => ({ useMultiRegimeStatuses: () => ({ statuses: {}, connected: false }) }))
vi.mock('../src/components/celestial/CelestialVisualization', () => ({ default: () => <div /> }))
vi.mock('../src/lib/router', () => ({ Link: ({ children }) => <div>{children}</div>, useNavigate: () => vi.fn() }))

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it.each([['BTCUSD', 'USD'], ['BTC-USDC', 'USDC'], ['BTC_USDT', 'USDT']])('labels %s using its quote currency', async (pair, quote) => {
  vi.stubGlobal('fetch', vi.fn(async url => ({ ok: true, json: async () => {
    if (url.includes('preview-ladder')) return { success: true, preview: { levels: [{ price: 100, sizeUsdc: 10, assetQty: 0.1, distancePct: 1 }], levelCount: 1 } }
    if (url.includes('/config')) return { config: { productId: pair } }
    if (url.includes('/status')) return { status: { position: {} } }
    if (url.includes('/fills')) return { fills: [] }
    return {}
  } })))
  const config = render(<ConfigEditor config={{ productId: pair, regime: { enabled: true, entryMode: 'ladder' } }} strategy="regime" />)
  expect(screen.getByText(`Base Size (${quote})`)).toBeTruthy()
  expect(screen.getByText(`Max Deployed (${quote})`)).toBeTruthy()
  expect(config.container.textContent).toContain(`across all available ${quote}`)
  config.unmount()
  const cost = render(<CostBasisRegime exchange="gemini" pair={pair} />)
  expect(await screen.findByText(`${quote} Profit:`)).toBeTruthy()
  expect(cost.container.textContent).toContain(`${quote} profit from completed cycles`)
  cost.unmount()
  const risk = render(<RiskLimitsPanel quoteCurrency={quote} risk={{}} position={{}} config={{}} asset="BTC" />)
  expect(screen.getByText(quote, { exact: true })).toBeTruthy()
  risk.unmount()
  render(<LadderPanel quoteCurrency={quote} config={{}} status={{ isRunning: true, config: { entryMode: 'ladder' } }} exchange="gemini" pairQuery={`?pair=${pair}`} />)
  fireEvent.click(screen.getByRole('button', { name: 'Rebuild Ladder' }))
  expect(await screen.findByRole('columnheader', { name: `Size (${quote})` })).toBeTruthy()
})

it('keeps mixed-fund overview quote totals and card suffixes distinct', async () => {
  const exchanges = ['BTCUSD', 'BTC-USDC', 'BTC_USDT'].map(pair => ({ name: 'gemini', pair, productId: pair }))
  vi.stubGlobal('fetch', vi.fn(async url => ({ ok: true, json: async () => url === '/api/exchanges'
    ? { exchanges }
    : { status: { position: { realizedPnL: 12, totalCostBasis: 100 }, market: { lastPrice: 100 }, apy: { estimatedDailyUsdc: 2, estimatedApy: 5 }, isRunning: true } }
  })))
  render(<Overview />)
  await screen.findAllByText('$12.00 USDT')
  for (const quote of ['USD', 'USDC', 'USDT']) {
    expect(screen.getAllByText(`$12.00 ${quote}`).length).toBe(2)
    expect(screen.getAllByText(`$2.00 ${quote}`).length).toBe(1)
    expect(screen.getAllByText(`$730.00 ${quote}`).length).toBe(2)
  }
})
