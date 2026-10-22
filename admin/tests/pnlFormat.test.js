import { describe, it, expect } from 'vitest'
import { pnlColorClass, signedPrefix } from '../src/utils/pnlFormat.mjs'

describe('pnlColorClass', () => {
  it('is green for zero and positive, red for negative', () => {
    expect(pnlColorClass(5)).toBe('text-green-400')
    expect(pnlColorClass(0)).toBe('text-green-400')
    expect(pnlColorClass(-0.01)).toBe('text-red-400')
  })
})

describe('signedPrefix', () => {
  it('prefixes + for zero and positive only', () => {
    expect(signedPrefix(1)).toBe('+')
    expect(signedPrefix(0)).toBe('+')
    expect(signedPrefix(-1)).toBe('')
  })
})
