import React from 'react'
import { createRequire } from 'node:module'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithToasts as render } from './renderWithToasts'
import ConfigEditor from '../src/components/ConfigEditor'

// Replaces the source-text assertions of tests/config-editor-write-gate.test.js
// (issues #455, #868, #1983) with behaviour checks on the rendered editor.
vi.mock('../src/utils/productId.mjs', () => ({ getBaseCurrency: () => 'BTC', getQuoteCurrency: () => 'USD' }))
const { REGIME_DEFAULTS } = createRequire(import.meta.url)('../../src/config-utils')

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const presets = { conservative: { kFactor: 0.8 }, moderate: { kFactor: 1 }, aggressive: { kFactor: 1.2 }, maximum: { kFactor: 1.4 } }
const regimeConfig = { productId: 'BTC-USD', dryRun: false, regime: { enabled: false, minOrderSizeUsdc: 5 } }
const writes = (method) => fetch.mock.calls.filter(([url, o]) => o?.method === method && !String(url).includes('presets'))

describe('ConfigEditor shared write gate (#455)', () => {
  it('a pending full save locks every fund-config control, a second Save starts no second write, and presets stay editable', async () => {
    const put = deferred()
    vi.stubGlobal('fetch', vi.fn(async (url, o = {}) => {
      if (String(url).includes('presets')) return response(200, { presets })
      return o.method === 'PUT' ? put.promise : response(200, {})
    }))
    render(<ConfigEditor config={regimeConfig} strategy="regime" />)
    await screen.findByRole('button', { name: /Conservative/ })
    fireEvent.change(screen.getByLabelText('Min Order Size ($)'), { target: { value: '9' } })
    const save = screen.getByRole('button', { name: /Save Configuration/ })
    fireEvent.click(save)
    expect(screen.getByLabelText('Min Order Size ($)').matches(':disabled')).toBe(true)
    expect(screen.getByLabelText('Max Open Orders').matches(':disabled')).toBe(true)
    for (const name of ['Enabled', 'Dry Run']) expect(screen.getByRole('switch', { name }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Reset', exact: true }).disabled).toBe(true)
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    fireEvent.click(screen.getByRole('switch', { name: 'Dry Run' }))
    expect(writes('PUT')).toHaveLength(1)
    expect(writes('PATCH')).toHaveLength(0)
    // Global preset editing is outside the gate.
    fireEvent.click(screen.getByRole('button', { name: /Conservative/ }))
    expect(screen.getByLabelText('k Factor').matches(':disabled')).toBe(false)
    await act(async () => put.resolve(response(200, {})))
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Dry Run' }).disabled).toBe(false))
    expect(screen.getByLabelText('Min Order Size ($)').matches(':disabled')).toBe(false)
    expect(save.disabled).toBe(true)
  })

  it('a pending toggle autosave locks Save, the other toggle and the DCA fields, and releases them when it settles', async () => {
    const patch = deferred()
    vi.stubGlobal('fetch', vi.fn(async (url, o = {}) => o.method === 'PATCH' ? patch.promise : response(200, {})))
    render(<ConfigEditor config={{ productId: 'BTC-USD', dryRun: false, enabled: false, intervalType: 'daily' }} strategy="dca" />)
    fireEvent.click(screen.getByRole('switch', { name: 'Dry Run' }))
    expect(screen.getByRole('button', { name: /Save Configuration/ }).disabled).toBe(true)
    expect(screen.getByRole('switch', { name: 'Enabled' }).disabled).toBe(true)
    expect(screen.getByLabelText('Product ID').matches(':disabled')).toBe(true)
    fireEvent.click(screen.getByRole('switch', { name: 'Enabled' }))
    fireEvent.click(screen.getByRole('button', { name: /Save Configuration/ }))
    expect(writes('PATCH')).toHaveLength(1)
    expect(writes('PUT')).toHaveLength(0)
    await act(async () => patch.resolve(response(200, {})))
    expect(screen.getByRole('button', { name: /Save Configuration/ }).disabled).toBe(true)
    expect(screen.getByLabelText('Product ID').matches(':disabled')).toBe(false)
  })

  it('an edit made while a full save is in flight cannot be submitted by a second write', async () => {
    const put = deferred()
    vi.stubGlobal('fetch', vi.fn(async (url, o = {}) => String(url).includes('presets') ? response(200, { presets }) : o.method === 'PUT' ? put.promise : response(200, {})))
    render(<ConfigEditor config={regimeConfig} strategy="regime" />)
    fireEvent.change(screen.getByLabelText('Min Order Size ($)'), { target: { value: '9' } })
    fireEvent.click(screen.getByRole('button', { name: /Save Configuration/ }))
    fireEvent.change(screen.getByLabelText('Min Order Size ($)'), { target: { value: '12' } })
    expect(JSON.parse(writes('PUT')[0][1].body)).toEqual({ regime: { minOrderSizeUsdc: 9 } })
    await act(async () => put.resolve(response(200, {})))
  })
})

describe('ConfigEditor zero-valued and defaulted fields (#868, #1983)', () => {
  it('shows the server default for every absent regime field and never invents an empty one', () => {
    const { container } = render(<ConfigEditor config={{ productId: 'BTC-USD', regime: {} }} regimeDefaults={REGIME_DEFAULTS} strategy="regime" />)
    const empty = [...container.querySelectorAll('fieldset input[type="number"], fieldset input[type="text"], fieldset select')]
      .filter(el => el.value === '' && el.id !== 'productId' && el.type !== 'hidden')
      .map(el => el.id || el.name || el.getAttribute('aria-label'))
    expect(container.querySelectorAll('fieldset input').length).toBeGreaterThan(40)
    expect(empty).toEqual([])
  })

  it('a saved 0 is shown as 0 rather than the default, and an untouched form cannot be saved', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, o = {}) => response(200, o.method ? {} : { presets })))
    render(<ConfigEditor config={{ productId: 'BTC-USD', regime: { harvestScale: 0, trendScale: 0 } }} regimeDefaults={REGIME_DEFAULTS} strategy="regime" />)
    expect(screen.getByLabelText('Trend Scale').value).toBe('0')
    const save = screen.getByRole('button', { name: /Save Configuration/ })
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(writes('PUT')).toHaveLength(0)
  })

  it('clearing a number field commits nothing (no coerced 0); a valid entry does', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, o = {}) => response(200, o.method ? {} : { presets })))
    render(<ConfigEditor config={{ productId: 'BTC-USD', regime: { minOrderSizeUsdc: 5 } }} strategy="regime" />)
    fireEvent.change(screen.getByLabelText('Min Order Size ($)'), { target: { value: '' } })
    expect(screen.queryByText('Unsaved changes')).toBeNull()
    const save = screen.getByRole('button', { name: /Save Configuration/ })
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(writes('PUT')).toHaveLength(0)
    fireEvent.change(screen.getByLabelText('Min Order Size ($)'), { target: { value: '7' } })
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
  })
})
