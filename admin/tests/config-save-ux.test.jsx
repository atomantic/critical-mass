import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ConfigEditor from '../src/components/ConfigEditor'
import CapitalAdjust from '../src/components/regime/CapitalAdjust'
import AggressivenessControl from '../src/components/regime/AggressivenessControl'
import LongTermBiasPanel from '../src/components/regime/LongTermBiasPanel'

vi.mock('../src/App', () => ({ getBaseCurrency: () => 'BTC', getQuoteCurrency: () => 'USD' }))
vi.mock('../src/components/regime/RegimeHelp', () => ({ ConfigTooltip: () => null, LONG_TERM_BIAS_TOOLTIP: null }))
vi.mock('../src/components/regime/LongTermBiasDetails', () => ({ default: () => null }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const config = { productId: 'BTC-USD', regime: { enabled: false, ladderMaxAthDropPct: 80 } }
const stubSave = (status, body) => vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => options.method ? response(status, body) : response(200, { presets: {} })))

describe('config save response handling', () => {
  it('shows the humanized Enabled rejection and restores the unsaved switch', async () => {
    stubSave(400, { errors: ['enabled: expected boolean'] })
    const onSave = vi.fn()
    render(<ConfigEditor config={config} strategy="regime" onSave={onSave} />)
    fireEvent.click(screen.getByRole('switch', { name: 'Enabled' }))
    await screen.findByText('Enabled: expected boolean')
    expect(screen.getByRole('switch', { name: 'Enabled' }).getAttribute('aria-checked')).toBe('false')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('humanizes all joined full-save field errors and retains the draft', async () => {
    stubSave(400, { error: 'regime.ladderMaxAthDropPct must be between 10 and 95; minOrderSizeUsdc must be between 1 and 100; maxAssetExposure must be 0 (uncapped) or between 0.01 and 10.0; tpAbsoluteMin must be between 0.01 and 1.0' })
    render(<ConfigEditor config={config} strategy="regime" />)
    fireEvent.change(screen.getByLabelText('Min Order Size ($)'), { target: { value: '999' } })
    fireEvent.click(screen.getByRole('button', { name: /Save Configuration/ }))
    await screen.findByText('Max ATH Drop % must be between 10 and 95; Min Order Size must be between 1 and 100; Max asset exposure must be 0 (uncapped) or between 0.01 and 10.0; TP Absolute Min % must be between 0.01 and 1.0')
    expect(screen.getByLabelText('Min Order Size ($)').value).toBe('999')
  })

  it.each(['toggle', 'full save'])('keeps saved state and refreshes after persisted-not-applied %s', async (action) => {
    const saved = { ...config, regime: { ...config.regime, enabled: true } }
    stubSave(503, { persisted: true, applied: false, config: action === 'toggle' ? saved.regime : saved, error: 'engine unavailable' })
    const onSave = vi.fn()
    render(<ConfigEditor config={config} strategy="regime" onSave={onSave} />)
    fireEvent.click(action === 'toggle' ? screen.getByRole('switch', { name: 'Enabled' }) : screen.getByRole('button', { name: /Save Configuration/ }))
    await screen.findByText(/Restart the engine to apply it/)
    expect(screen.getByRole('switch', { name: 'Enabled' }).getAttribute('aria-checked')).toBe('true')
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it.each([
    [503, { success: false, persisted: true, applied: false, error: 'engine down' }, 'warning', 'Capital saved, not yet live', 'Restart the engine to apply it.', true],
    [400, { errors: ['depositedCapital must be 0 (auto-derive) or at least 100'] }, 'error', 'Adjust Failed', 'Deposited Capital must be 0 (auto-derive) or at least 100', false],
    [502, null, 'error', 'Adjust Failed', 'Could not save settings (HTTP 502)', false],
  ])('handles capital response %s and refreshes only saved values', async (status, body, type, title, message, refresh) => {
    vi.stubGlobal('fetch', vi.fn(async () => body === null ? { ok: false, status, json: async () => { throw new Error('invalid JSON') } } : response(status, body)))
    const fetchConfig = vi.fn(), fetchStatus = vi.fn(), addToast = vi.fn()
    render(<CapitalAdjust apy={{ availableCapital: 500, depositedCapital: 1000, maxUsdcDeployed: 1000 }} exchange="coinbase" pairQuery="?pair=BTC-USD" {...{ fetchConfig, fetchStatus, addToast }} />)
    fireEvent.click(screen.getByTitle('Click to adjust available capital (updates deposited & max)'))
    fireEvent.change(screen.getByLabelText('Available: $'), { target: { value: '750' } })
    fireEvent.click(screen.getByTitle('Apply'))
    await waitFor(() => expect(addToast).toHaveBeenCalledWith({ type, title, message }))
    expect(fetchConfig).toHaveBeenCalledTimes(refresh ? 1 : 0)
    expect(fetchStatus).toHaveBeenCalledTimes(refresh ? 1 : 0)
  })

  it.each([
    ['manual', 400, { errors: ['kFactor: must be >= 0.2', 'minIntervalMs: must be >= 30000'] }, 'k Factor: must be >= 0.2; Min Interval: must be >= 30000'],
    ['suggested', 400, { errors: ['kFactor: must be >= 0.2', 'minIntervalMs: must be >= 30000'] }, 'k Factor: must be >= 0.2; Min Interval: must be >= 30000'],
    ['manual', 503, { persisted: true, applied: false, error: 'Saved, but engine unavailable. Restart required.' }, 'Saved, but engine unavailable. Restart required.'],
    ['suggested', 503, { persisted: true, applied: false, error: 'Saved, but engine unavailable. Restart required.' }, 'Saved, but engine unavailable. Restart required.'],
  ])('shows %s aggressiveness save reasons for HTTP %s', async (mode, status, body, message) => {
    stubSave(status, body)
    const props = { config: { aggressiveness: 'moderate' }, exchange: 'coinbase', pairQuery: '', presets: { conservative: { kFactor: 0.8 } }, onConfigUpdate: vi.fn(), addToast: vi.fn() }
    if (mode === 'manual') {
      render(<AggressivenessControl {...props} />)
      fireEvent.click(screen.getByRole('button', { name: 'Conservative' }))
      expect(screen.getByText('k Factor')).toBeTruthy()
      expect(screen.getByText('Min Interval')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Apply Conservative' }))
    } else {
      render(<LongTermBiasPanel {...props} bias={{ ready: true, suggestedLevel: 'conservative', score: 0.5 }} />)
      fireEvent.click(screen.getByRole('button', { name: 'Apply Suggested (Conservative)' }))
    }
    await waitFor(() => expect(props.addToast).toHaveBeenCalledWith(expect.objectContaining({ message })))
    expect(props.onConfigUpdate).not.toHaveBeenCalled()
  })
})
