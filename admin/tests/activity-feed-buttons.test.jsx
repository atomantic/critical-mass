import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import ActivityFeed from '../src/components/ActivityFeed'

vi.mock('../src/hooks/useTradeEvents', () => ({
  useTradeEvents: () => ({
    connected: true,
    clearEvents: () => {},
    events: Array.from({ length: 4 }, (_, i) => ({
      type: 'complete', exchange: 'coinbase', timestamp: 1_700_000_000_000 + i, message: `event ${i}`,
    })),
  }),
}))

afterEach(() => cleanup())

const hasNegativeMargin = (el, side) => el.className.split(/\s+/).some(c => c === `-m${side}-2` || c === '-mx-2')

it('does not pull the facing sides of Show all and Clear into each other (no overlapping hit areas)', () => {
  render(<ActivityFeed maxEvents={2} />)
  const showAll = screen.getByRole('button', { name: 'Show all (4)' })
  const clear = screen.getByRole('button', { name: 'Clear' })
  expect(showAll.nextElementSibling).toBe(clear)

  // Show all sits left of Clear: its right side and Clear's left side face each other.
  expect(hasNegativeMargin(showAll, 'r')).toBe(false)
  expect(hasNegativeMargin(clear, 'l')).toBe(false)
})
