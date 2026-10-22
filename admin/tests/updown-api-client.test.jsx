import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import PositionTracker from '../src/components/updown/PositionTracker.jsx'
import SignalPanel from '../src/components/updown/SignalPanel.jsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const trackerProps = { initialPosition: { entryPrice: 100, contracts: 2, direction: 'up' }, currentPrice: 101, priceFresh: true }

it('shows the HTTP status when saving the tracker gets a proxy HTML page', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token <') } })))
  render(<PositionTracker {...trackerProps} />)
  fireEvent.click(screen.getByRole('button', { name: /Save/ }))
  expect((await screen.findByRole('alert')).textContent).toContain('HTTP 502')
})

it('says the save may have reached the server when the reply never arrived', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
  render(<PositionTracker {...trackerProps} />)
  fireEvent.click(screen.getByRole('button', { name: /Save/ }))
  expect((await screen.findByRole('alert')).textContent).toMatch(/Failed to fetch.*may have reached the server/)
})

it('reports unavailable signal history for a non-JSON reply instead of an empty list', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <') } })))
  render(<SignalPanel signal={null} indicators={null} position={null} />)
  expect(await screen.findByText('Signal history unavailable.')).toBeTruthy()
})
