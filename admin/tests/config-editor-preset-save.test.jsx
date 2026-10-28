import React from 'react'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithToasts as render } from './renderWithToasts'
import ConfigEditor from '../src/components/ConfigEditor'

vi.mock('../src/App', () => ({ getBaseCurrency: () => 'BTC', getQuoteCurrency: () => 'USD' }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const initialPresets = {
  conservative: { kFactor: 0.8 },
  moderate: { kFactor: 1 },
  aggressive: { kFactor: 1.2 },
  maximum: { kFactor: 1.4 },
}
const config = { productId: 'BTC-USD', regime: { enabled: false, minOrderSizeUsdc: 5 } }
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const deferred = () => {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}
const editConservativeFactor = () => {
  fireEvent.click(screen.getByRole('button', { name: /Conservative/ }))
  fireEvent.change(screen.getByLabelText('k Factor'), { target: { value: '1.1' } })
}

describe('ConfigEditor preset save lifecycle', () => {
  it('locks only preset controls while saving and adopts the confirmed snapshot on success', async () => {
    const save = deferred()
    const fetchMock = vi.fn(async (url, options = {}) => {
      if (String(url).includes('/presets/aggressiveness') && options.method === 'GET') return response(200, { presets: initialPresets })
      if (String(url).includes('/presets/aggressiveness')) return save.promise
      if (options.method === 'PUT') return response(200, { config })
      return response(200, {})
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ConfigEditor config={config} strategy="regime" />)

    await screen.findByRole('button', { name: /Conservative/ })
    editConservativeFactor()
    fireEvent.click(screen.getByRole('button', { name: /Save Presets/ }))

    const factor = screen.getByLabelText('k Factor')
    expect(factor.matches(':disabled')).toBe(true)
    // The input is disabled by its fieldset, so its own disabled property is
    // already false while the save is still pending.
    expect(factor.disabled).toBe(false)
    expect(screen.getByRole('button', { name: 'Reset' }).matches(':disabled')).toBe(true)
    expect(screen.getByLabelText('Min Order Size ($)').matches(':disabled')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Saving...' }))
    expect(fetchMock.mock.calls.filter(([url, options]) => String(url).includes('/presets/aggressiveness') && options.method === 'PUT')).toHaveLength(1)

    fireEvent.change(screen.getByLabelText('Min Order Size ($)'), { target: { value: '9' } })
    fireEvent.click(screen.getByRole('button', { name: /Save Configuration/ }))
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url, options]) => String(url).includes('/config') && options.method === 'PUT')).toHaveLength(1))

    const confirmed = { ...initialPresets, conservative: { kFactor: 1.1 } }
    save.resolve(response(200, { presets: confirmed }))
    await waitFor(() => {
      const saveButton = screen.getByRole('button', { name: 'Save Presets' })
      expect(saveButton.disabled).toBe(true)
      expect(screen.getByLabelText('k Factor').matches(':disabled')).toBe(false)
    })
    expect(screen.getByLabelText('k Factor').value).toBe('1.1')
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull()
  })

  it('preserves a rejected draft, leaves it dirty, and allows retry after pending ends', async () => {
    const save = deferred()
    let requests = 0
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      if (String(url).includes('/presets/aggressiveness') && options.method === 'GET') return response(200, { presets: initialPresets })
      if (String(url).includes('/presets/aggressiveness')) {
        requests += 1
        return requests === 1 ? save.promise : response(200, { presets: { ...initialPresets, conservative: { kFactor: 1.1 } } })
      }
      return response(200, {})
    }))
    render(<ConfigEditor config={config} strategy="regime" />)

    await screen.findByRole('button', { name: /Conservative/ })
    editConservativeFactor()
    fireEvent.click(screen.getByRole('button', { name: /Save Presets/ }))
    save.resolve(response(400, { errors: ['invalid preset'] }))

    await screen.findByText('invalid preset')
    expect(screen.getByLabelText('k Factor').value).toBe('1.1')
    expect(screen.getByRole('button', { name: /Save Presets/ }).disabled).toBe(false)
    expect(screen.getByRole('button', { name: 'Reset' }).matches(':disabled')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: /Save Presets/ }))
    await waitFor(() => expect(requests).toBe(2))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save Presets' }).disabled).toBe(true))
    expect(screen.getByLabelText('k Factor').value).toBe('1.1')
  })
})
