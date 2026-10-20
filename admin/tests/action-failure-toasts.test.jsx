import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import useRegimeDashboardActions from '../src/components/regime/useRegimeDashboardActions'
import { describeActionFailure } from '../src/utils/actionFailure.mjs'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const reply = (status, body) => ({
  ok: status < 400,
  status,
  json: async () => {
    if (body === undefined) throw new SyntaxError('Unexpected token < in JSON')
    return body
  },
})

function setup(response) {
  const addToast = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async () => response))
  const { result } = renderHook(() => useRegimeDashboardActions({
    exchange: 'coinbase', pairQuery: '', addToast,
    setSocketStatus: vi.fn(), fetchStatus: vi.fn(), fetchConfig: vi.fn(), fetchFills: vi.fn(),
  }))
  return { result, addToast }
}

it('names the engine outage when cancelling the ladder fails with the gateway error body', async () => {
  const { result, addToast } = setup(reply(503, { success: false, error: 'Engine unavailable: IPC socket closed' }))
  await act(() => result.current.handleExecuteCancelLadder())
  expect(addToast).toHaveBeenCalledWith({ type: 'error', title: 'Cancel ladder failed', message: 'Engine unavailable: IPC socket closed' })
})

it('shows the engine refusal reason from either error or message', async () => {
  const refused = setup(reply(400, { success: false, message: 'Engine not running' }))
  await act(() => refused.result.current.handleExecuteCancelLadder())
  expect(refused.addToast).toHaveBeenCalledWith(expect.objectContaining({ message: 'Engine not running' }))

  const denied = setup(reply(400, { success: false, error: 'API access is still denied' }))
  await act(() => denied.result.current.handleResumeFromAuthDenied())
  expect(denied.addToast).toHaveBeenCalledWith({ type: 'error', title: 'Resume failed', message: 'API access is still denied' })
})

it('reports the HTTP status and where to look when the response has no readable reason', async () => {
  const { result, addToast } = setup(reply(502, undefined))
  await act(() => result.current.handleResetCycle())
  expect(addToast).toHaveBeenCalledWith({
    type: 'error',
    title: 'Cycle reset failed',
    message: 'The server rejected the request (HTTP 502) without giving a reason. Check the engine logs.',
  })
})

it('prefers a non-blank error over message and ignores blank text', () => {
  expect(describeActionFailure(400, { error: ' Fund is closed ', message: 'ignored' })).toBe('Fund is closed')
  expect(describeActionFailure(500, { error: '  ', message: 'Engine busy' })).toBe('Engine busy')
  expect(describeActionFailure(undefined, null)).toBe('The server sent an unreadable response. Check the engine logs.')
})
