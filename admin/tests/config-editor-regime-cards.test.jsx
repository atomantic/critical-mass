import React from 'react'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { renderWithToasts as render } from './renderWithToasts'
import ConfigEditor from '../src/components/ConfigEditor'

vi.mock('../src/App', () => ({ getBaseCurrency: () => 'BTC', getQuoteCurrency: () => 'USD' }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const setup = regime => {
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => ({ ok: true, json: async () => options.method ? {} : { presets: {} } })))
  return render(<ConfigEditor config={{ productId: 'BTC-USD', regime }} strategy="regime" />)
}
const save = async expected => {
  fireEvent.click(screen.getByRole('button', { name: /Save Configuration/ }))
  await screen.findByText('Configuration saved!')
  const [, options] = fetch.mock.calls.find(([, options]) => options?.method === 'PUT')
  expect(JSON.parse(options.body)).toEqual(expected)
}

it('preserves zero values, input identity and partial numeric drafts through unrelated edits', async () => {
  setup({ cautionScale: 0, trendScale: 0, holdbackRatio: 0, maxAssetExposure: 0,
    drawdownResetHours: 0, cycleResetHours: 0, entryOffsetBps: 0, entryOffsetUpBps: 0, entryOffsetDownBps: 0 })
  const zeroLabels = ['Caution Scale', 'Trend Scale', 'Holdback Ratio', 'Max BTC Exposure',
    'Drawdown Reset (hrs)', 'Cycle Reset (hrs)', 'Entry Offset (bps)', 'Entry Offset Up (bps)', 'Entry Offset Down (bps)']
  for (const label of zeroLabels) {
    const input = screen.getByLabelText(label)
    expect(input.value).toBe('0')
    fireEvent.blur(input)
    expect(input.value).toBe('0')
  }
  const partial = screen.getByLabelText('Base Size (USD)')
  partial.focus()
  fireEvent.change(partial, { target: { value: '0.' } })
  fireEvent.change(screen.getByLabelText('Product ID'), { target: { value: 'ETH-USD' } })
  expect(screen.getByLabelText('Base Size (USD)')).toBe(partial)
  expect(document.activeElement).toBe(partial)
  expect(partial.value).toBe('0.')
  await save({ productId: 'ETH-USD', regime: { baseSizeUsdc: 0 } })
  for (const label of zeroLabels) expect(screen.getByLabelText(label).value).toBe('0')
})

it('keeps reactive, ladder and auto-switch visibility with an edited-only payload', async () => {
  setup({ entryMode: 'reactive', ladderAutoSwitch: false })
  expect(screen.queryByLabelText('Max ATH Drop %')).toBeNull()
  expect(screen.getByLabelText('Max Spread (bps)')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Entry Mode'), { target: { value: 'ladder' } })
  expect(screen.getByLabelText('Max ATH Drop %')).toBeTruthy()
  expect(screen.queryByLabelText('Max Spread (bps)')).toBeNull()
  fireEvent.change(screen.getByLabelText('Entry Mode'), { target: { value: 'reactive' } })
  fireEvent.click(screen.getByLabelText('Auto-Switch on Vol'))
  expect(screen.getByLabelText('Auto-Switch Vol Mult')).toBeTruthy()
  expect(screen.getByLabelText('Max ATH Drop %')).toBeTruthy()
  expect(screen.getByLabelText('Max Spread (bps)')).toBeTruthy()
  await save({ regime: { ladderAutoSwitch: true } })
})

it('keeps macro, celestial and TP auto-management conditional fields and save values', async () => {
  setup({ macroEnabled: false, celestialEnabled: false, tpAutoManaged: false })
  expect(screen.queryByLabelText('Update Interval (ms)')).toBeNull()
  expect(screen.queryByLabelText('Evaluation Cycles')).toBeNull()
  expect(screen.queryByText(/Higher tiers have wider TP targets/)).toBeNull()
  fireEvent.click(screen.getByRole('switch', { name: 'Enable Macro Regime' }))
  fireEvent.click(screen.getByRole('switch', { name: 'Enable Celestial Bodies' }))
  fireEvent.click(screen.getByRole('switch', { name: 'Enable Auto-Management' }))
  expect(screen.getByLabelText('Update Interval (ms)')).toBeTruthy()
  expect(screen.getByLabelText('Evaluation Cycles')).toBeTruthy()
  expect(screen.getByText(/Higher tiers have wider TP targets/)).toBeTruthy()
  await save({ regime: { macroEnabled: true, celestialEnabled: true, tpAutoManaged: true } })
})

it.each(['save', 'toggle'])('disables every extracted fund control while a %s is pending', async action => {
  let finish
  vi.stubGlobal('fetch', vi.fn((url, options = {}) => options.method
    ? new Promise(resolve => { finish = () => resolve({ ok: true, json: async () => ({}) }) })
    : Promise.resolve({ ok: true, json: async () => ({ presets: {} }) })))
  render(<ConfigEditor config={{ productId: 'BTC-USD', regime: { macroEnabled: true, tpAutoManaged: true, entryMode: 'ladder' } }} strategy="regime" />)
  fireEvent.click(action === 'save' ? screen.getByRole('button', { name: /Save Configuration/ }) : screen.getByRole('switch', { name: 'Dry Run' }))
  const fieldset = screen.getByLabelText('Product ID').closest('fieldset')
  expect(fieldset.disabled).toBe(true)
  const controls = [...fieldset.querySelectorAll('input, select, button')]
  expect(controls.length).toBeGreaterThan(50)
  for (const control of controls) expect(control.matches(':disabled')).toBe(true)
  await act(async () => finish())
  expect(fieldset.disabled).toBe(false)
  for (const control of controls) expect(control.matches(':disabled')).toBe(false)
})
