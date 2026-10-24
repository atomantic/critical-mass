import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithToasts as render } from './renderWithToasts'
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

// jsdom does not implement <dialog> modality; the destructive confirmation relies on it.
HTMLDialogElement.prototype.showModal = function () { this.open = true; this.querySelector('[autofocus]')?.focus() }
HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')) }

function success(body = {}) { return { ok: true, status: 200, json: async () => body } }
function failure(status, body) { return { ok: false, status, json: async () => body } }

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (url === '/api/sentinel/status') return success(sentinelStatus)
    if (url.startsWith('/api/sentinel/alerts')) return success({ alerts: [sentinelAlert], items: [sentinelAlert] })
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
      if (url.startsWith('/api/sentinel/alerts')) return success({ alerts: [sentinelAlert], items: [sentinelAlert] })
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
      if (url.startsWith('/api/sentinel/alerts')) return success({ alerts: [sentinelAlert], items: [sentinelAlert] })
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
      if (url.startsWith('/api/sentinel/alerts')) return success({ alerts: [sentinelAlert], items: [sentinelAlert] })
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
      if (url.startsWith('/api/sentinel/alerts')) return success({ alerts: [sentinelAlert], items: [sentinelAlert] })
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
      if (url.startsWith('/api/sentinel/alerts')) return success({ alerts: [sentinelAlert], items: [sentinelAlert] })
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
      if (url.startsWith('/api/sentinel/alerts')) return success({ alerts: [sentinelAlert], items: [sentinelAlert] })
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

const stateSaveWarning = 'Config saved and Sentinel restarted, but its alert state could not be written: ENOSPC disk full'

function savedButStateFailed(config) {
  return failure(500, { success: false, config, persistence: { configSaved: true, alertStateSaved: false }, error: stateSaveWarning })
}

function mockSavedConfig({ refreshFails = false } = {}) {
  let config = structuredClone(sentinelStatus.config)
  const writes = []
  fetch.mockImplementation(async (url, options) => {
    if (url === '/api/sentinel/config' && options?.method === 'PUT') {
      const update = JSON.parse(options.body)
      writes.push(update)
      config = { ...config, ...update }
      return savedButStateFailed(config)
    }
    if (url === '/api/sentinel/status') {
      if (refreshFails) throw new Error('Status unavailable')
      return success({ ...sentinelStatus, config })
    }
    if (url.startsWith('/api/sentinel/alerts')) return success({ items: [sentinelAlert] })
    return success()
  })
  return { writes, config: () => config }
}

function addFeed(name) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Feed name' }), { target: { value: name } })
  fireEvent.change(screen.getByRole('textbox', { name: 'RSS feed URL' }), { target: { value: `https://example.com/${name.replaceAll(' ', '-')}` } })
  fireEvent.click(screen.getByRole('button', { name: 'Add Feed' }))
}

async function writesUnlocked() {
  await waitFor(() => expect(screen.getByRole('button', { name: /^(Enable|Disable) service$/ }).disabled).toBe(false))
}

describe('Sentinel configuration partial persistence', () => {
  it.each([false, true])('preserves Feed A when immediately adding Feed B after saved HTTP 500 (refresh fails: %s)', async refreshFails => {
    await renderDashboard()
    const server = mockSavedConfig({ refreshFails })
    addFeed('Feed A')
    await screen.findByRole('button', { name: 'Remove Feed A feed' })
    await writesUnlocked()
    expect(screen.getByRole('textbox', { name: 'Feed name' }).value).toBe('')
    expect(screen.getByRole('textbox', { name: 'RSS feed URL' }).value).toBe('')
    addFeed('Feed B')
    await screen.findByRole('button', { name: 'Remove Feed B feed' })
    await writesUnlocked()
    expect(server.writes[1].feeds.map(feed => feed.name)).toEqual(['Market News', 'Feed A', 'Feed B'])
    expect(server.config().feeds.map(feed => feed.name)).toEqual(['Market News', 'Feed A', 'Feed B'])
    expect(screen.getByText(stateSaveWarning)).toBeTruthy()
    // Ordinary status refreshes must not erase the alert-state warning.
    fireEvent.click(screen.getByRole('button', { name: 'Force Poll' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Force Poll' }).disabled).toBe(false))
    expect(screen.getByText(stateSaveWarning)).toBeTruthy()
  })

  it('adopts saved feed toggles and removes, closes the confirmed removal, and uses the saved list for the next add', async () => {
    await renderDashboard()
    const server = mockSavedConfig({ refreshFails: true })
    fireEvent.click(screen.getByRole('switch', { name: 'Enable Market News feed' }))
    await waitFor(() => expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false'))
    await writesUnlocked()
    addFeed('Feed A')
    await screen.findByRole('button', { name: 'Remove Feed A feed' })
    await writesUnlocked()
    expect(server.writes[1].feeds[0].enabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Market News feed' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove feed' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByRole('button', { name: 'Remove Market News feed' })).toBeNull()
    await writesUnlocked()
    addFeed('Feed B')
    await screen.findByRole('button', { name: 'Remove Feed B feed' })
    expect(server.writes[3].feeds.map(feed => feed.name)).toEqual(['Feed A', 'Feed B'])
    expect(screen.getByText(stateSaveWarning)).toBeTruthy()
  })

  it('uses the saved enabled value for the next service toggle despite failed refreshes', async () => {
    await renderDashboard()
    const server = mockSavedConfig({ refreshFails: true })
    fireEvent.click(screen.getByRole('button', { name: 'Disable service' }))
    await screen.findByRole('button', { name: 'Enable service' })
    await writesUnlocked()
    fireEvent.click(screen.getByRole('button', { name: 'Enable service' }))
    await screen.findByRole('button', { name: 'Disable service' })
    expect(server.writes).toEqual([{ enabled: false }, { enabled: true }])
    expect(screen.getByText(stateSaveWarning)).toBeTruthy()
  })

  it('preserves prior values and keeps the removal dialog open for validation rejections', async () => {
    await renderDashboard()
    const writes = []
    fetch.mockImplementation(async (url, options) => {
      if (url === '/api/sentinel/config') { writes.push(JSON.parse(options.body)); return failure(400, { errors: ['Invalid configuration'] }) }
      if (url === '/api/sentinel/status') return success(sentinelStatus)
      return success({ items: [sentinelAlert] })
    })
    fireEvent.click(screen.getByRole('switch', { name: 'Enable Market News feed' }))
    await writesUnlocked()
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Disable service' }))
    await writesUnlocked()
    expect(screen.getByRole('button', { name: 'Disable service' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Market News feed' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove feed' }))
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('Invalid configuration'))
    expect(screen.getByRole('button', { name: 'Remove Market News feed' })).toBeTruthy()
    expect(writes).toHaveLength(3)
  })

  it.each(['network', 'legacy-500', 'aborted'])('blocks replacement-list writes after an unknown %s outcome until an owned readback succeeds', async outcome => {
    await renderDashboard()
    let config = structuredClone(sentinelStatus.config)
    let readbackFails = true
    let malformedReadback = false
    let resolveOldStatus
    const writes = []
    // Hold a pre-write read, ignoring abort, to exercise the config revision fence.
    fetch.mockImplementation(async (url, options) => {
      if (url === '/api/sentinel/poll') return success()
      if (url === '/api/sentinel/status') return new Promise(resolve => { resolveOldStatus = resolve })
      return success({ items: [sentinelAlert] })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Force Poll' }))
    await waitFor(() => expect(resolveOldStatus).toBeTypeOf('function'))
    fetch.mockImplementation(async (url, options) => {
      if (url === '/api/sentinel/config') {
        const update = JSON.parse(options.body)
        writes.push(update)
        config = { ...config, ...update }
        if (outcome === 'network') throw new Error('Connection lost')
        if (outcome === 'aborted') throw new DOMException('Connection aborted', 'AbortError')
        return failure(500, { error: 'Config saved but restart failed' })
      }
      if (url === '/api/sentinel/status') {
        if (readbackFails) throw new Error('Status unavailable')
        if (malformedReadback) return success({ config: {} })
        return success({ ...sentinelStatus, config })
      }
      return success({ items: [sentinelAlert] })
    })
    addFeed('Feed A')
    await screen.findByText(/Configuration save outcome is unknown/)
    await act(async () => { resolveOldStatus(success(sentinelStatus)); await Promise.resolve() })
    expect(screen.getByRole('button', { name: 'Disable service' }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Remove Market News feed' }).disabled).toBe(true)
    expect(screen.getByRole('switch').disabled).toBe(true)
    addFeed('Feed B')
    expect(writes).toHaveLength(1)
    readbackFails = false
    malformedReadback = true
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole('button', { name: 'Disable service' }).disabled).toBe(true)
    expect(screen.getByText(/Configuration save outcome is unknown/)).toBeTruthy()
    malformedReadback = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByRole('button', { name: 'Remove Feed A feed' })
    await writesUnlocked()
    expect(screen.queryByText(/Configuration save outcome is unknown/)).toBeNull()
    addFeed('Feed B')
    await waitFor(() => expect(writes).toHaveLength(2))
    expect(writes[1].feeds.map(feed => feed.name)).toEqual(['Market News', 'Feed A', 'Feed B'])
  })
})
