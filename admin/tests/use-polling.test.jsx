import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import usePolling from '../src/hooks/usePolling'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const Probe = ({ fn, ms = 1000, opts }) => { usePolling(fn, ms, opts); return null }

it('calls immediately, then on every interval, and stops on unmount', () => {
  const fn = vi.fn()
  const { unmount } = render(<Probe fn={fn} />)
  expect(fn).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(3000)
  expect(fn).toHaveBeenCalledTimes(4)
  unmount()
  vi.advanceTimersByTime(5000)
  expect(fn).toHaveBeenCalledTimes(4)
})

it('immediate:false waits for the first tick; enabled:false never runs', () => {
  const fn = vi.fn()
  render(<Probe fn={fn} opts={{ immediate: false }} />)
  expect(fn).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1000)
  expect(fn).toHaveBeenCalledTimes(1)
  const off = vi.fn()
  render(<Probe fn={off} opts={{ enabled: false }} />)
  vi.advanceTimersByTime(5000)
  expect(off).not.toHaveBeenCalled()
})

it('uses the latest fn without restarting the timer', () => {
  const a = vi.fn(); const b = vi.fn()
  const { rerender } = render(<Probe fn={a} />)
  rerender(<Probe fn={b} />)
  expect(a).toHaveBeenCalledTimes(1)
  expect(b).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1000)
  expect(b).toHaveBeenCalledTimes(1)
})

it('restarts (immediate call + onCleanup) when deps change', () => {
  const fn = vi.fn(); const onCleanup = vi.fn()
  const { rerender, unmount } = render(<Probe fn={fn} opts={{ deps: [1], onCleanup }} />)
  expect(fn).toHaveBeenCalledTimes(1)
  rerender(<Probe fn={fn} opts={{ deps: [2], onCleanup }} />)
  expect(onCleanup).toHaveBeenCalledTimes(1)
  expect(fn).toHaveBeenCalledTimes(2)
  unmount()
  expect(onCleanup).toHaveBeenCalledTimes(2)
})

it('skipOverlap drops ticks while a previous call is still pending', async () => {
  let resolve
  const fn = vi.fn(() => new Promise(r => { resolve = r }))
  render(<Probe fn={fn} opts={{ skipOverlap: true }} />)
  vi.advanceTimersByTime(3000)
  expect(fn).toHaveBeenCalledTimes(1)
  resolve()
  await vi.advanceTimersByTimeAsync(1000)
  expect(fn).toHaveBeenCalledTimes(2)
})

it('without skipOverlap a slow call does not block later ticks', () => {
  const fn = vi.fn(() => new Promise(() => {}))
  render(<Probe fn={fn} />)
  vi.advanceTimersByTime(2000)
  expect(fn).toHaveBeenCalledTimes(3)
})

it('onCleanup can invalidate stale responses (owner-style)', async () => {
  let live = true
  const commits = []
  let resolve
  const fn = () => new Promise(r => { resolve = r }).then(v => { if (live) commits.push(v) })
  const { unmount } = render(<Probe fn={fn} opts={{ onCleanup: () => { live = false } }} />)
  unmount()
  resolve('late')
  await Promise.resolve()
  expect(commits).toEqual([])
})
