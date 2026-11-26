import React from 'react'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { renderWithToasts as render } from './renderWithToasts'
import ConfigEditor from '../src/components/ConfigEditor'
import { DurationInput } from '../src/components/config/ConfigFormControls'
import { DISCLOSURE_CARD_FIELDS, countChangedFromDefault, errorFieldKeys } from '../src/utils/regimeCardState.mjs'
import { displayToMs, msToDisplay, pickDurationUnit } from '../src/utils/duration.mjs'

vi.mock('../src/utils/productId.mjs', () => ({ getBaseCurrency: () => 'BTC', getQuoteCurrency: () => 'USD' }))
beforeEach(() => { try { localStorage.clear() } catch { /* ignore */ } })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const defaults = { staleDataMs: 30000, safeRecoveryMs: 60000, maxOpenOrders: 4, momentumMult: 1, macroEnabled: false, macroUpdateIntervalMs: 300000 }
const stub = (putStatus = 200, putBody = {}) => vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => (
  options.method ? { ok: putStatus < 300, status: putStatus, json: async () => putBody } : { ok: true, status: 200, json: async () => ({ presets: {} }) })))
const mount = (regime = {}) => render(<ConfigEditor config={{ productId: 'BTC-USD', regime }} regimeDefaults={defaults} strategy="regime" />)
const card = title => screen.getByText(title, { selector: 'h3' }).closest('details')

describe('disclosure cards', () => {
  it('collapses the five advanced cards and leaves the rest open', () => {
    mount()
    for (const t of ['Order Execution', 'System Health', 'Safety & Tail Events', 'Regime Detection', 'Macro Regime (Multi-Timeframe)']) {
      expect(card(t).open).toBe(false)
    }
    for (const t of ['Volatility Clock', 'Regime Scaling', 'Entry Mode & Ladder', 'Take-Profit', 'Celestial Hierarchy', 'TP Auto-Management', 'Risk Caps']) {
      expect(screen.getByText(t, { selector: 'h3' }).closest('details')).toBeNull()
    }
  })

  it('shows a changed-from-default badge only for non-default saved values', () => {
    mount({ staleDataMs: 45000, safeRecoveryMs: 60000, maxOpenOrders: 4 })
    expect(within(card('System Health')).getByText('1 changed from default')).toBeTruthy()
    expect(within(card('Order Execution')).queryByText(/changed from default/)).toBeNull()
  })

  it('opens on an unsaved edit and stays open', () => {
    mount()
    const details = card('Order Execution')
    fireEvent.change(screen.getByLabelText('Max Open Orders'), { target: { value: '9' } })
    expect(details.open).toBe(true)
    fireEvent.click(details.querySelector('summary'))
    expect(details.open).toBe(true)
  })

  it('opens the card named by a rejected save and keeps unrelated cards collapsed', async () => {
    stub(400, { error: 'regime.momentumMult must be between 0.1 and 5' })
    mount({ momentumMult: 99 })
    fireEvent.change(screen.getByLabelText('Max Open Orders'), { target: { value: '9' } })
    fireEvent.click(screen.getByRole('button', { name: /Save Configuration/ }))
    await screen.findByText(/must be between 0.1 and 5/)
    expect(card('Regime Detection').open).toBe(true)
    expect(card('System Health').open).toBe(false)
  })

  it('toggles by the summary and remembers the choice per card', () => {
    const view = mount()
    fireEvent.click(card('System Health').querySelector('summary'))
    expect(card('System Health').open).toBe(true)
    expect(localStorage.getItem('critical-mass:config-card-open:systemHealth')).toBe('1')
    view.unmount()
    mount()
    expect(card('System Health').open).toBe(true)
    expect(card('Order Execution').open).toBe(false)
  })

  it('still works when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    mount()
    fireEvent.click(card('System Health').querySelector('summary'))
    expect(card('System Health').open).toBe(true)
    vi.restoreAllMocks()
  })

  it('removes no field: collapsed cards keep every input in the DOM', () => {
    mount()
    for (const label of ['Stale Data', 'Safe Recovery', 'Reconcile Interval', 'Spread Pause', 'Max Spread (bps)', 'Momentum Mult', 'Entry Offset (bps)']) {
      expect(screen.getByLabelText(label)).toBeTruthy()
    }
  })

  it('opening a card leaves the untouched form clean', async () => {
    stub()
    mount({ staleDataMs: 45000 })
    fireEvent.click(card('System Health').querySelector('summary'))
    const save = screen.getByRole('button', { name: /Save Configuration/ })
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(fetch.mock.calls.some(([, o]) => o?.method === 'PUT')).toBe(false)
  })

  it('makes Product ID read-only for an existing fund', () => {
    mount()
    const input = screen.getByLabelText('Product ID')
    expect(input.readOnly).toBe(true)
    fireEvent.change(input, { target: { value: 'ETH-USD' } })
    expect(input.value).toBe('BTC-USD')
    expect(screen.queryByText('Unsaved changes')).toBeNull()
  })

  it('card field lists match the fields each card renders', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/components/config/RegimeConfigCards.jsx'), 'utf8')
    const ids = { orderExecution: 'OrderExecutionCard', systemHealth: 'SystemHealthCard', safetyTail: 'SafetyTailEventsCard', regimeDetection: 'RegimeDetectionCard', macro: 'MacroRegimeCard' }
    for (const [id, fn] of Object.entries(ids)) {
      const start = src.indexOf(`export function ${fn}`)
      const end = src.indexOf('\nexport function', start + 1)
      const body = src.slice(start, end < 0 ? undefined : end)
      const used = new Set([...body.matchAll(/fv\('(\w+)'\)/g)].map(m => m[1]))
      if (/regimeConfig\.macroEnabled/.test(body)) used.add('macroEnabled')
      expect([...used].sort()).toEqual([...DISCLOSURE_CARD_FIELDS[id]].sort())
    }
  })
})

describe('state helpers', () => {
  it('counts only saved values that differ from a known default', () => {
    expect(countChangedFromDefault(['a', 'b', 'c', 'd'], { a: 1, b: 2, c: 3 }, { a: 1, b: 5, d: 1 })).toBe(1)
    expect(countChangedFromDefault(['a'], { a: 1 }, undefined)).toBe(0)
  })
  it('finds field keys in server messages by whole name', () => {
    expect(errorFieldKeys('regime.staleDataMs must be 1000-60000; maxOpenOrders too high')).toEqual(['maxOpenOrders', 'staleDataMs'])
    expect(errorFieldKeys('maxOpenOrdersX bad')).toEqual([])
  })
})

describe('DurationInput', () => {
  it('round-trips milliseconds exactly', () => {
    expect(pickDurationUnit(120000)).toBe('min')
    expect(msToDisplay(120000, 'min')).toBe(2)
    expect(pickDurationUnit(90000)).toBe('s')
    expect(msToDisplay(90000, 's')).toBe(90)
    expect(msToDisplay(1500, 's')).toBe(1.5)
    expect(pickDurationUnit(0)).toBe('s')
    for (const ms of [1, 999, 1500, 30000, 120000, 123456]) {
      for (const unit of ['s', 'min']) expect(displayToMs(msToDisplay(ms, unit), unit)).toBe(ms)
    }
    expect(displayToMs(0.1 + 0.2, 's')).toBe(300)
  })

  it('shows minutes or seconds, emits milliseconds, and changing the unit alone emits nothing', () => {
    const onChange = vi.fn()
    render(<DurationInput label="Stale" value={120000} onChange={onChange} />)
    const input = screen.getByLabelText('Stale')
    expect(input.value).toBe('2')
    expect(screen.getByLabelText('Stale unit').value).toBe('min')
    fireEvent.change(screen.getByLabelText('Stale unit'), { target: { value: 's' } })
    expect(input.value).toBe('120')
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '90' } })
    expect(onChange).toHaveBeenLastCalledWith(90000)
    fireEvent.change(screen.getByLabelText('Stale unit'), { target: { value: 'min' } })
    fireEvent.change(input, { target: { value: '1.5' } })
    expect(onChange).toHaveBeenLastCalledWith(90000)
  })

  it('shows a non-round value in seconds and ignores a cleared field', () => {
    const onChange = vi.fn()
    render(<DurationInput label="Stale" value={45500} onChange={onChange} />)
    expect(screen.getByLabelText('Stale').value).toBe('45.5')
    expect(screen.getByLabelText('Stale unit').value).toBe('s')
    fireEvent.change(screen.getByLabelText('Stale'), { target: { value: '' } })
    expect(onChange).not.toHaveBeenCalled()
  })
})
