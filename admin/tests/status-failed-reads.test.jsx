import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BrowserRouter } from '../src/lib/router'
import SentinelDashboard from '../src/components/sentinel/Dashboard.jsx'
import UpDownDashboard from '../src/components/updown/Dashboard.jsx'

vi.mock('../src/hooks/useSentinelSocket.js', () => ({
  default: () => ({ connected: true, latestAlert: null }),
}))
vi.mock('../src/hooks/useUpDownSocket', () => ({
  useUpDownSocket: () => ({ connected: true, tick: null, indicators: null, signal: null, scorecard: null }),
}))
vi.mock('../src/components/updown/PriceChart', () => ({ default: () => null }))

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const ok = body => ({ ok: true, status: 200, json: async () => body })
const unavailable = { ok: false, status: 503, json: async () => ({}) }

const sentinelStatus = {
  running: true,
  config: { enabled: true, feeds: [{ name: 'Market News', url: 'https://news.example/rss', enabled: true }] },
  pollCount: 3,
}

describe('Sentinel dashboard failed reads', () => {
  it('reports a failed status read instead of a disabled service and blocks Add Feed from replacing the saved list', async () => {
    let down = true
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url === '/api/sentinel/status') return down ? unavailable : ok(sentinelStatus)
      if (url.startsWith('/api/sentinel/alerts')) return ok({ alerts: [], items: [] })
      return ok({})
    }))
    render(<SentinelDashboard />)

    expect(await screen.findByText('Could not load Sentinel status.')).toBeTruthy()
    expect(screen.getByText('Status unavailable')).toBeTruthy()
    expect(screen.queryByText('Disabled')).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: 'Feed name' }), { target: { value: 'Second feed' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'RSS feed URL' }), { target: { value: 'https://second.example/rss' } })
    expect(screen.getByRole('button', { name: 'Add Feed' }).disabled).toBe(true)

    down = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Market News')).toBeTruthy()
    expect(screen.queryByText('Could not load Sentinel status.')).toBeNull()
    expect(screen.getByRole('button', { name: 'Add Feed' }).disabled).toBe(false)
  })

  it('reports a failed alerts read instead of "No alerts yet"', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url === '/api/sentinel/status') return ok(sentinelStatus)
      if (url.startsWith('/api/sentinel/alerts')) throw new Error('offline')
      return ok({})
    }))
    render(<SentinelDashboard />)

    expect(await screen.findByText('Could not load alerts.')).toBeTruthy()
    expect(screen.queryByText(/No alerts yet/)).toBeNull()
  })

  it('keeps the selected filter when an older alerts response lands last', async () => {
    let releaseAll
    vi.stubGlobal('fetch', vi.fn((url) => {
      if (url === '/api/sentinel/status') return Promise.resolve(ok(sentinelStatus))
      if (url === '/api/sentinel/alerts') {
        return new Promise(resolve => { releaseAll = () => resolve(ok({ alerts: [{ id: 'a', severity: 'info', title: 'Info alert' }], items: [{ id: 'a', severity: 'info', title: 'Info alert' }] })) })
      }
      if (url === '/api/sentinel/alerts?severity=critical') {
        return Promise.resolve(ok({ alerts: [{ id: 'c', severity: 'critical', title: 'Critical alert' }], items: [{ id: 'c', severity: 'critical', title: 'Critical alert' }] }))
      }
      return Promise.resolve(ok({}))
    }))
    render(<SentinelDashboard />)
    await waitFor(() => expect(releaseAll).toBeTypeOf('function'))

    fireEvent.change(screen.getByRole('combobox', { name: 'Alert filter' }), { target: { value: 'critical' } })
    expect(await screen.findByText('Critical alert')).toBeTruthy()
    releaseAll()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(screen.queryByText('Info alert')).toBeNull()
    expect(screen.getByText('Critical alert')).toBeTruthy()
  })
})

describe('UpDown dashboard failed status read', () => {
  it('shows an error with Retry instead of a stopped engine and empty contract', async () => {
    let down = true
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url === '/api/updown/status') {
        return down ? unavailable : ok({ success: true, running: true, contract: { target: 70000, stop: 65000, range: 500, direction: 'up' }, position: null })
      }
      if (url === '/api/updown/trades') return ok({ success: true, trades: [], items: [], summary: null })
      if (url === '/api/updown/signals') return ok({ signals: [] })
      if (url === '/api/updown/providers') return ok({ success: true, providers: [] })
      return ok({})
    }))
    render(<BrowserRouter><UpDownDashboard /></BrowserRouter>)

    expect((await screen.findByRole('alert')).textContent).toContain('Could not load UpDown status.')
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull()

    down = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeTruthy()
    expect(screen.queryByText('Could not load UpDown status.')).toBeNull()
  })
})
