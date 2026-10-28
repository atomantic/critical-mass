import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import AlertBanner from '../src/components/sentinel/AlertBanner'

vi.mock('../src/lib/realtime', () => ({
  getRealtimeClient: () => ({ on: () => {}, off: () => {}, subscribe: () => {}, unsubscribe: () => {} }),
}))
vi.mock('../src/lib/router', () => ({ Link: ({ children, to, ...props }) => <a href={to} {...props}>{children}</a> }))
vi.mock('../src/utils/apiClient', () => ({
  apiGet: vi.fn(async (url) => url.endsWith('/status')
    ? { ok: true, data: { criticalAlerts: 1, warningAlerts: 0 } }
    : { ok: true, data: { items: [{ id: 'a1', title: 'Feed down', severity: 'critical' }], total: 1, limit: 500, offset: 0 } }),
}))

afterEach(() => cleanup())

it('keeps a zero-height slot before and after alerts arrive and pins the banner to the bottom edge, below toasts', async () => {
  render(<AlertBanner />)
  const slot = screen.getByTestId('alert-banner-slot')
  expect(slot.className).toContain('h-0')

  await screen.findByRole('link', { name: /View details/ })
  const banner = screen.getByRole('link', { name: /View details/ }).parentElement
  expect(banner.className).toContain('fixed')
  expect(banner.className).toContain('bottom-0')
  expect(banner.className).not.toContain('top-0')
  // Below the toast stack (z-50) so transient toasts stay readable.
  expect(banner.className).toContain('z-40')
  expect(screen.getByTestId('alert-banner-slot').className).toContain('h-0')
})

it('reserves bottom padding on body while the fixed banner is visible and restores it on unmount', async () => {
  document.body.style.paddingBottom = ''
  const { unmount } = render(<AlertBanner />)
  await screen.findByRole('link', { name: /View details/ })
  expect(document.body.style.paddingBottom).not.toBe('')
  unmount()
  expect(document.body.style.paddingBottom).toBe('')
})
