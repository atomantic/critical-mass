import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import AppQuoteForm, { ScreenshotQuote } from '../src/components/updown/AppQuoteForm.jsx'

const api = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('../src/utils/apiClient', () => ({ apiPost: api.post, describeMutationFailure: (res, fallback) => res.data?.error || fallback }))

const NOW = Date.parse('2026-11-23T22:59:30Z')
const extracted = { screenType: 'select', direction: 'Up', range: 2000, currentPrice: 61118.69, upPrice: 61172, downPrice: 61074, target: 62200, stop: 60200, maxLoss: '-$486.00', expiryMs: NOW + 4 * 86_400_000 }
const ok = (quote = { halfSpread: 49 }) => ({ ok: true, data: { success: true, quote } })
const bad = (error) => ({ ok: false, data: { success: false, error } })
const bodies = () => api.post.mock.calls.map(([, body]) => body)
const record = () => screen.getByRole('button', { name: /record quote/i })

beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(NOW); api.post.mockResolvedValue(ok()) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); api.post.mockReset() })

describe('quote from a screenshot', () => {
  it('shows the spread it would record, and records nothing until clicked', async () => {
    render(<ScreenshotQuote extracted={extracted} />)
    expect(await screen.findByText(/spread \$49 a side/i)).toBeTruthy()
    expect(bodies()).toEqual([{ preview: true, source: 'screenshot', direction: 'Up', range: 2000, shown: 61118.69, up: 61172, down: 61074, floor: 60200, ceiling: 62200, maxLoss: '-$486.00', expiry: extracted.expiryMs }])
    fireEvent.click(record())
    expect(await screen.findByText(/recorded/i)).toBeTruthy()
    expect(bodies()[1].preview).toBeUndefined()
    expect(bodies()[1].up).toBe(61172)
    expect(screen.queryByRole('button', { name: /record quote/i })).toBeNull()
  })

  it('shows why a quote cannot be recorded and offers no button', async () => {
    api.post.mockResolvedValue(bad('Max Loss should be about 486'))
    render(<ScreenshotQuote extracted={extracted} />)
    expect((await screen.findByRole('alert')).textContent).toContain('Max Loss should be about 486')
    expect(screen.queryByRole('button', { name: /record quote/i })).toBeNull()
  })

  it('checks again with the time an older screenshot was taken, shifting its countdown', async () => {
    api.post.mockResolvedValueOnce(bad('far from Coinbase'))
    render(<ScreenshotQuote extracted={extracted} />)
    await screen.findByRole('alert')
    const captured = NOW - 2 * 3_600_000
    const local = new Date(captured - new Date(captured).getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
    fireEvent.change(screen.getByLabelText(/captured/i), { target: { value: local } })
    await waitFor(() => expect(bodies()).toHaveLength(2))
    const at = new Date(local).getTime()
    expect(bodies()[1]).toMatchObject({ preview: true, capturedAt: at, expiry: extracted.expiryMs - (NOW - at) })
    expect(await screen.findByText(/spread \$49 a side/i)).toBeTruthy()
  })

  it('ignores a check that answers after a newer one', async () => {
    let first
    api.post.mockReturnValueOnce(new Promise((resolve) => { first = resolve }))
    render(<ScreenshotQuote extracted={extracted} />)
    fireEvent.change(screen.getByLabelText(/captured/i), { target: { value: '2026-11-23T10:00' } })
    await screen.findByText(/spread \$49 a side/i)
    await act(async () => { first(bad('stale answer')) })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('cannot be recorded twice while saving', async () => {
    render(<ScreenshotQuote extracted={extracted} />)
    await screen.findByText(/spread \$49 a side/i)
    api.post.mockReturnValue(new Promise(() => {}))
    fireEvent.click(record())
    expect(record().disabled).toBe(true)
    fireEvent.click(record())
    expect(bodies()).toHaveLength(2)
  })

  it('keeps the button after a failed save', async () => {
    render(<ScreenshotQuote extracted={extracted} />)
    await screen.findByText(/spread \$49 a side/i)
    api.post.mockResolvedValue(bad('gateway down'))
    fireEvent.click(record())
    expect((await screen.findByRole('alert')).textContent).toContain('gateway down')
    expect(record().disabled).toBe(false)
  })
})

describe('manual quote', () => {
  const type = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
  const fill = () => { type(/bitcoin price/i, '61118.69'); type(/^up/i, '61172'); type(/^down/i, '61074'); type(/stop/i, '60200') }

  it('posts numbers and the default range, and reports what was recorded', async () => {
    const onRecorded = vi.fn()
    render(<AppQuoteForm onRecorded={onRecorded} />)
    fill()
    fireEvent.click(record())
    expect(await screen.findByText(/spread \$49 a side recorded/i)).toBeTruthy()
    expect(api.post).toHaveBeenCalledWith('/api/updown/app-quotes', { source: 'manual', range: 2000, shown: 61118.69, up: 61172, down: 61074, floor: 60200 })
    expect(onRecorded).toHaveBeenCalled()
  })

  it('posts a captured time and an expiry when given', async () => {
    render(<AppQuoteForm onRecorded={() => {}} />)
    fill()
    type(/captured/i, '2026-11-23T14:58')
    type(/expiry/i, '2026-11-28')
    fireEvent.click(record())
    await waitFor(() => expect(bodies()).toHaveLength(1))
    expect(bodies()[0].capturedAt).toBe(new Date('2026-11-23T14:58').getTime())
    expect(bodies()[0].expiry).toBe(Date.parse('2026-11-28T09:00:00Z'))
  })

  it('shows a rejection and keeps what was typed', async () => {
    api.post.mockResolvedValue(bad('the shown price must be between Down and Up'))
    render(<AppQuoteForm onRecorded={() => {}} />)
    fill()
    fireEvent.click(record())
    expect((await screen.findByRole('alert')).textContent).toContain('between Down and Up')
    expect(screen.getByLabelText(/^up/i).value).toBe('61172')
  })
})
