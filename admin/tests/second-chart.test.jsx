import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import SecondChart from '../src/components/updown/SecondChart.jsx'

const feed = vi.hoisted(() => ({ current: null, ranges: [] }))
vi.mock('../src/hooks/useBtcSeconds', () => ({ default: (range) => { feed.ranges.push(range); return feed.current } }))
const api = vi.hoisted(() => ({ held: null, ok: true }))

const T0 = 1_800_000_000_000
const bar = (sec, close, over = {}) => ({ t: T0 + sec * 1000, open: close, high: close + 2, low: close - 2, close, buyVolume: 1, sellVolume: 1, trades: 2, ...over })
// 70 seconds ending now; the close 10s, 30s and 60s before the last is 61241, 61274 and 61191.
const closes = { 59: 61241, 39: 61274, 9: 61191, 69: 61203 }
const bars = () => Array.from({ length: 70 }, (_, i) => bar(i - 69, closes[i] ?? 61220))
const state = (over = {}) => ({ bars: bars(), index: [{ t: T0, value: 61210 }], nowMs: T0 + 400, ages: { coinbase: 400, index: 900 }, error: null, ...over })
const held = (action = 'HOLD') => ({ contract: { floor: 60607, ceiling: 62607 }, decision: { action } })

const show = async (over, props = {}) => {
  feed.current = state(over)
  const view = render(<SecondChart contract={null} held={api.ok ? api.held : undefined} {...props} />)
  await act(async () => {})
  return view
}
const button = (name) => screen.getByRole('button', { name })
const text = (id) => screen.getByTestId(id).textContent

beforeEach(() => {
  feed.ranges.length = 0
  api.held = null
  api.ok = true
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(800)
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(260)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('interval and range', () => {
  it('opens on 1s over 5m and disables longer ranges', async () => {
    await show()
    expect(feed.ranges.at(-1)).toBe(300)
    expect(button('1s').getAttribute('aria-pressed')).toBe('true')
    expect(button('5m').disabled).toBe(false)
    expect(button('15m').disabled).toBe(true)
    expect(button('1h').disabled).toBe(true)
  })

  it('offers 15m at 5s and returns to 5m when 1s is chosen again', async () => {
    await show()
    fireEvent.click(button('5s'))
    expect(button('15m').disabled).toBe(false)
    expect(button('1h').disabled).toBe(true)
    fireEvent.click(button('15m'))
    expect(feed.ranges.at(-1)).toBe(900)
    fireEvent.click(button('1s'))
    expect(feed.ranges.at(-1)).toBe(300)
  })

  it('offers an hour at 15s', async () => {
    await show()
    fireEvent.click(button('15s'))
    fireEvent.click(button('1h'))
    expect(feed.ranges.at(-1)).toBe(3600)
  })
})

describe('freshness', () => {
  it('shows the age while live', async () => {
    await show()
    expect(text('second-freshness')).toContain('live 0.4s')
    expect(screen.getByTestId('second-freshness').className).toContain('text-green-400')
  })

  it('turns amber from 3s', async () => {
    await show({ ages: { coinbase: 4000, index: 900 } })
    expect(text('second-freshness')).not.toContain('live')
    expect(screen.getByTestId('second-freshness').className).toContain('text-amber-400')
  })

  it('is stale from 10s, with moves blanked', async () => {
    await show({ ages: { coinbase: 11_000, index: 900 } })
    expect(text('second-freshness')).toContain('stale')
    expect(screen.getByTestId('second-freshness').className).toContain('text-red-400')
    expect(text('second-moves')).toBe('10s --- 30s --- 60s ---')
  })

  it('is stale before any trade has arrived', async () => {
    await show({ bars: [], index: [], ages: { coinbase: null, index: null } })
    expect(text('second-freshness')).toContain('stale')
  })
})

describe('readouts', () => {
  it('shows signed moves', async () => {
    await show()
    expect(text('second-moves')).toBe('10s −$38 30s −$71 60s +$12')
  })

  it('labels the index as a proxy and shows the gap', async () => {
    await show()
    expect(text('second-index')).toContain('$61,210')
    expect(text('second-index')).toContain('(proxy)')
    expect(text('second-index')).toContain('gap −$7')
  })

  it('blanks the index, gap and bounds when only the index is stale', async () => {
    api.held = held()
    await show({ ages: { coinbase: 400, index: 11_000 } })
    expect(text('second-index')).toBe('Index --- (proxy) gap ---')
    expect(text('second-bounds')).toBe('floor index --- / Coinbase −$596 · ceiling index --- / Coinbase +$1,404 (your contract)')
    expect(text('second-freshness')).toContain('live')
    expect(text('second-moves')).toContain('10s −$38')
  })

  it('blanks the gap and the Coinbase distances when only Coinbase is stale', async () => {
    api.held = held()
    await show({ ages: { coinbase: 11_000, index: 900 } })
    expect(text('second-index')).toBe('Index $61,210 (proxy) gap ---')
    expect(text('second-bounds')).toBe('floor index −$603 / Coinbase --- · ceiling index +$1,397 / Coinbase --- (your contract)')
  })

  it('measures the held contract from both sources', async () => {
    api.held = held()
    await show()
    expect(text('second-bounds')).toBe('floor index −$603 / Coinbase −$596 · ceiling index +$1,397 / Coinbase +$1,404 (your contract)')
  })

  it('asks to check the app after a suspected knock-out', async () => {
    api.held = held('CHECK_APP')
    await show()
    expect(text('second-bounds')).toContain('check the app')
  })

  it('falls back to a configured Up contract', async () => {
    await show({}, { contract: { direction: 'up', stop: 60210, target: 62210 } })
    expect(text('second-bounds')).toContain('floor index −$1,000')
    expect(text('second-bounds')).toContain('(configured contract)')
  })

  it('does not show the configured contract when the held one could not be read', async () => {
    api.ok = false
    await show({}, { contract: { direction: 'up', stop: 60210, target: 62210 } })
    expect(screen.queryByTestId('second-bounds')).toBeNull()
  })

  it('shows no bounds without a contract', async () => {
    await show()
    expect(screen.queryByTestId('second-bounds')).toBeNull()
  })
})

describe('chart', () => {
  it('draws a candle per traded slot and none in a gap', async () => {
    const { container } = await show()
    expect(container.querySelectorAll('.candle')).toHaveLength(70)
  })

  it('draws true candles, not averaged ones', async () => {
    const { container } = await show({ bars: [bar(-1, 100), bar(0, 100, { open: 90, high: 110, low: 80 })], index: [] })
    const [, last] = container.querySelectorAll('.candle')
    const [upper, lower] = last.querySelectorAll('line')
    const body = last.querySelector('rect')
    const px = (el, name) => Number(el.getAttribute(name))
    const perDollar = (px(lower, 'y2') - px(upper, 'y1')) / 30
    expect(px(body, 'height') / perDollar).toBeCloseTo(10, 1)
    expect(body.getAttribute('fill')).toBe('#10b981')
  })

  it('draws a bound only when it is inside the visible prices', async () => {
    api.held = { contract: { floor: 61210, ceiling: 63210 }, decision: { action: 'HOLD' } }
    const { container } = await show()
    expect(container.querySelectorAll('.reference-line')).toHaveLength(1)
    cleanup()
    api.held = held()
    const far = await show()
    expect(far.container.querySelectorAll('.reference-line')).toHaveLength(0)
  })

  it('draws buying green and selling red in proportion', async () => {
    const { container } = await show({ bars: [bar(0, 100, { buyVolume: 3, sellVolume: 1 }), bar(-1, 100, { buyVolume: 0, sellVolume: 0 })] })
    const height = (sel) => Number([...container.querySelectorAll(sel)].at(-1).getAttribute('height'))
    expect(height('.volume-buy') / height('.volume-sell')).toBeCloseTo(3, 1)
    expect([...container.querySelectorAll('.volume-buy')].at(-1).getAttribute('fill')).toBe('#10b981')
    expect([...container.querySelectorAll('.volume-sell')].at(-1).getAttribute('fill')).toBe('#ef4444')
    expect(container.querySelectorAll('.volume-buy')).toHaveLength(1)
  })

  it('reports an error with nothing to show', async () => {
    await show({ bars: [], index: [], nowMs: null, ages: { coinbase: null, index: null }, error: 'gateway down' })
    expect(screen.getByRole('alert').textContent).toContain('gateway down')
  })

  it('waits quietly before the first trade', async () => {
    await show({ bars: [], index: [], nowMs: T0, ages: { coinbase: null, index: null } })
    expect(screen.getByText(/waiting for trades/i)).toBeTruthy()
  })
})
