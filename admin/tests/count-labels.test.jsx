import React from 'react'
import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import TransactionsDCA from '../src/components/TransactionsDCA'
import TimeframeGrid from '../src/components/updown/TimeframeGrid'

afterEach(cleanup)

it('counts a single DCA transaction in the singular', () => {
  render(<TransactionsDCA transactions={[{ Date: '2026-09-01', Type: 'buy', 'BTC Amount': 0.1, 'USDC Amount': 100, Price: 1000 }]} />)
  expect(screen.getByText('1 transaction')).toBeTruthy()
})

it('describes the timeframe panel with the number of timeframes it actually lists', () => {
  render(<TimeframeGrid indicators={{ timeframes: {} }} tickMomentum={null} />)
  const listed = ['1w', '1d', '4h', '2h', '1h', '30m', '15m', '10m', '5m', '3m', '1m'].filter(key => screen.queryByText(key))
  expect(listed).toHaveLength(11)
  expect(screen.getByText('Timeframe Alignment').getAttribute('title')).toContain(`across ${listed.length} timeframes`)
})
