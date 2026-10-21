import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import KeysConfig from '../src/components/KeysConfig'
import NotificationsConfig from '../src/components/NotificationsConfig'
import AIProviders from '../src/components/ai/Providers'

vi.mock('../src/components/Toast', () => ({ useToast: () => ({ addToast: vi.fn() }) }))

// jsdom does not implement <dialog> modality; the provider form relies on it.
HTMLDialogElement.prototype.showModal = function () { this.open = true }
HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')) }

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const ok = body => ({ ok: true, status: 200, json: async () => body })

describe('KeysConfig Test Connection', () => {
  it('waits for typed keys to be saved instead of vouching for the stored ones', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ configured: true, fields: {} })))
    render(<KeysConfig exchange="gemini" funds={[]} />)
    const test = await screen.findByRole('button', { name: 'Test Connection' })
    expect(test.disabled).toBe(false)

    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'new-key' } })
    expect(test.disabled).toBe(true)
    expect(screen.getByText('Save the new keys to test them.')).toBeTruthy()
  })

  it('drops a result that lands after the keys on screen changed', async () => {
    let finishTest
    vi.stubGlobal('fetch', vi.fn(url => url.endsWith('/test-connection')
      ? new Promise(resolve => { finishTest = () => resolve(ok({ success: true, balance: { available: 1 } })) })
      : Promise.resolve(ok({ configured: true, fields: {} }))))
    render(<KeysConfig exchange="gemini" funds={[]} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Test Connection' }))
    await waitFor(() => expect(finishTest).toBeTypeOf('function'))

    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'new-key' } })
    finishTest()
    await screen.findByRole('button', { name: 'Test Connection' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(screen.queryByText(/Connected to Gemini/)).toBeNull()
  })
})

describe('NotificationsConfig', () => {
  const savedConfig = () => ({
    enabled: true,
    telegram: { botToken: '••••••••', chatId: '12345' },
    events: { error: true },
    rateLimitMs: 1000,
    dailySummaryHour: 8,
    quietHours: { enabled: false, start: 23, end: 7 },
  })

  it('keeps the configured-token hint after a rejected save and blocks Send Test on unsaved edits', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      if (url === '/api/notifications/config' && options?.method === 'PUT') {
        return { ok: false, status: 400, json: async () => ({ errors: ['chatId is invalid'] }) }
      }
      if (url === '/api/notifications/config') return ok(savedConfig())
      return ok({ isRunning: true })
    }))
    render(<NotificationsConfig />)
    expect(await screen.findByText('Token configured (masked). Enter a new value to change.')).toBeTruthy()
    const sendTest = screen.getByRole('button', { name: 'Send Test' })
    expect(sendTest.disabled).toBe(false)

    fireEvent.change(screen.getByLabelText('Chat ID'), { target: { value: 'not-a-chat' } })
    expect(sendTest.disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('chatId is invalid')).toBeTruthy()
    expect(screen.getByText('Token configured (masked). Enter a new value to change.')).toBeTruthy()
    const body = JSON.parse(fetch.mock.calls.find(([, options]) => options?.method === 'PUT')[1].body)
    expect(body.telegram).toEqual({ chatId: 'not-a-chat' })
  })
})

describe('AI provider form', () => {
  it('keeps the same model-tier input while typing', async () => {
    vi.stubGlobal('fetch', vi.fn(async url => {
      if (url === '/api/providers') return ok({ providers: [], activeProvider: null })
      return ok({ runs: [] })
    }))
    render(<AIProviders />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add Provider' }))

    const light = screen.getByLabelText('Light (fast)')
    fireEvent.change(light, { target: { value: 'model-a' } })
    expect(screen.getByLabelText('Light (fast)')).toBe(light)
    expect(light.value).toBe('model-a')
  })
})
