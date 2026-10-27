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
      if (url === '/api/updown/providers') return Promise.resolve({ ok: true, json: async () => ({ success: true, providers: [{ id: 'provider-a', models: ['model-a', 'model-b'] }] }) })
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
      if (url === '/api/updown/providers') return Promise.resolve({ ok: true, json: async () => ({ success: true, providers: [{ id: 'provider-a', models: ['model-a', 'model-b'] }] }) })
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
      if (url === '/api/updown/providers') return Promise.resolve({ ok: true, json: async () => ({ success: true, providers: [{ id: 'provider-a', models: ['model-a'] }, { id: 'provider-b', models: ['model-b'] }] }) })
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
      if (url === '/api/updown/providers') return Promise.resolve({ ok: true, json: async () => ({ success: true, providers: [{ id: 'provider-a', models: ['model-a'] }] }) })
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
  vi.stubGlobal('fetch', vi.fn((url, options) => {
    if (url === '/api/updown/providers') {
      return Promise.resolve({ ok: true, json: async () => ({ success: true, providers: [] }) })
    }
    return saveResponse(url, options)
  }))
}

describe('ContractSetup save feedback', () => {
  it('keeps a second save\'s "Saved" for its full two seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      mockFetchForSave(() => Promise.resolve({ ok: true, json: async () => ({ success: true }) }))
      render(<ContractSetup />)
      const save = () => act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save Contract|Saved/ })) })

      await save()
      await act(async () => { vi.advanceTimersByTime(1500) })
      await save()
      await act(async () => { vi.advanceTimersByTime(1000) })
      expect(screen.getByRole('button', { name: 'Saved' })).toBeTruthy()
      await act(async () => { vi.advanceTimersByTime(1000) })
      expect(screen.getByRole('button', { name: 'Save Contract' })).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

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
    mockFetchForSave(() => Promise.resolve({ ok: true, json: async () => ({ success: true }) }))
    render(<ContractSetup />)

    fireEvent.click(screen.getByRole('button', { name: 'Save Contract' }))

    expect(await screen.findByRole('button', { name: 'Saved' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('ContractSetup failure recovery', () => {
  it('reports a failed AI provider list with Retry instead of an empty dropdown', async () => {
    let down = true
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url !== '/api/updown/providers') throw new Error(`unexpected ${url}`)
      if (down) return { ok: false, status: 502, json: async () => { throw new Error('not json') } }
      return { ok: true, json: async () => ({ success: true, providers: [{ id: 'provider-a', name: 'Provider A', models: ['model-a'] }] }) }
    }))
    render(<ContractSetup />)

    expect((await screen.findByRole('alert')).textContent).toContain('Could not load AI providers (The server rejected the request (HTTP 502)')
    down = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('option', { name: 'Provider A' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('re-enables Save and explains the unsaved form when Apply cannot reach the server', async () => {
    const values = new Map([['updown-screenshot-provider', 'provider-a']])
    vi.stubGlobal('localStorage', { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) })
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url === '/api/updown/providers') return { ok: true, json: async () => ({ success: true, providers: [{ id: 'provider-a', models: ['model-a'] }] }) }
      if (url.startsWith('/api/updown/screenshot')) return { ok: true, json: async () => ({ success: true, extracted: { screenType: 'select', target: 70000, stop: 65000, range: 500, direction: 'Up' } }) }
      if (url === '/api/updown/contract') throw new Error('gateway unavailable')
      throw new Error(`unexpected ${url}`)
    }))
    render(<ContractSetup />)
    fireEvent.change(document.querySelector('input[type="file"]'), { target: { files: [new File(['x'], 'x.png', { type: 'image/png' })] } })
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }))

    expect((await screen.findByRole('alert')).textContent).toContain('gateway unavailable')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save Contract' }).disabled).toBe(false))
    expect(screen.getByText(/applied to the form but not saved/)).toBeTruthy()
    expect(screen.getByLabelText(/Target/).value).toBe('70000')
  })
})

describe('ContractSetup draft revision and server readback transitions', () => {
  it('preserves newer edits when a held save resolves and its readback is delivered', async () => {
    const put = deferred()
    mockFetchForSave((url) => {
      if (url === '/api/updown/contract') return put.promise
      throw new Error(`unexpected ${url}`)
    })

    const initial = {
      expiry: '2026-02-21T00:00:00.000Z',
      target: 100000,
      stop: 95000,
      range: 500,
      direction: 'up',
    }

    const { rerender } = render(<ContractSetup initialContract={initial} />)
    expect(screen.getByLabelText(/Target/).value).toBe('100000')

    // Edit target to 110000 and initiate save
    fireEvent.change(screen.getByLabelText(/Target/), { target: { value: '110000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Contract' }))

    // Save is now held (pending)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Saving...' })).toBeTruthy())

    // Edit target/stop/expiry/direction while save is held
    fireEvent.change(screen.getByLabelText(/Target/), { target: { value: '120000' } })
    fireEvent.change(screen.getByLabelText(/Stop/), { target: { value: '96000' } })
    fireEvent.change(screen.getByLabelText(/Expiry/), { target: { value: '2026-02-22T00:00:00.000Z' } })
    fireEvent.click(screen.getByRole('button', { name: 'Down' }))

    // Resolve the held save
    await act(async () => {
      put.resolve({ ok: true, json: async () => ({ success: true }) })
      await put.promise
    })

    // Saved should NOT be shown because newer edits exist
    expect(screen.queryByRole('button', { name: 'Saved' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Save Contract' })).toBeTruthy()

    // Deliver status readback matching what was saved on the server
    const readback = {
      expiry: '2026-02-21T00:00:00.000Z',
      target: 110000,
      stop: 95000,
      range: 500,
      direction: 'up',
    }
    rerender(<ContractSetup initialContract={readback} />)

    // The newer edits made during the save must survive
    expect(screen.getByLabelText(/Target/).value).toBe('120000')
    expect(screen.getByLabelText(/Stop/).value).toBe('96000')
    expect(screen.getByLabelText(/Expiry/).value).toBe('2026-02-22T00:00:00.000Z')
    expect(screen.getByRole('button', { name: 'Down' }).className).toContain('bg-')
  })

  it('preserves edits made after successful save but before the next status poll', async () => {
    mockFetchForSave((url) => {
      if (url === '/api/updown/contract') return Promise.resolve({ ok: true, json: async () => ({ success: true }) })
      throw new Error(`unexpected ${url}`)
    })

    const initial = { target: 100000, stop: 95000, range: 500, direction: 'up', expiry: '' }
    const { rerender } = render(<ContractSetup initialContract={initial} />)

    fireEvent.change(screen.getByLabelText(/Target/), { target: { value: '110000' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Contract' }))
    })

    expect(await screen.findByRole('button', { name: 'Saved' })).toBeTruthy()

    // Make an edit after PUT settled, before poll arrives
    fireEvent.change(screen.getByLabelText(/Target/), { target: { value: '130000' } })
    // Saved confirmation disappears immediately
    expect(screen.queryByRole('button', { name: 'Saved' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Save Contract' })).toBeTruthy()

    // Status poll arrives with the saved contract
    rerender(<ContractSetup initialContract={{ target: 110000, stop: 95000, range: 500, direction: 'up', expiry: '' }} />)

    // Newer edit survives
    expect(screen.getByLabelText(/Target/).value).toBe('130000')
  })

  it('never shows Saved for an unsent or modified draft', async () => {
    const put = deferred()
    mockFetchForSave((url) => {
      if (url === '/api/updown/contract') return put.promise
      throw new Error(`unexpected ${url}`)
    })

    render(<ContractSetup initialContract={{ target: 100000 }} />)

    // Edit target and save
    fireEvent.change(screen.getByLabelText(/Target/), { target: { value: '110000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Contract' }))

    // While saving, modify target again
    fireEvent.change(screen.getByLabelText(/Target/), { target: { value: '115000' } })

    // Resolve PUT
    await act(async () => {
      put.resolve({ ok: true, json: async () => ({ success: true }) })
      await put.promise
    })

    // Button must present unsaved state ("Save Contract"), not "Saved"
    expect(screen.queryByRole('button', { name: 'Saved' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Save Contract' })).toBeTruthy()
  })

  it('adopts a genuinely changed server contract on a pristine form, and ignores polls when dirty', async () => {
    const initial = { target: 100000, stop: 95000, range: 500, direction: 'up', expiry: '' }
    const { rerender } = render(<ContractSetup initialContract={initial} />)

    expect(screen.getByLabelText(/Target/).value).toBe('100000')

    // Pristine form adopts genuinely changed server contract
    const changed = { target: 200000, stop: 190000, range: 2000, direction: 'down', expiry: '' }
    rerender(<ContractSetup initialContract={changed} />)
    expect(screen.getByLabelText(/Target/).value).toBe('200000')
    expect(screen.getByLabelText(/Stop/).value).toBe('190000')
    expect(screen.getByLabelText(/Range/).value).toBe('2000')

    // Make an edit -> form is dirty
    fireEvent.change(screen.getByLabelText(/Target/), { target: { value: '250000' } })
    expect(screen.getByLabelText(/Target/).value).toBe('250000')

    // Repeated identical poll does not disturb edit
    rerender(<ContractSetup initialContract={changed} />)
    expect(screen.getByLabelText(/Target/).value).toBe('250000')

    // Another poll with different contract does not overwrite unsaved dirty draft
    rerender(<ContractSetup initialContract={{ target: 300000, stop: 190000, range: 2000, direction: 'down', expiry: '' }} />)
    expect(screen.getByLabelText(/Target/).value).toBe('250000')
  })

  it('serializes Save and screenshot Apply through a synchronous write guard, and preserves retry payload on failure', async () => {
    const put = deferred()
    const putCalls = []
    mockFetchForSave((url, options) => {
      if (url === '/api/updown/contract') {
        putCalls.push(options)
        return put.promise
      }
      throw new Error(`unexpected ${url}`)
    })

    render(<ContractSetup initialContract={{ target: 100000 }} />)

    // Start Save
    fireEvent.change(screen.getByLabelText(/Target/), { target: { value: '110000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Contract' }))

    expect(putCalls).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeTruthy()

    // Attempt second Save while first is pending -> write guard blocks overlap
    fireEvent.click(screen.getByRole('button', { name: 'Saving...' }))
    expect(putCalls).toHaveLength(1)

    // Save fails
    await act(async () => {
      put.resolve({ ok: false, status: 500, json: async () => ({ error: 'database down' }) })
      await put.promise
    })

    // Error is shown, Save is re-enabled, draft is preserved for retry
    expect((await screen.findByRole('alert')).textContent).toContain('database down')
    expect(screen.getByLabelText(/Target/).value).toBe('110000')
    expect(screen.getByRole('button', { name: 'Save Contract' }).disabled).toBe(false)
  })

  it('disables screenshot Apply and blocks write overlap while a save is in progress', async () => {
    const values = new Map([
      ['updown-screenshot-provider', 'provider-a'],
      ['updown-screenshot-model', 'model-a'],
    ])
    vi.stubGlobal('localStorage', { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) })

    const put = deferred()
    const putCalls = []
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      if (url === '/api/updown/providers') return { ok: true, json: async () => ({ success: true, providers: [{ id: 'provider-a', models: ['model-a'] }] }) }
      if (url.startsWith('/api/updown/screenshot')) return { ok: true, json: async () => ({ success: true, extracted: { screenType: 'select', target: 80000, stop: 75000, range: 500, direction: 'Up' } }) }
      if (url === '/api/updown/contract') {
        putCalls.push(options)
        return put.promise
      }
      throw new Error(`unexpected ${url}`)
    }))

    render(<ContractSetup initialContract={{ target: 100000 }} />)

    // Upload screenshot to get preview
    fireEvent.change(document.querySelector('input[type="file"]'), { target: { files: [new File(['x'], 'x.png', { type: 'image/png' })] } })
    const applyButton = await screen.findByRole('button', { name: 'Apply' })
    expect(applyButton).toBeTruthy()

    // Start Save Contract
    fireEvent.change(screen.getByLabelText(/Target/), { target: { value: '110000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Contract' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Saving...' })).toBeTruthy())
    expect(putCalls).toHaveLength(1)
    // Apply button is disabled while saving
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply' }).disabled).toBe(true))

    // Attempting to click Apply does not fire a second PUT
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(putCalls).toHaveLength(1)

    // Resolve Save
    await act(async () => {
      put.resolve({ ok: true, json: async () => ({ success: true }) })
      await put.promise
    })
  })

  it('ignores a stale pre-save status readback after save succeeds on a pristine form', async () => {
    mockFetchForSave((url) => {
      if (url === '/api/updown/contract') return Promise.resolve({ ok: true, json: async () => ({ success: true }) })
      throw new Error(`unexpected ${url}`)
    })

    const initial = { target: 100000, stop: 95000, range: 500, direction: 'up', expiry: '' }
    const { rerender } = render(<ContractSetup initialContract={initial} />)

    // Save target 110000
    fireEvent.change(screen.getByLabelText(/Target/), { target: { value: '110000' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Contract' }))
    })

    expect(await screen.findByRole('button', { name: 'Saved' })).toBeTruthy()
    expect(screen.getByLabelText(/Target/).value).toBe('110000')

    // An in-flight or older poll delivers pre-save contract (target 100000)
    rerender(<ContractSetup initialContract={initial} />)

    // Stale pre-save response must NOT overwrite saved 110000
    expect(screen.getByLabelText(/Target/).value).toBe('110000')

    // Status poll acknowledges saved contract (target 110000)
    rerender(<ContractSetup initialContract={{ target: 110000, stop: 95000, range: 500, direction: 'up', expiry: '' }} />)
    expect(screen.getByLabelText(/Target/).value).toBe('110000')

    // Later genuinely changed contract from another client (target 200000) is adopted on pristine form
    rerender(<ContractSetup initialContract={{ target: 200000, stop: 95000, range: 500, direction: 'up', expiry: '' }} />)
    expect(screen.getByLabelText(/Target/).value).toBe('200000')
  })

  it('updates both form display and draft when screenshot extracted values contain zero', async () => {
    const values = new Map([
      ['updown-screenshot-provider', 'provider-a'],
      ['updown-screenshot-model', 'model-a'],
    ])
    vi.stubGlobal('localStorage', { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) })

    let submittedBody = null
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      if (url === '/api/updown/providers') return { ok: true, json: async () => ({ success: true, providers: [{ id: 'provider-a', models: ['model-a'] }] }) }
      if (url.startsWith('/api/updown/screenshot')) return { ok: true, json: async () => ({ success: true, extracted: { screenType: 'select', target: 0, stop: 0, range: 500, direction: 'Down' } }) }
      if (url === '/api/updown/contract') {
        submittedBody = JSON.parse(options.body)
        return { ok: true, json: async () => ({ success: true }) }
      }
      throw new Error(`unexpected ${url}`)
    }))

    render(<ContractSetup initialContract={{ target: 100000, stop: 95000 }} />)

    // Upload screenshot and Apply preview with target: 0 and stop: 0
    fireEvent.change(document.querySelector('input[type="file"]'), { target: { files: [new File(['x'], 'x.png', { type: 'image/png' })] } })
    const applyButton = await screen.findByRole('button', { name: 'Apply' })
    await act(async () => {
      fireEvent.click(applyButton)
    })

    // Displayed input values must synchronize with zero
    expect(screen.getByLabelText(/Target/).value).toBe('0')
    expect(screen.getByLabelText(/Stop/).value).toBe('0')
    expect(submittedBody).toEqual(expect.objectContaining({ target: 0, stop: 0, direction: 'down' }))
  })

  it('matches canonical numeric representation between form draft and server readback', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url === '/api/updown/providers') return { ok: true, json: async () => ({ success: true, providers: [] }) }
      if (url === '/api/updown/contract') return { ok: true, json: async () => ({ success: true }) }
      throw new Error(`unexpected ${url}`)
    }))

    const initial = { target: 100000, stop: 95000, range: 500, direction: 'up', expiry: '' }
    const { rerender } = render(<ContractSetup initialContract={initial} />)

    // User inputs decimal notation '110000.0'
    fireEvent.change(screen.getByLabelText(/Target/), { target: { value: '110000.0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Contract' }))

    expect(await screen.findByRole('button', { name: 'Saved' })).toBeTruthy()

    // Status poll delivers integer 110000
    rerender(<ContractSetup initialContract={{ target: 110000, stop: 95000, range: 500, direction: 'up', expiry: '' }} />)

    // Form value remains intact and ack gate is cleared
    expect(screen.getByLabelText(/Target/).value).toBe('110000.0')

    // Subsequent genuine change on pristine form is adopted
    rerender(<ContractSetup initialContract={{ target: 130000, stop: 95000, range: 500, direction: 'up', expiry: '' }} />)
    expect(screen.getByLabelText(/Target/).value).toBe('130000')
  })

  it('reconciles superseding server update before polling observes the saved value', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url === '/api/updown/providers') return { ok: true, json: async () => ({ success: true, providers: [] }) }
      if (url === '/api/updown/contract') return { ok: true, json: async () => ({ success: true }) }
      throw new Error(`unexpected ${url}`)
    }))

    const initial = { target: 100000, stop: 95000, range: 500, direction: 'up', expiry: '' }
    const { rerender } = render(<ContractSetup initialContract={initial} />)

    // User saves 110000
    fireEvent.change(screen.getByLabelText(/Target/), { target: { value: '110000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Contract' }))

    expect(await screen.findByRole('button', { name: 'Saved' })).toBeTruthy()

    // Server was updated out-of-band to 150000 without polling ever seeing 110000
    rerender(<ContractSetup initialContract={{ target: 150000, stop: 95000, range: 500, direction: 'up', expiry: '' }} />)

    // Pristine form adopts superseding update immediately
    expect(screen.getByLabelText(/Target/).value).toBe('150000')
  })
})
