import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import ChartDataAlternative from '../src/components/charts/ChartDataAlternative'
import RegimePriceChart from '../src/components/charts/RegimePriceChart'
import RegimeTimeline from '../src/components/charts/RegimeTimeline'
import VolatilityChart from '../src/components/charts/VolatilityChart'

afterEach(cleanup)

it('formats just the open page and retains pagination across a collapsed update', () => {
  const formatRow = vi.fn(value => ({ value }))
  const makeTables = rows => vi.fn(() => [{ caption: 'Samples', columns: [{ key: 'value', label: 'Value' }], rows, formatRow }])
  const tables = makeTables(['One', 'Two', 'Three'])
  const { container, rerender } = render(<ChartDataAlternative getTables={tables} pageSize={1} />)
  const details = container.querySelector('details')
  const toggle = open => {
    details.open = open
    fireEvent(details, new Event('toggle'))
  }

  expect(tables).not.toHaveBeenCalled()
  expect(screen.queryByRole('table')).toBeNull()
  toggle(true)
  expect(screen.getByRole('rowheader', { name: 'One' })).toBeTruthy()
  expect(formatRow.mock.calls.map(([value]) => value)).toEqual(['One'])

  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  expect(screen.getByRole('rowheader', { name: 'Two' })).toBeTruthy()
  toggle(false)
  const latest = makeTables(['Four', 'Five', 'Six'])
  rerender(<ChartDataAlternative getTables={latest} pageSize={1} />)
  expect(latest).not.toHaveBeenCalled()

  toggle(true)
  expect(screen.getByRole('rowheader', { name: 'Five' })).toBeTruthy()
})

it('renders captioned accessible rows and paginates at 100 rows by default', () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({ time: `t${i}`, value: `$${i}` }))
  const columns = [{ key: 'time', label: 'Time' }, { key: 'value', label: 'Value (USD)' }]
  const { container } = render(<ChartDataAlternative getTables={() => [{ caption: 'Samples', columns, rows }]} />)
  const details = container.querySelector('details')
  details.open = true
  fireEvent(details, new Event('toggle'))

  expect(screen.getByRole('table', { name: 'Samples' })).toBeTruthy()
  expect(screen.getByRole('columnheader', { name: 'Value (USD)' }).getAttribute('scope')).toBe('col')
  expect(screen.getAllByRole('rowheader')).toHaveLength(100)
  expect(screen.getByText('Rows 1 to 100 of 250')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Previous' }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  expect(screen.getByText('Rows 101 to 200 of 250')).toBeTruthy()
})

it('exposes the chart samples, units and regime intervals after opening each disclosure', () => {
  const now = Date.now()
  const sample = (minutesAgo, price) => ({ timestamp: now - minutesAgo * 60_000, price })
  const priceData = [sample(2, 90), sample(4, 120), sample(10, 100), sample(6, null), sample(90, 1)]
  const atrData = [
    { ...sample(2), atr1m: 12, atr5m: 15, realizedVol: 0, volBaseline: 1.5 },
    { ...sample(4), atr1m: 10, atr5m: 14, realizedVol: 0.5, volBaseline: null },
  ]
  const regimes = [
    { timestamp: now - 30 * 60_000, mode: 'HARVEST' },
    { timestamp: now - 5 * 60_000, mode: 'TREND' },
  ]
  const { container } = render(<>
    <RegimePriceChart priceData={priceData} regimeData={regimes} />
    <VolatilityChart atrData={atrData} regimeData={regimes} />
    <RegimeTimeline data={regimes} />
  </>)
  expect(screen.queryByRole('table')).toBeNull()
  const [price, volatility, timeline] = container.querySelectorAll('details')
  for (const details of [price, volatility, timeline]) {
    details.open = true
    fireEvent(details, new Event('toggle'))
  }

  const samples = within(price).getByRole('table', { name: /Price samples from/ })
  expect(within(samples).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['$100.00', 'missing', '$120.00', '$90.00'])
  const volatilitySamples = within(volatility).getByRole('table', { name: /Volatility samples from/ })
  expect(within(volatilitySamples).getByRole('columnheader', { name: 'ATR 1m (USD)' })).toBeTruthy()
  expect(within(volatilitySamples).getByRole('columnheader', { name: 'Volatility baseline (%)' })).toBeTruthy()
  expect(within(volatilitySamples).getByRole('cell', { name: 'missing' })).toBeTruthy()
  expect(within(timeline).getByRole('columnheader', { name: 'Duration' })).toBeTruthy()
  expect(within(timeline).getByText(/Now \(/)).toBeTruthy()
})
