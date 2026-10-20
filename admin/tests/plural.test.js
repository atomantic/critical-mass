import { describe, it, expect } from 'vitest'
import { plural } from '../src/utils/plural.mjs'

describe('plural', () => {
  it('uses the singular for exactly 1', () => {
    expect(plural(1, 'sell')).toBe('1 sell')
  })
  it('uses the plural for 0 and many', () => {
    expect(plural(0, 'sell')).toBe('0 sells')
    expect(plural(2, 'sell')).toBe('2 sells')
  })
  it('honors an irregular plural form', () => {
    expect(plural(1, 'entry', 'entries')).toBe('1 entry')
    expect(plural(2, 'entry', 'entries')).toBe('2 entries')
  })
})
