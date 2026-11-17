import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import LiveStatusBar from '../src/components/regime/LiveStatusBar'

// Issue #586: the "Since Last Entry" tile treats a missing/zero lastEntryTime as
// "no entries yet" instead of measuring from the Unix epoch.
vi.mock('../src/components/regime/EntryStatusCard', () => ({ default: () => null }))
vi.mock('../src/components/regime/CurrentRegimeCard', () => ({ default: () => null }))
vi.mock('../src/components/regime/EntryModeCard', () => ({ default: () => null }))
afterEach(() => { cleanup(); vi.useRealTimers() })

const mount = (position) => render(<LiveStatusBar
  asset="BTC" market={{ lastPrice: 100 }} position={position} config={{}} prevPrice={100} health={{}} regime={{}}
/>)
const tile = () => screen.getByText('Since Last Entry').parentElement

it.each([[0], [null], [undefined]])('shows a dash and "No entries yet" for lastEntryTime %s, keeping the tile mounted', (lastEntryTime) => {
  mount({ lastEntryTime })
  expect(tile().textContent).toContain('—')
  expect(tile().textContent).toContain('No entries yet')
  expect(tile().textContent).not.toMatch(/\d{4,}h/)
})

it('formats the elapsed duration for a real past entry time', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T12:00:00Z'))
  mount({ lastEntryTime: Date.now() - (2 * 60 + 15) * 60 * 1000 })
  expect(tile().textContent).toContain('2h 15m')
  expect(tile().textContent).not.toContain('No entries yet')
})
