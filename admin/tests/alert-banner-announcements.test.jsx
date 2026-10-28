import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import AlertBanner from '../src/components/sentinel/AlertBanner'
import { apiGet } from '../src/utils/apiClient'

// Alerts refresh on `sentinel:*` socket events, driven through this fake client.
const socket = vi.hoisted(() => {
  const handlers = new Map()
  return {
    on: (event, handler) => { handlers.set(event, [...(handlers.get(event) || []), handler]) },
    off: (event, handler) => { handlers.set(event, (handlers.get(event) || []).filter(h => h !== handler)) },
    subscribe: () => {},
    unsubscribe: () => {},
    fire: (event, payload) => (handlers.get(event) || []).forEach(h => h(payload)),
  }
})
vi.mock('../src/lib/realtime', () => ({ getRealtimeClient: () => socket }))
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

async function refreshAgain() {
  await act(async () => {
    socket.fire('sentinel:status', {})
    await vi.advanceTimersByTimeAsync(0)
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
  await refreshAgain()

  expect(alertRegion.textContent).toContain('1 critical alert: Feed outage')
  expect(document.activeElement).toBe(focusTarget)
  expect(screen.getByRole('link', { name: /ALERT\s*Feed outage\s*View details/ })).toBeTruthy()

  await refreshAgain()
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
  await refreshAgain()
  expect(screen.getByRole('alert').textContent).toContain('1 critical alert: Slow feed')
  expect(screen.getByRole('status').textContent).toBe('')

  setAlerts([])
  await refreshAgain()
  expect(screen.getByRole('alert').textContent).toBe('All 1 active Sentinel alert cleared.')
  expect(screen.getByTestId('alert-banner-slot')).toBeTruthy()

  await refreshAgain()
  expect(screen.getByRole('alert').textContent).toBe('All 1 active Sentinel alert cleared.')
  setAlerts([{ id: 'w1', title: 'Slow feed', severity: 'critical' }])
  await refreshAgain()
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
  await refreshAgain()
  expect(screen.getByRole('alert').textContent).toContain('1 critical alert and 3 warnings: Fourth critical')
  expect(screen.queryByText('Fourth critical')).toBeNull()

  setAlerts([{ id: 'w3', title: 'Warning three', severity: 'warning' }, { id: 'c1', title: 'Fourth critical', severity: 'critical' }, ...warnings.slice(0, 2)])
  await refreshAgain()
  expect(screen.getByRole('alert').textContent).toContain('1 critical alert and 3 warnings: Fourth critical')
})

it('updates the live-region content node for a new alert with an unchanged human summary, but not for an unchanged refresh', async () => {
  vi.useFakeTimers()
  setAlerts([{ id: 'w1', title: 'Feed delay', severity: 'warning' }])
  render(<AlertBanner />)
  await act(async () => {})
  const status = screen.getByRole('status')
  const firstAnnouncement = status.firstElementChild
  expect(firstAnnouncement.textContent).toContain('1 warning: Feed delay')

  setAlerts([{ id: 'w2', title: 'Feed delay', severity: 'warning' }])
  await refreshAgain()
  const replacementAnnouncement = status.firstElementChild
  expect(replacementAnnouncement).not.toBe(firstAnnouncement)
  expect(replacementAnnouncement.textContent).toContain('1 alert cleared. 1 warning: Feed delay')

  await refreshAgain()
  expect(status.firstElementChild).toBe(replacementAnnouncement)
})

it('re-reads once more when a change arrives while a read is in flight', async () => {
  vi.useFakeTimers()
  setAlerts([])
  let release
  const gate = new Promise(resolve => { release = resolve })
  const reads = []
  apiGet.mockImplementation(async url => {
    reads.push(url)
    if (reads.length === 1) await gate
    return url.endsWith('/status')
      ? { ok: true, data: { criticalAlerts: 1, warningAlerts: 0 } }
      : { ok: true, data: { items: [{ id: 'c1', title: 'Feed outage', severity: 'critical' }], total: 1, limit: 500, offset: 0 } }
  })
  render(<AlertBanner />)
  await act(async () => { socket.fire('sentinel:alert', { id: 'c1' }) })
  expect(reads).toHaveLength(1)
  await act(async () => { release(); await vi.advanceTimersByTimeAsync(0) })
  expect(screen.getByRole('alert').textContent).toContain('1 critical alert: Feed outage')
})
