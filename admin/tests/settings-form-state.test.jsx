import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithToasts as render } from './renderWithToasts'
import KeysConfig from '../src/components/KeysConfig'
import NotificationsConfig from '../src/components/NotificationsConfig'
import AIProviders from '../src/components/ai/Providers'


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

  it.each([
    ['Gemini text and password inputs', 'gemini', [['API Key', 'new-key'], ['API Secret', 'new-secret']]],
    ['Coinbase text input and private-key textarea', 'coinbase', [['API Key Name', 'new-name'], ['Private Key', 'new-private-key']]],
    ['Crypto.com text and password inputs', 'cryptocom', [['API Key', 'new-key'], ['API Secret', 'new-secret']]],
  ])('locks %s through save and metadata refresh', async (_name, exchange, values) => {
    const inputFor = label => screen.getByLabelText(label === 'API Key' ? /^API Key/ : label === 'API Secret' ? /^API Secret/ : label)
    const saveButton = () => screen.getByRole('button', { name: /^(Save Keys|Saving\.\.\.)$/ })
    let finishSave
    let finishRefresh
    let keyReads = 0
    const fetchMock = vi.fn((url, options) => {
      if (options?.method === 'PUT') {
        return new Promise(resolve => { finishSave = () => resolve(ok({})) })
      }
      if (url === `/api/${exchange}/keys` && ++keyReads > 1) {
        return new Promise(resolve => { finishRefresh = () => resolve(ok({ configured: true, fields: { apiKey: true } })) })
      }
      return Promise.resolve(ok({ configured: true, fields: { apiKey: true } }))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<KeysConfig exchange={exchange} funds={[]} />)
    await screen.findByRole('button', { name: 'Test Connection' })

    for (const [label, value] of values) fireEvent.change(inputFor(label), { target: { value } })
    const save = saveButton()
    fireEvent.click(save)
    await waitFor(() => expect(finishSave).toBeTypeOf('function'))

    for (const [label] of values) expect(inputFor(label).disabled).toBe(true)
    expect(save.disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Delete Keys' }).disabled).toBe(true)
    // React's disabled attribute is the user-facing guard; the ref also rejects
    // same-turn re-entry before React commits the state update.
    fireEvent.click(save)
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1)
    fireEvent.change(inputFor(values[0][0]), { target: { value: 'later-edit' } })
    expect(inputFor(values[0][0]).value).toBe(values[0][1])

    finishSave()
    await waitFor(() => expect(finishRefresh).toBeTypeOf('function'))
    for (const [label] of values) expect(inputFor(label).disabled).toBe(true)
    expect(saveButton().disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Delete Keys' }).disabled).toBe(true)
    for (const [label] of values) expect(inputFor(label).value).toBe(values.find(([candidate]) => candidate === label)[1])

    finishRefresh()
    await waitFor(() => expect(inputFor(values[0][0]).disabled).toBe(false))
    for (const [label] of values) expect(inputFor(label).value).toBe('')
  })

  it('retains credentials and allows retry when save fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => options?.method === 'PUT'
      ? { ok: false, status: 400, json: async () => ({ error: 'Rejected' }) }
      : ok({ configured: false, fields: {} })))
    render(<KeysConfig exchange="gemini" funds={[]} />)
    await screen.findByRole('button', { name: 'Test Connection' })
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'retry-key' } })
    fireEvent.change(screen.getByLabelText('API Secret'), { target: { value: 'retry-secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Keys' }))

    await screen.findByText(/Rejected/)
    expect(screen.getByLabelText('API Key').value).toBe('retry-key')
    expect(screen.getByLabelText('API Secret').value).toBe('retry-secret')
    expect(screen.getByRole('button', { name: 'Save Keys' }).disabled).toBe(false)
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

  it('shows error when Send Test returns HTTP 200 with success: false', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      if (url === '/api/notifications/test' && options?.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ success: false, error: 'Telegram bot blocked by user' }) }
      }
      if (url === '/api/notifications/config') return ok(savedConfig())
      return ok({ isRunning: true })
    }))
    render(<NotificationsConfig />)
    const sendTest = await screen.findByRole('button', { name: 'Send Test' })
    expect(sendTest.disabled).toBe(false)

    fireEvent.click(sendTest)
    expect(await screen.findByText('Test failed: Telegram bot blocked by user')).toBeTruthy()
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
