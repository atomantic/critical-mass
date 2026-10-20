import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import SentinelDashboard from '../src/components/sentinel/Dashboard.jsx'

vi.mock('../src/hooks/useSentinelSocket.js', () => ({
  default: () => ({ connected: true, latestAlert: null }),
}))

const sentinelStatus = {
  running: true,
  config: { enabled: true, feeds: [{ name: 'Market News', url: 'https://news.example/rss', enabled: true }] },
  pollCount: 1,
  totalAlerts: 1,
  activeAlerts: 1,
}
const sentinelAlert = { id: 'alert-1', severity: 'warning', source: 'Market News', title: 'Test alert', publishedAt: Date.now() }

function success(body = {}) { return { ok: true, status: 200, json: async () => body } }
function failure(status, body) { return { ok: false, status, json: async () => body } }

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (url === '/api/sentinel/status') return success(sentinelStatus)
    if (url.startsWith('/api/sentinel/alerts')) return success({ alerts: [sentinelAlert] })
    return success()
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })

async function renderDashboard() {
  render(<SentinelDashboard />)
  await screen.findByRole('heading', { name: 'News Sentinel' })
  await screen.findByText('Test alert')
}

describe('Sentinel dashboard failed writes', () => {
  it('shows a rejected feed error and preserves the typed name and URL', async () => {
    await renderDashboard()
    fetch.mockImplementation(async (url, options) => {
      if (url === '/api/sentinel/config' && options?.method === 'PUT') return failure(400, { errors: ['Feed URL resolves to a private address'] })
      if (url === '/api/sentinel/status') return success(sentinelStatus)
      if (url.startsWith('/api/sentinel/alerts')) return success({ alerts: [sentinelAlert] })
      return success()
    })

    fireEvent.change(screen.getByRole('textbox', { name: 'Feed name' }), { target: { value: 'Private feed' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'RSS feed URL' }), { target: { value: 'http://127.0.0.1/rss' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add Feed' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Feed URL resolves to a private address')
    expect(screen.getByRole('textbox', { name: 'Feed name' }).value).toBe('Private feed')
    expect(screen.getByRole('textbox', { name: 'RSS feed URL' }).value).toBe('http://127.0.0.1/rss')
  })

  it('keeps an alert active after the server rejects its dismissal', async () => {
    await renderDashboard()
    fetch.mockImplementation(async (url) => {
      if (url === '/api/sentinel/dismiss/alert-1') return failure(404, { error: 'Alert not found' })
      if (url === '/api/sentinel/status') return success(sentinelStatus)
      if (url.startsWith('/api/sentinel/alerts')) return success({ alerts: [sentinelAlert] })
      return success()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Alert not found')
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
  })

  it('keeps alerts visible when the confirmed clear fails', async () => {
    await renderDashboard()
    fetch.mockImplementation(async (url, options) => {
      if (url === '/api/sentinel/alerts' && options?.method === 'DELETE') return failure(503, { error: 'Storage unavailable' })
      if (url === '/api/sentinel/status') return success(sentinelStatus)
      if (url.startsWith('/api/sentinel/alerts')) return success({ alerts: [sentinelAlert] })
      return success()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Clear all alerts' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Clear alerts' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Storage unavailable')
    expect(screen.getByText('Test alert')).toBeTruthy()
  })

  it('re-enables Force Poll when the request rejects', async () => {
    await renderDashboard()
    fetch.mockImplementation(async (url) => {
      if (url === '/api/sentinel/poll') throw new Error('Gateway restarting')
      if (url === '/api/sentinel/status') return success(sentinelStatus)
      if (url.startsWith('/api/sentinel/alerts')) return success({ alerts: [sentinelAlert] })
      return success()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Force Poll' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Force Poll' }).disabled).toBe(false))
    expect(screen.getByRole('alert').textContent).toContain('Gateway restarting')
  })

  it('disables feed writes until the previous config write and refresh finish', async () => {
    await renderDashboard()
    let resolveWrite
    fetch.mockImplementation(async (url) => {
      if (url === '/api/sentinel/config') return new Promise(resolve => { resolveWrite = resolve })
      if (url === '/api/sentinel/status') return success(sentinelStatus)
      if (url.startsWith('/api/sentinel/alerts')) return success({ alerts: [sentinelAlert] })
      return success()
    })

    fireEvent.click(screen.getByRole('switch', { name: 'Enable Market News feed' }))
    await waitFor(() => expect(resolveWrite).toBeTypeOf('function'))
    expect(screen.getByRole('button', { name: 'Remove Market News feed' }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Add Feed' }).disabled).toBe(true)
    resolveWrite(success())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove Market News feed' }).disabled).toBe(false))
  })

  it('keeps an accepted feed change as the source for the next write when refresh fails', async () => {
    await renderDashboard()
    let refreshFails = false
    const writes = []
    fetch.mockImplementation(async (url, options) => {
      if (url === '/api/sentinel/config' && options?.method === 'PUT') {
        const config = JSON.parse(options.body)
        writes.push(config)
        refreshFails = true
        return success({ config: { ...sentinelStatus.config, ...config } })
      }
      if (url === '/api/sentinel/status' && refreshFails) throw new Error('Status unavailable')
      if (url === '/api/sentinel/status') return success(sentinelStatus)
      if (url.startsWith('/api/sentinel/alerts')) return success({ alerts: [sentinelAlert] })
      return success()
    })

    fireEvent.click(screen.getByRole('switch', { name: 'Enable Market News feed' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove Market News feed' }).disabled).toBe(false))
    fireEvent.click(screen.getByRole('switch', { name: 'Enable Market News feed' }))
    await waitFor(() => expect(writes).toHaveLength(2))

    expect(writes[1].feeds).toEqual([{ name: 'Market News', url: 'https://news.example/rss', enabled: true }])
  })
})
