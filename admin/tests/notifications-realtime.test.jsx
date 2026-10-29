import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import { renderWithToasts as render } from './renderWithToasts'
import NotificationsConfig from '../src/components/NotificationsConfig'

const socket = vi.hoisted(() => {
  const handlers = new Map()
  return {
    on: (event, handler) => { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(handler) },
    off: (event, handler) => handlers.get(event)?.delete(handler),
    subscribe: () => {},
    unsubscribe: () => {},
    fire: (event) => [...(handlers.get(event) || [])].forEach(handler => handler({})),
  }
})
vi.mock('../src/lib/realtime', () => ({ getRealtimeClient: () => socket }))
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('updates counters when delivery settles after the original trade event', async () => {
  let stats = { sent: 0, errors: 0, queueDepth: 1, isRunning: true, lastSentAt: null }
  vi.stubGlobal('fetch', vi.fn(async url => ({
    ok: true,
    status: 200,
    json: async () => url === '/api/notifications/config'
      ? { enabled: true, telegram: { botToken: '••••', chatId: '123' }, events: {}, rateLimitMs: 5000, dailySummaryHour: 8, quietHours: { enabled: false, start: 23, end: 7 } }
      : { ...stats },
  })))
  render(<NotificationsConfig />)
  const sent = await screen.findByRole('group', { name: 'Messages Sent' })
  expect(within(sent).getByText('0')).toBeTruthy()
  expect(within(screen.getByRole('group', { name: 'Queue Depth' })).getByText('1')).toBeTruthy()

  // Delivery completes later, without another trade or Sentinel alert.
  stats = { ...stats, sent: 1, queueDepth: 0, lastSentAt: '2026-10-28T12:00:00Z' }
  vi.useFakeTimers({ shouldAdvanceTime: true })
  await act(async () => { socket.fire('notifications:stats'); vi.advanceTimersByTime(5000) })
  await waitFor(() => expect(within(sent).getByText('1')).toBeTruthy())
  expect(within(screen.getByRole('group', { name: 'Queue Depth' })).getByText('0')).toBeTruthy()
})
