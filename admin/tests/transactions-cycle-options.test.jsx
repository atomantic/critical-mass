import React from 'react'
import { createRequire } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import TransactionsRegime from '../src/components/TransactionsRegime'

const require = createRequire(import.meta.url)
const { createTransactionsReadView } = require('../../src/transactions-regime-query.js')
const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => body })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

for (const cycles of [3000, 15000]) it(`keeps 30,000-fill requests and rendered options bounded at ${cycles} cycles, including polls and historical selection`, async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const history = Array.from({ length: 30000 }, (_, i) => ({ tradeId: `trade-${i}`, orderId: `order-${i}`, timestamp: i + 1000,
    cycleId: `cycle-${i % cycles}`, side: 'buy', size: 0.01, price: i + 1, quoteAmount: (i + 1) / 100, fee: 0 }))
  let revision = 'r1'
  const view = createTransactionsReadView(() => history, () => revision)
  const reads = []
  vi.stubGlobal('fetch', vi.fn(async url => {
    url = String(url)
    if (url.includes('/regime/fills?')) {
      const query = Object.fromEntries(new URL(url, 'http://localhost').searchParams)
      const body = view.query(query)
      reads.push({ query, body, bytes: Buffer.byteLength(JSON.stringify(body)) })
      return response(body, body.statusCode || 200)
    }
    if (url.includes('/regime/status')) return response({ status: { isDryRun: false } })
    if (url.includes('/regime/open-orders')) return response({ orders: [] })
    if (url.includes('/manual-trades')) return response({ success: true, trades: [] })
    return response({ config: { productId: 'BTC-USDC' } })
  }))
  render(<TransactionsRegime exchange="coinbase" pair="BTC-USDC" />)
  const selector = await screen.findByRole('combobox', { name: 'Cycle:' })
  expect(selector.options.length).toBe(102)
  expect(reads[0].body.cycleIds.length).toBe(100)
  expect(reads[0].query.cycleOptionsPaged).toBe('true')
  const initialBytes = reads[0].bytes
  const beforePoll = reads.length
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(reads.length).toBe(beforePoll + 1)
  expect(reads.at(-1).query.revision).toBe('r1')
  expect(reads.at(-1).bytes).toBe(initialBytes)
  expect(selector.options.length).toBe(102)
  console.log(JSON.stringify({ cycles, fills: history.length, initialBytes, pollBytes: reads.at(-1).bytes, renderedCycleOptions: selector.options.length }))

  fireEvent.click(screen.getByRole('button', { name: 'Next cycles' }))
  await waitFor(() => expect(reads.at(-1).body.cycleOptionsInfo.offset).toBe(100))
  await waitFor(() => expect(selector.options[2].value).toBe(`cycle-${cycles - 101}`))
  fireEvent.click(screen.getByRole('button', { name: 'Previous cycles' }))
  await waitFor(() => expect(selector.options[2].value).toBe(`cycle-${cycles - 1}`))

  expect(Array.from(selector.options).some(option => option.value === 'cycle-0')).toBe(false)
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search cycles' }), { target: { value: 'cycle-0' } })
  await waitFor(() => expect(selector.options.length).toBe(3))
  expect(selector.options[2].value).toBe('cycle-0')
  fireEvent.change(selector, { target: { value: 'cycle-0' } })
  await waitFor(() => expect(reads.at(-1).query.cycle).toBe('cycle-0'))
  await waitFor(() => expect(screen.getByText(new RegExp(`Showing 1–${30000 / cycles} of ${30000 / cycles}`))).toBeTruthy())
  expect(reads.at(-1).body.fills.every(fill => fill.cycleId === 'cycle-0')).toBe(true)
  expect(reads.at(-1).body.summary.totalBuys).toBe(30000 / cycles)
  const summary = reads.at(-1).body.summary
  fireEvent.click(screen.getByText('Price'))
  await waitFor(() => expect(reads.at(-1).query.sortField).toBe('price'))
  expect(reads.at(-1).body.summary).toEqual(summary)
  const prices = reads.at(-1).body.fills.map(fill => fill.price)
  expect(prices).toEqual([...prices].sort((a, b) => b - a))

  // Search/browse never clears a selected historical filter; keep it visible
  // even while the current option page does not contain that selected cycle.
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search cycles' }), { target: { value: '' } })
  await waitFor(() => expect(selector.options.length).toBe(103))
  expect(selector.value).toBe('cycle-0')
  expect(reads.at(-1).query.cycle).toBe('cycle-0')
  revision = 'r2'
  const beforeRevision = reads.length
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(reads.length).toBe(beforeRevision + 2)
  expect(reads.at(-2).body.code).toBe('STALE_FILL_REVISION')
  expect(reads.at(-1).query.page).toBe('0')
  expect(reads.at(-1).body.revision).toBe('r2')
  expect(reads.at(-1).body.summary).toEqual(summary)
  expect(selector.value).toBe('cycle-0')
  expect(selector.options.length).toBe(103)
  expect(reads.filter(read => !read.body.statusCode).every(read => read.body.cycleIds.length <= 100 && read.bytes < 45000)).toBe(true)
  expect(Array.from(selector.options).slice(0, 2).map(option => option.value)).toEqual(['all', 'current'])
})
