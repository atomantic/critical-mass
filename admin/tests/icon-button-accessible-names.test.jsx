import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BrowserRouter } from '../src/lib/router'
import ScorecardAnalysis from '../src/components/updown/ScorecardAnalysis'
import { ToastProvider, useToast } from '../src/components/Toast'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const analysis = {
  summary: { predictions: 0, outcomes: 0 },
  catalog: { indicators: [], timeframes: [] },
  accuracyOverTime: [],
  indicatorAccuracyOverTime: [],
  weightEvolution: [],
  failurePatterns: [],
}

it('gives the Scorecard Analysis refresh button an accessible name', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => analysis })))
  render(<BrowserRouter><ScorecardAnalysis /></BrowserRouter>)
  const refresh = await screen.findByRole('button', { name: 'Refresh scorecard analysis' })
  await waitFor(() => expect(refresh.disabled).toBe(false))
  fireEvent.click(refresh)
  expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2)
})

function ToastTrigger() {
  const { addToast } = useToast()
  return <button onClick={() => addToast({ type: 'error', title: 'Boom', message: 'Failed' })}>show</button>
}

it('gives the toast dismiss button an accessible name', async () => {
  render(<ToastProvider><ToastTrigger /></ToastProvider>)
  fireEvent.click(screen.getByRole('button', { name: 'show' }))
  expect(await screen.findByRole('button', { name: 'Dismiss notification' })).toBeTruthy()
})
