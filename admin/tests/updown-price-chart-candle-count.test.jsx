import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import PriceChart from '../src/components/updown/PriceChart'

const lastProps = vi.hoisted(() => ({ instances: [] }))

vi.mock('../src/components/charts/BTCPriceChart', () => ({
  default: (props) => {
    lastProps.instances.push(props)
    return (
      <div
        data-testid={`btc-price-chart-${props.defaultInterval}`}
        data-max-buckets-override={props.maxBucketsOverride ?? 'null'}
      >
        BTCPriceChart {props.defaultInterval} ({props.maxBucketsOverride ?? 'auto'})
      </div>
    )
  },
}))

afterEach(() => {
  cleanup()
  lastProps.instances = []
  vi.restoreAllMocks()
})

describe('PriceChart candle-count interaction', () => {
  it('controls maxBucketsOverride across mounted charts via Auto, 100, and 300 selectors', () => {
    render(
      <PriceChart
        tick={{ price: 65000, timestamp: 120_000 }}
        indicators={{ '1m': { score: 50 }, '5m': { score: 10 } }}
      />
    )

    const autoBtn = screen.getByRole('button', { name: 'Auto' })
    const btn100 = screen.getByRole('button', { name: '100' })
    const btn300 = screen.getByRole('button', { name: '300' })

    expect(autoBtn).toBeTruthy()
    expect(btn100).toBeTruthy()
    expect(btn300).toBeTruthy()

    // 1-minute chart should be rendered with default null (Auto) override
    const chart1m = screen.getByTestId('btc-price-chart-1m')
    expect(chart1m.getAttribute('data-max-buckets-override')).toBe('null')

    // Click 100
    fireEvent.click(btn100)

    expect(chart1m.getAttribute('data-max-buckets-override')).toBe('100')
    const chart5m = screen.getByTestId('btc-price-chart-5m')
    expect(chart5m.getAttribute('data-max-buckets-override')).toBe('100')

    // Click 300
    fireEvent.click(btn300)

    expect(chart1m.getAttribute('data-max-buckets-override')).toBe('300')
    expect(chart5m.getAttribute('data-max-buckets-override')).toBe('300')

    // Click Auto
    fireEvent.click(autoBtn)

    expect(chart1m.getAttribute('data-max-buckets-override')).toBe('null')
    expect(chart5m.getAttribute('data-max-buckets-override')).toBe('null')
  })
})

describe('PriceChart contract levels', () => {
  const linesOn5m = (contract) => {
    render(<PriceChart contract={{ target: 69300, stop: 67300, ...contract }} />)
    return lastProps.instances.filter(p => p.defaultInterval === '5m').at(-1).referenceLines
  }

  it('drops the levels of an expired contract, which would flatten the candles', () => {
    expect(linesOn5m({ expiry: Date.now() - 1000 })).toEqual([])
  })

  it('keeps them for a live contract or one without an expiry', () => {
    expect(linesOn5m({ expiry: Date.now() + 60_000 })).toHaveLength(2)
    cleanup()
    expect(linesOn5m({ expiry: null })).toHaveLength(2)
  })
})
