import { describe, it, expect } from 'vitest'
import { formatUsd, formatPercent, formatLocalStamp, formatBytes } from '../src/utils/format.mjs'

describe('formatUsd', () => {
  it('renders placeholder for null/non-finite', () => {
    expect(formatUsd(null)).toBe('---')
    expect(formatUsd(NaN)).toBe('---')
  })
  it('defaults to 2 decimals', () => {
    expect(formatUsd(1234.5)).toBe('$1,234.50')
    expect(formatUsd(-5)).toBe('-$5.00')
  })
  it('supports 0 decimals', () => {
    expect(formatUsd(1573.31, { decimals: 0 })).toBe('$1,573')
  })
  it('compact abbreviates thousands and trims .0', () => {
    expect(formatUsd(1573.31, { compact: true, decimals: 0 })).toBe('$1.6K')
    expect(formatUsd(-2000, { compact: true, decimals: 0 })).toBe('-$2K')
  })
})

describe('formatPercent', () => {
  it('formats with 2 decimals and treats nullish as 0', () => {
    expect(formatPercent(12.345)).toBe('12.35%')
    expect(formatPercent(undefined)).toBe('0.00%')
    expect(formatPercent(1.5, 1)).toBe('1.5%')
  })
})

describe('formatLocalStamp', () => {
  it('zero-pads local components', () => {
    expect(formatLocalStamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02 03:04:05')
  })
})

describe('formatBytes', () => {
  it('scales B/KB/MB', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})
