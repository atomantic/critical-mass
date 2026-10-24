import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import AlertBanner from '../src/components/sentinel/AlertBanner'
import { apiGet } from '../src/utils/apiClient'

vi.mock('../src/lib/router', () => ({ Link: ({ children, to, ...props }) => <a href={to} {...props}>{children}</a> }))
vi.mock('../src/utils/apiClient', () => ({ apiGet: vi.fn() }))

let alerts = []
let criticalCount = 0
let warningCount = 0

function setAlerts(next) {
  alerts = next
  criticalCount = next.filter(alert => alert.severity === 'critical').length
  warningCount = next.filter(alert => alert.severity === 'warning').length
  apiGet.mockImplementation(async url => url.endsWith('/status')
    ? { ok: true, data: { criticalAlerts: criticalCount, warningAlerts: warningCount } }
    : { ok: true, data: { items: alerts, total: alerts.length, limit: 500, offset: 0 } })
}

async function pollAgain() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000)
  })
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('keeps polite and assertive live regions mounted and announces a newly arriving critical alert once without moving focus', async () => {
  vi.useFakeTimers()
  setAlerts([])
  render(<AlertBanner />)
  const status = screen.getByRole('status')
  const alertRegion = screen.getByRole('alert')
  expect(status.getAttribute('aria-live')).toBe('polite')
  expect(alertRegion.getAttribute('aria-live')).toBe('assertive')
  expect(status.textContent).toBe('')
  expect(alertRegion.textContent).toBe('')

  const focusTarget = document.createElement('button')
  document.body.append(focusTarget)
  focusTarget.focus()
  setAlerts([{ id: 'c1', title: 'Feed outage', severity: 'critical' }])
  await pollAgain()

  expect(alertRegion.textContent).toContain('1 critical alert: Feed outage')
  expect(document.activeElement).toBe(focusTarget)
  expect(screen.getByRole('link', { name: /ALERT\s*Feed outage\s*View details/ })).toBeTruthy()

  await pollAgain()
  expect(alertRegion.textContent).toContain('1 critical alert: Feed outage')
  focusTarget.remove()
})

it('announces warnings politely, severity upgrades assertively, and clearing meaningfully', async () => {
  vi.useFakeTimers()
  setAlerts([{ id: 'w1', title: 'Slow feed', severity: 'warning' }])
  render(<AlertBanner />)
  await act(async () => {})
  expect(screen.getByRole('status').textContent).toContain('1 warning: Slow feed')
  expect(screen.getByRole('alert').textContent).toBe('')

  setAlerts([{ id: 'w1', title: 'Slow feed', severity: 'critical' }])
  await pollAgain()
  expect(screen.getByRole('alert').textContent).toContain('1 critical alert: Slow feed')
  expect(screen.getByRole('status').textContent).toBe('')

  setAlerts([])
  await pollAgain()
  expect(screen.getByRole('alert').textContent).toBe('All 1 active Sentinel alert cleared.')
  expect(screen.getByTestId('alert-banner-slot')).toBeTruthy()

  await pollAgain()
  expect(screen.getByRole('alert').textContent).toBe('All 1 active Sentinel alert cleared.')
  setAlerts([{ id: 'w1', title: 'Slow feed', severity: 'critical' }])
  await pollAgain()
  expect(screen.getByRole('alert').textContent).toContain('1 critical alert: Slow feed')
})

it('announces critical alerts beyond the three visible rows and ignores reordered unchanged snapshots', async () => {
  vi.useFakeTimers()
  const warnings = [
    { id: 'w1', title: 'Warning one', severity: 'warning' },
    { id: 'w2', title: 'Warning two', severity: 'warning' },
    { id: 'w3', title: 'Warning three', severity: 'warning' },
  ]
  setAlerts(warnings)
  render(<AlertBanner />)
  await act(async () => {})
  expect(screen.getByRole('status').textContent).toContain('3 warnings')

  setAlerts([...warnings, { id: 'c1', title: 'Fourth critical', severity: 'critical' }])
  await pollAgain()
  expect(screen.getByRole('alert').textContent).toContain('1 critical alert and 3 warnings: Fourth critical')
  expect(screen.queryByText('Fourth critical')).toBeNull()

  setAlerts([{ id: 'w3', title: 'Warning three', severity: 'warning' }, { id: 'c1', title: 'Fourth critical', severity: 'critical' }, ...warnings.slice(0, 2)])
  await pollAgain()
  expect(screen.getByRole('alert').textContent).toContain('1 critical alert and 3 warnings: Fourth critical')
})

it('updates the live-region content node for a new alert with an unchanged human summary, but not for an unchanged poll', async () => {
  vi.useFakeTimers()
  setAlerts([{ id: 'w1', title: 'Feed delay', severity: 'warning' }])
  render(<AlertBanner />)
  await act(async () => {})
  const status = screen.getByRole('status')
  const firstAnnouncement = status.firstElementChild
  expect(firstAnnouncement.textContent).toContain('1 warning: Feed delay')

  setAlerts([{ id: 'w2', title: 'Feed delay', severity: 'warning' }])
  await pollAgain()
  const replacementAnnouncement = status.firstElementChild
  expect(replacementAnnouncement).not.toBe(firstAnnouncement)
  expect(replacementAnnouncement.textContent).toContain('1 alert cleared. 1 warning: Feed delay')

  await pollAgain()
  expect(status.firstElementChild).toBe(replacementAnnouncement)
})
