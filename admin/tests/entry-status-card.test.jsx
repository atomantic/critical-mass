import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import EntryStatusCard from '../src/components/regime/EntryStatusCard'

afterEach(() => {
  cleanup()
})

describe('EntryStatusCard', () => {
  it('renders Reduced with yellow dot when regimeMode is TREND and trendScale > 0', () => {
    const { container } = render(
      <EntryStatusCard
        healthMode="ACTIVE"
        regimeMode="TREND"
        trendScale={0.25}
      />
    )
    expect(screen.getByText('Reduced (0.25×)')).toBeTruthy()
    const dot = container.querySelector('.bg-yellow-400')
    expect(dot).toBeTruthy()
    expect(container.querySelector('.bg-red-400')).toBeNull()
  })

  it('renders Blocked with red dot when regimeMode is TREND and trendScale is 0', () => {
    const { container } = render(
      <EntryStatusCard
        healthMode="ACTIVE"
        regimeMode="TREND"
        trendScale={0}
      />
    )
    expect(screen.getByText('Blocked')).toBeTruthy()
    const dot = container.querySelector('.bg-red-400')
    expect(dot).toBeTruthy()
    expect(container.querySelector('.bg-yellow-400')).toBeNull()
  })

  it('renders Blocked with red dot when regimeMode is TREND and trendScale is missing or NaN', () => {
    const { container: c1 } = render(
      <EntryStatusCard
        healthMode="ACTIVE"
        regimeMode="TREND"
      />
    )
    expect(screen.getByText('Blocked')).toBeTruthy()
    expect(c1.querySelector('.bg-red-400')).toBeTruthy()
    cleanup()

    const { container: c2 } = render(
      <EntryStatusCard
        healthMode="ACTIVE"
        regimeMode="TREND"
        trendScale="not-a-number"
      />
    )
    expect(screen.getByText('Blocked')).toBeTruthy()
    expect(c2.querySelector('.bg-red-400')).toBeTruthy()
  })

  it('renders Allowed with green dot when regimeMode is not TREND', () => {
    const { container: c1 } = render(
      <EntryStatusCard
        healthMode="ACTIVE"
        regimeMode="HARVEST"
        trendScale={0}
      />
    )
    expect(screen.getByText('Allowed')).toBeTruthy()
    expect(c1.querySelector('.bg-green-400')).toBeTruthy()
    expect(c1.querySelector('.bg-red-400')).toBeNull()
    cleanup()

    const { container: c2 } = render(
      <EntryStatusCard
        healthMode="ACTIVE"
        regimeMode="CAUTION"
        trendScale={0.5}
      />
    )
    expect(screen.getByText('Allowed')).toBeTruthy()
    expect(c2.querySelector('.bg-green-400')).toBeTruthy()
    expect(c2.querySelector('.bg-red-400')).toBeNull()
  })
})
