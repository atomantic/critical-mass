import React from 'react'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithToasts as render } from './renderWithToasts'
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
  it.each([
    ['regime', 'Saved settings are applied to the running engine immediately. A Dry Run change takes effect after the engine restarts.'],
    ['dca', 'Changes take effect on the next run. The bot will not make additional trades this interval if it has already run.'],
  ])('tells %s funds when a saved change takes effect', (strategy, text) => {
    stubSave(200, {})
    render(<ConfigEditor config={{ ...config, intervalType: 'daily' }} strategy={strategy} />)
    expect(screen.getByText(text)).toBeTruthy()
  })

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
    await screen.findByText('Max ATH Drop % must be between 10 and 95; Min Order Size must be between 1 and 100; Max Asset Exposure must be 0 (uncapped) or between 0.01 and 10.0; TP Absolute Min % must be between 0.01 and 1.0')
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

  describe.each([
    ['regime', 'Dry Run'],
    ['regime', 'Enabled'],
    ['dca', 'Dry Run'],
    ['dca', 'Enabled'],
  ])('%s %s autosave preserves the draft', (strategy, toggle) => {
    it.each(['persisted-not-applied', 'success', 'empty success', 'unpersisted failure'])(
      'keeps unrelated edits and the next Save diff after %s', async outcome => {
        const initial = {
          ...config, dryRun: false, enabled: false, minOrderSize: 5,
          regime: { ...config.regime, minOrderSizeUsdc: 5 },
        }
        const regimeEnabled = strategy === 'regime' && toggle === 'Enabled'
        const field = toggle === 'Dry Run' ? 'dryRun' : 'enabled'
        const persisted = outcome !== 'unpersisted failure'
        const saved = regimeEnabled
          ? { ...initial, regime: { ...initial.regime, enabled: true } }
          : { ...initial, [field]: true }
        const snapshot = regimeEnabled ? saved.regime : saved
        let writes = 0
        vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
          if (!['PATCH', 'PUT'].includes(options.method)) return response(200, { presets: {} })
          writes += 1
          if (writes > 1) return response(400, { error: 'Save rejected for test' })
          if (outcome === 'persisted-not-applied') return response(503, { persisted: true, applied: false, config: snapshot })
          if (outcome === 'unpersisted failure') return response(400, { error: 'Toggle rejected for test' })
          return response(200, outcome === 'empty success' ? {} : { config: snapshot })
        }))
        const onSave = vi.fn()
        const view = render(<ConfigEditor config={initial} strategy={strategy} onSave={onSave} />)
        fireEvent.change(screen.getByLabelText('Product ID'), { target: { value: 'ETH-USD' } })
        const orderLabel = strategy === 'regime' ? 'Min Order Size ($)' : 'Min Order (USD)'
        fireEvent.change(screen.getByLabelText(orderLabel), { target: { value: '17' } })
        // Blurring exposes the committed config value instead of FormInput's
        // focused text buffer, so the test detects a replaced draft.
        fireEvent.blur(screen.getByLabelText(orderLabel))
        fireEvent.click(screen.getByRole('switch', { name: toggle }))
        if (outcome === 'persisted-not-applied') await screen.findByText(/Restart the engine to apply it/)
        else await screen.findByText(persisted ? `${toggle} saved` : 'Toggle rejected for test')
        expect(onSave).toHaveBeenCalledTimes(persisted ? 1 : 0)
        // Model the parent refresh triggered by a confirmed autosave.
        if (persisted) view.rerender(<ConfigEditor config={saved} strategy={strategy} onSave={onSave} />)
        expect(screen.getByRole('switch', { name: toggle }).getAttribute('aria-checked')).toBe(String(persisted))
        expect(screen.getByLabelText('Product ID').value).toBe('ETH-USD')
        expect(screen.getByLabelText(orderLabel).value).toBe('17')
        expect(screen.getByText('Unsaved changes')).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: /Save Configuration/ }))
        await screen.findByText('Save rejected for test')
        const [, request] = fetch.mock.calls.filter(([, options]) => ['PATCH', 'PUT'].includes(options?.method))[1]
        expect(request.method).toBe('PUT')
        expect(JSON.parse(request.body)).toEqual({
          productId: 'ETH-USD',
          ...(strategy === 'regime' ? { regime: { minOrderSizeUsdc: 17 } } : { minOrderSize: 17 }),
        })
        if (outcome === 'persisted-not-applied') expect(screen.getByText(/Restart the engine to apply it/)).toBeTruthy()
      },
    )
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
    ['manual', 400, { errors: ['kFactor: must be >= 0.2', 'minIntervalMs: must be >= 30000'] }, 'k Factor: must be >= 0.2; Min Interval: must be >= 30000', 'error', false],
    ['suggested', 400, { errors: ['kFactor: must be >= 0.2', 'minIntervalMs: must be >= 30000'] }, 'k Factor: must be >= 0.2; Min Interval: must be >= 30000', 'error', false],
    // Saved but not applied: the saved level must be refetched so the control shows it.
    ['manual', 503, { persisted: true, applied: false, error: 'Saved, but engine unavailable. Restart required.' }, 'Saved, but engine unavailable. Restart required.', 'warning', true],
    ['suggested', 503, { persisted: true, applied: false, error: 'Saved, but engine unavailable. Restart required.' }, 'Saved, but engine unavailable. Restart required.', 'warning', true],
  ])('shows %s aggressiveness save reasons for HTTP %s', async (mode, status, body, message, type, refresh) => {
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
    await waitFor(() => expect(props.addToast).toHaveBeenCalledWith(expect.objectContaining({ type, message })))
    expect(props.onConfigUpdate).toHaveBeenCalledTimes(refresh ? 1 : 0)
  })
})

describe('dry-run restart', () => {
  const stubLifecycle = (stop, start) => vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (url.includes('/regime/stop')) return stop
    if (url.includes('/regime/start')) return start
    if (url.includes('/regime/status')) return response(200, { status: { isRunning: true, isDryRun: true } })
    return response(200, { presets: {} })
  }))
  const renderPendingRestart = () => {
    const onRestart = vi.fn()
    render(<ConfigEditor config={{ ...config, dryRun: true }} strategy="regime" engineRunning engineDryRun={false} onRestart={onRestart} />)
    fireEvent.click(screen.getByRole('button', { name: 'Restart Engine' }))
    return onRestart
  }

  const STALE = /Restart the engine to apply it/
  // PUT /config answers per `save`; the lifecycle endpoints always succeed.
  const stubSaveThenRestart = (save) => vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    if (url.includes('/regime/status')) return response(200, { status: { isRunning: true, isDryRun: true } })
    if (url.includes('/regime/')) return response(200, { success: true })
    if (options.method === 'PUT') return save()
    return response(200, { presets: {} })
  }))
  const saveEdit = () => {
    fireEvent.change(screen.getByLabelText('Min Order Size ($)'), { target: { value: '12' } })
    fireEvent.click(screen.getByRole('button', { name: /Save Configuration/ }))
  }

  it('dismisses the sticky restart warning once the restart succeeds', async () => {
    stubSaveThenRestart(() => response(503, { persisted: true, applied: false, error: 'engine unavailable' }))
    render(<ConfigEditor config={{ ...config, dryRun: true }} strategy="regime" engineRunning engineDryRun={false} />)
    saveEdit()
    await screen.findByText(STALE)
    fireEvent.click(screen.getByRole('button', { name: 'Restart Engine' }))
    await screen.findByText('Engine restarted — change applied')
    expect(screen.queryByText(STALE)).toBeNull()
  })

  it('dismisses the sticky restart warning when a later save applies cleanly, and never stacks duplicates', async () => {
    let applied = false
    stubSaveThenRestart(() => applied
      ? response(200, { config })
      : response(503, { persisted: true, applied: false, error: 'engine unavailable' }))
    render(<ConfigEditor config={config} strategy="regime" />)
    saveEdit()
    await screen.findByText(STALE)
    saveEdit()
    await waitFor(() => expect(fetch.mock.calls.filter(([, o]) => o?.method === 'PUT')).toHaveLength(2))
    await waitFor(() => expect(screen.getAllByText(STALE)).toHaveLength(1))
    applied = true
    saveEdit()
    await screen.findByText('Configuration saved!')
    expect(screen.queryByText(STALE)).toBeNull()
  })

  it('reports why the stop failed and does not try to start a still-running engine', async () => {
    stubLifecycle(response(400, { success: false, error: 'Fund writers are still draining' }), response(200, { success: true }))
    const onRestart = renderPendingRestart()
    await screen.findByText(/Could not stop the engine to apply the change \(Fund writers are still draining\)/)
    expect(fetch.mock.calls.some(([url]) => url.includes('/regime/start'))).toBe(false)
    expect(onRestart).toHaveBeenCalledTimes(1)
  })

  it('starts an engine that had already stopped', async () => {
    stubLifecycle(response(400, { success: false, error: 'Regime engine not running for this fund' }), response(200, { success: true }))
    renderPendingRestart()
    await screen.findByText('Engine restarted — change applied')
  })

  it('says the engine is stopped when the start after a successful stop fails', async () => {
    stubLifecycle(response(200, { success: true }), response(503, { success: false, error: 'Engine unavailable: IPC request timeout' }))
    renderPendingRestart()
    await screen.findByText('Engine stopped but did not start again (Engine unavailable: IPC request timeout) — start it manually from the dashboard.')
  })
})


describe('configuration and restart serialization (issue #1747)', () => {
  const deferred = () => {
    let resolve
    const promise = new Promise(done => { resolve = done })
    return { promise, resolve }
  }
  const initial = { ...config, dryRun: true }
  const renderMismatch = () => render(<ConfigEditor config={initial} strategy="regime" exchange="gemini" pair="BTC-USD" engineRunning engineDryRun={false} />)
  const lifecycleCalls = () => fetch.mock.calls.filter(([url]) => /regime\/(stop|start)/.test(url))
  const writeCalls = () => fetch.mock.calls.filter(([, o]) => ['PUT', 'PATCH'].includes(o?.method))

  it.each(['Dry Run', 'Enabled', 'full save'])('blocks restart throughout a pending %s write', async action => {
    const write = deferred()
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      if (['PUT', 'PATCH'].includes(options.method)) return write.promise
      return response(200, { presets: {} })
    }))
    renderMismatch()
    const restart = screen.getByRole('button', { name: 'Restart Engine' })
    const control = action === 'full save' ? screen.getByRole('button', { name: 'Save Configuration' }) : screen.getByRole('switch', { name: action })
    act(() => {
      control.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      restart.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(restart.disabled).toBe(true)
    expect(lifecycleCalls()).toHaveLength(0)
    expect(writeCalls()).toHaveLength(1)
    await act(async () => write.resolve(response(200, {})))
    if (action === 'Dry Run') expect(screen.queryByRole('button', { name: 'Restart Engine' })).toBeNull()
    else expect(restart.disabled).toBe(false)
  })

  it('keeps unacknowledged and failed Dry Run changes out of the restart banner', async () => {
    let write = deferred()
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => options.method === 'PATCH' ? write.promise : response(200, { presets: {} })))
    render(<ConfigEditor config={{ ...config, dryRun: false }} strategy="regime" engineRunning engineDryRun={false} />)
    fireEvent.click(screen.getByRole('switch', { name: 'Dry Run' }))
    expect(screen.queryByRole('button', { name: 'Restart Engine' })).toBeNull()
    await act(async () => write.resolve(response(400, { error: 'Save rejected' })))
    expect(screen.queryByRole('button', { name: 'Restart Engine' })).toBeNull()
    write = deferred()
    fireEvent.click(screen.getByRole('switch', { name: 'Dry Run' }))
    expect(screen.queryByRole('button', { name: 'Restart Engine' })).toBeNull()
    await act(async () => write.resolve(response(200, { config: { ...config, dryRun: true } })))
    expect(screen.getByRole('button', { name: 'Restart Engine' })).toBeTruthy()
  })

  it('allows one Stop/Start and excludes same-turn writes until refreshed status confirms the saved mode', async () => {
    const stop = deferred(), start = deferred(), status = deferred()
    vi.stubGlobal('fetch', vi.fn(async url => {
      if (url.includes('/regime/stop')) return stop.promise
      if (url.includes('/regime/start')) return start.promise
      if (url.includes('/regime/status')) return status.promise
      return response(200, { presets: {} })
    }))
    renderMismatch()
    const restart = screen.getByRole('button', { name: 'Restart Engine' })
    const save = screen.getByRole('button', { name: 'Save Configuration' })
    const dryRun = screen.getByRole('switch', { name: 'Dry Run' })
    const enabled = screen.getByRole('switch', { name: 'Enabled' })
    act(() => {
      for (const button of [restart, restart, save, dryRun, enabled]) button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(lifecycleCalls().map(([url]) => url)).toEqual(['/api/gemini/regime/stop?pair=BTC-USD'])
    expect(writeCalls()).toHaveLength(0)
    for (const button of [restart, save, dryRun, enabled]) expect(button.disabled).toBe(true)
    await act(async () => stop.resolve(response(200, { success: true })))
    expect(lifecycleCalls().map(([url]) => url)).toEqual(['/api/gemini/regime/stop?pair=BTC-USD', '/api/gemini/regime/start?pair=BTC-USD'])
    await act(async () => start.resolve(response(200, { success: true })))
    expect(screen.queryByText('Engine restarted — change applied')).toBeNull()
    expect(save.disabled).toBe(true)
    expect(fetch.mock.calls.some(([url]) => url === '/api/gemini/regime/status?pair=BTC-USD')).toBe(true)
    await act(async () => status.resolve(response(200, { status: { isRunning: true, isDryRun: true } })))
    expect(screen.getByText('Engine restarted — change applied')).toBeTruthy()
    expect(save.disabled).toBe(false)
    expect(writeCalls()).toHaveLength(0)
  })

  it.each([
    [200, { status: { isRunning: true, isDryRun: false } }],
    [200, { status: { isRunning: false, isDryRun: true } }],
    [200, { status: { isRunning: true } }],
    [503, { error: 'unavailable' }],
  ])('warns instead of claiming application success for unconfirmed status %j %j', async (code, body) => {
    vi.stubGlobal('fetch', vi.fn(async url => url.includes('/regime/status') ? response(code, body) : response(200, { success: true, presets: {} })))
    renderMismatch()
    fireEvent.click(screen.getByRole('button', { name: 'Restart Engine' }))
    await screen.findByText(/Restart requested, but the running engine could not be confirmed/)
    expect(screen.queryByText('Engine restarted — change applied')).toBeNull()
    expect(screen.getByRole('button', { name: 'Restart Engine' }).disabled).toBe(false)
  })
})
