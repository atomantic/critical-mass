import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ContractSetup from '../src/components/updown/ContractSetup'

const deferred = () => {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

describe('ContractSetup screenshot request ownership', () => {
  beforeEach(() => {
    const values = new Map([['updown-screenshot-provider', 'provider-a'], ['updown-screenshot-model', 'model-a']])
    vi.stubGlobal('localStorage', { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) })
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('lets only the latest overlapping analysis set preview and busy state', async () => {
    const requests = []
    vi.stubGlobal('fetch', vi.fn((url, options = {}) => {
      if (url === '/api/updown/providers') return Promise.resolve({ json: async () => ({ success: true, providers: [{ id: 'provider-a', models: ['model-a', 'model-b'] }] }) })
      const pending = deferred()
      requests.push({ ...pending, signal: options.signal })
      return pending.promise
    }))
    render(<ContractSetup />)
    const input = document.querySelector('input[type="file"]')
    const file = (name) => new File([name], `${name}.png`, { type: 'image/png' })
    fireEvent.change(input, { target: { files: [file('first')] } })
    fireEvent.change(input, { target: { files: [file('second')] } })
    expect(requests).toHaveLength(2)
    expect(requests[0].signal.aborted).toBe(true)

    requests[0].resolve({ ok: true, json: async () => ({ success: true, extracted: { target: 111 } }) })
    await waitFor(() => expect(screen.getByText('Analyzing screenshot...')).toBeTruthy())
    expect(screen.queryByText('$111')).toBeNull()
    requests[1].resolve({ ok: true, json: async () => ({ success: true, extracted: { target: 222 } }) })
    await screen.findByText('$222')
    await waitFor(() => expect(screen.getByText('$222')).toBeTruthy())
    expect(screen.queryByText('$111')).toBeNull()
    expect(screen.queryByText('Analyzing screenshot...')).toBeNull()
  })

  it('keeps the newer preview when its older predecessor resolves late', async () => {
    const requests = []
    vi.stubGlobal('fetch', vi.fn((url, options = {}) => {
      if (url === '/api/updown/providers') return Promise.resolve({ json: async () => ({ success: true, providers: [{ id: 'provider-a', models: ['model-a', 'model-b'] }] }) })
      const pending = deferred()
      requests.push({ ...pending, signal: options.signal })
      return pending.promise
    }))
    render(<ContractSetup />)
    const input = document.querySelector('input[type="file"]')
    const file = name => new File([name], `${name}.png`, { type: 'image/png' })
    fireEvent.change(input, { target: { files: [file('first')] } })
    fireEvent.change(input, { target: { files: [file('second')] } })

    requests[1].resolve({ ok: true, json: async () => ({ success: true, extracted: { target: 222 } }) })
    await screen.findByText('$222')
    await act(async () => {
      requests[0].resolve({ ok: true, json: async () => ({ success: true, extracted: { target: 111 } }) })
      await requests[0].promise
    })
    await waitFor(() => expect(screen.getByText('$222')).toBeTruthy())
    expect(screen.queryByText('$111')).toBeNull()
  })

  it('aborts a pending analysis when provider context changes', async () => {
    const pending = deferred()
    let requestSignal
    vi.stubGlobal('fetch', vi.fn((url, options = {}) => {
      if (url === '/api/updown/providers') return Promise.resolve({ json: async () => ({ success: true, providers: [{ id: 'provider-a', models: ['model-a'] }, { id: 'provider-b', models: ['model-b'] }] }) })
      requestSignal = options.signal
      return pending.promise
    }))
    render(<ContractSetup />)
    const input = document.querySelector('input[type="file"]')
    fireEvent.change(input, { target: { files: [new File(['x'], 'x.png', { type: 'image/png' })] } })
    await waitFor(() => expect(requestSignal).toBeTruthy())
    fireEvent.change(screen.getByLabelText('AI Provider'), { target: { value: 'provider-b' } })
    await waitFor(() => expect(requestSignal.aborted).toBe(true))
    await act(async () => {
      pending.resolve({ ok: true, json: async () => ({ success: true, extracted: { target: 111 } }) })
      await pending.promise
    })
    expect(screen.queryByText('$111')).toBeNull()
  })

  it('aborts a pending analysis when the component unmounts', async () => {
    let requestSignal
    vi.stubGlobal('fetch', vi.fn((url, options = {}) => {
      if (url === '/api/updown/providers') return Promise.resolve({ json: async () => ({ success: true, providers: [{ id: 'provider-a', models: ['model-a'] }] }) })
      requestSignal = options.signal
      return new Promise(() => {})
    }))
    const { unmount } = render(<ContractSetup />)
    fireEvent.change(document.querySelector('input[type="file"]'), { target: { files: [new File(['x'], 'x.png', { type: 'image/png' })] } })
    await waitFor(() => expect(requestSignal).toBeTruthy())
    unmount()
    expect(requestSignal.aborted).toBe(true)
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function mockFetchForSave(saveResponse) {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
  vi.stubGlobal('fetch', vi.fn((url) => {
    if (url === '/api/updown/providers') {
      return Promise.resolve({ json: async () => ({ success: false }) })
    }
    return saveResponse()
  }))
}

describe('ContractSetup save feedback', () => {
  it('shows the server validation error and re-enables Save', async () => {
    mockFetchForSave(() => Promise.resolve({
      ok: false,
      json: async () => ({ error: 'stop must be a positive number' }),
    }))
    render(<ContractSetup />)

    fireEvent.click(screen.getByRole('button', { name: 'Save Contract' }))

    expect((await screen.findByRole('alert')).textContent).toContain('stop must be a positive number')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save Contract' }).disabled).toBe(false))
  })

  it('shows a network error and re-enables Save when fetch rejects', async () => {
    mockFetchForSave(() => Promise.reject(new Error('gateway unavailable')))
    render(<ContractSetup />)

    fireEvent.click(screen.getByRole('button', { name: 'Save Contract' }))

    expect((await screen.findByRole('alert')).textContent).toContain('gateway unavailable')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save Contract' }).disabled).toBe(false))
  })

  it('keeps the Saved confirmation on success', async () => {
    mockFetchForSave(() => Promise.resolve({ ok: true }))
    render(<ContractSetup />)

    fireEvent.click(screen.getByRole('button', { name: 'Save Contract' }))

    expect(await screen.findByRole('button', { name: 'Saved' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
