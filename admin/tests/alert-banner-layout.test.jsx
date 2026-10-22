import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import AlertBanner from '../src/components/sentinel/AlertBanner'

vi.mock('../src/lib/router', () => ({ Link: ({ children, ...props }) => <a {...props}>{children}</a> }))
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

  const link = (await screen.findByText(/Feed down/)).closest('a')
  expect(link.className).toContain('fixed')
  expect(link.className).toContain('bottom-0')
  expect(link.className).not.toContain('top-0')
  // Below the toast stack (z-50) so transient toasts stay readable.
  expect(link.className).toContain('z-40')
  expect(link.closest('[data-testid="alert-banner-slot"]').className).toContain('h-0')
})
