import { describe, expect, it } from 'vitest'
import {
  INTERVALS, RANGES, buildSlots, contractBounds, freshness, isAllowed, mergeByT, priceMoves,
} from '../src/utils/btcSeconds.mjs'

const T0 = 1_800_000_000_000
const at = (sec) => T0 + sec * 1000
const bar = (sec, over = {}) => ({ t: at(sec), open: 100, high: 100, low: 100, close: 100, buyVolume: 0, sellVolume: 0, trades: 0, ...over })

describe('isAllowed', () => {
  it('never shows more than 300 candles', () => {
    const allowed = INTERVALS.flatMap(i => RANGES.filter(r => isAllowed(i, r)).map(r => [i, r]))
    expect(allowed).toEqual([
      [1, 300], [5, 300], [5, 900], [15, 300], [15, 900], [15, 3600], [30, 300], [30, 900], [30, 3600],
    ])
  })
})

describe('mergeByT', () => {
  it('lets incoming entries win, sorts, and drops entries before the cutoff', () => {
    expect(mergeByT([{ t: 1 }, { t: 2, v: 'old' }, { t: 4 }], [{ t: 3 }, { t: 2, v: 'new' }], 2))
      .toEqual([{ t: 2, v: 'new' }, { t: 3 }, { t: 4 }])
  })
})

describe('buildSlots', () => {
  it('combines 1s bars into the interval', () => {
    const bars = [
      bar(0, { open: 10, high: 12, low: 9, close: 11, buyVolume: 1, sellVolume: 2 }),
      bar(3, { open: 11, high: 20, low: 11, close: 15, buyVolume: 3, sellVolume: 4 }),
      bar(4, { open: 15, high: 16, low: 5, close: 6, buyVolume: 5, sellVolume: 6 }),
    ]
    const slots = buildSlots({ bars, index: [{ t: at(1), value: 50 }, { t: at(4), value: 51 }], interval: 5, range: 300, nowMs: at(4) + 500 })
    expect(slots).toHaveLength(60)
    expect(slots.at(-1)).toMatchObject({ t: at(0), open: 10, high: 20, low: 5, close: 6, buyVolume: 9, sellVolume: 12, indexValue: 51 })
  })

  it('leaves empty slots null so a gap stays a gap', () => {
    const slots = buildSlots({ bars: [bar(0)], index: [], interval: 1, range: 300, nowMs: at(2) })
    expect(slots).toHaveLength(300)
    expect(slots.at(-3).close).toBe(100)
    expect(slots.at(-2)).toMatchObject({ open: null, high: null, low: null, close: null, buyVolume: 0, sellVolume: 0, indexValue: null })
  })

  it('keeps growing the trailing gap while nothing arrives', () => {
    const slots = buildSlots({ bars: [bar(0)], index: [], interval: 1, range: 300, nowMs: at(4) + 900 })
    expect(slots.slice(-4).every(s => s.close === null)).toBe(true)
    expect(slots.at(-5).close).toBe(100)
  })

  it('still shows the newest bars when the gateway clock is behind the exchange', () => {
    const slots = buildSlots({ bars: [bar(0), bar(4)], index: [], interval: 1, range: 300, nowMs: at(0) })
    expect(slots.at(-1)).toMatchObject({ t: at(4), close: 100 })
    expect(slots.at(-5)).toMatchObject({ t: at(0), close: 100 })
  })

  it('numbers slots and ignores data outside the range', () => {
    const slots = buildSlots({ bars: [bar(-400), bar(0)], index: [{ t: at(-400), value: 1 }], interval: 1, range: 300, nowMs: at(0) })
    expect(slots.map(s => s.chartIndex)).toEqual(Array.from({ length: 300 }, (_, i) => i))
    expect(slots.filter(s => s.close !== null)).toHaveLength(1)
    expect(slots.some(s => s.indexValue !== null)).toBe(false)
  })
})

describe('priceMoves', () => {
  const bars = [bar(0, { close: 88 }), bar(50, { close: 138 }), bar(60, { close: 100 })]
  it('compares the last close with exactly 10s, 30s and 60s before it', () => {
    expect(priceMoves(bars, { stale: false })).toEqual({ 10: -38, 30: null, 60: 12 })
  })
  it('is blank when stale or empty', () => {
    expect(priceMoves(bars, { stale: true })).toEqual({ 10: null, 30: null, 60: null })
    expect(priceMoves([], { stale: false })).toEqual({ 10: null, 30: null, 60: null })
  })
})

describe('freshness', () => {
  it.each([[0, 'live'], [2_999, 'live'], [3_000, 'amber'], [9_999, 'amber'], [10_000, 'stale'], [null, 'stale']])('%s ms is %s', (age, expected) => {
    expect(freshness(age)).toBe(expected)
  })
})

describe('contractBounds', () => {
  const held = (action) => ({ contract: { floor: 60600, ceiling: 62600 }, decision: { action } })
  const configured = { direction: 'up', stop: 59000, target: 61000 }

  it('prefers the held contract', () => {
    expect(contractBounds(held('HOLD'), configured)).toEqual({ floor: 60600, ceiling: 62600, label: 'your contract', note: null })
  })
  it('shows nothing until the held contract is known', () => {
    expect(contractBounds(undefined, configured)).toBeNull()
  })
  it('ignores a configured contract that has expired', () => {
    expect(contractBounds(null, { ...configured, expiry: T0 }, T0)).toBeNull()
    expect(contractBounds(null, { ...configured, expiry: T0 + 1 }, T0)).not.toBeNull()
  })
  it('asks to check the app after a suspected knock-out', () => {
    expect(contractBounds(held('CHECK_APP'), configured)).toMatchObject({ floor: 60600, note: 'check the app' })
  })
  it('falls back to the configured Up contract when the holding expired or is absent', () => {
    const fallback = { floor: 59000, ceiling: 61000, label: 'configured contract', note: null }
    expect(contractBounds(held('EXPIRED'), configured)).toEqual(fallback)
    expect(contractBounds(null, configured)).toEqual(fallback)
  })
  it.each([
    [{ direction: 'down', stop: 59000, target: 61000 }],
    [{ direction: null, stop: 59000, target: 61000 }],
    [{ direction: 'up', stop: null, target: 61000 }],
    [{ direction: 'up', stop: 59000, target: null }],
    [null],
  ])('shows nothing for %o', (contract) => {
    expect(contractBounds(null, contract)).toBeNull()
  })
})
