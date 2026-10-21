import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import KeysConfig from '../src/components/KeysConfig'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function showConnectionResult(result) {
  vi.stubGlobal('fetch', vi.fn(async url => ({
    ok: true,
    json: async () => url.endsWith('/keys')
      ? { configured: true, fields: {} }
      : result,
  })))
  render(<KeysConfig exchange="gemini" funds={[]} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Test Connection' }))
  return screen.findByText(/Connected to Gemini/)
}

it('labels the checked quote currency and announces the same zero-balance result', async () => {
  await showConnectionResult({
    success: true,
    productId: 'BTC-USDC',
    quoteCurrency: 'USDC',
    balance: { available: 0 },
  })

  expect(screen.getByText('Available USDC: 0.00 (quote currency of BTC-USDC) No USDC balance found on this account.')).toBeTruthy()
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('✓ Connected to Gemini Available USDC: 0.00 (quote currency of BTC-USDC) No USDC balance found on this account.'))
  expect(document.body.textContent).not.toContain('$')
})

it('uses eight decimals for crypto balances and omits a missing currency unit', async () => {
  await showConnectionResult({ success: true, quoteCurrency: 'BTC', productId: 'ETH-BTC', balance: { available: 0.123456789 } })
  expect(screen.getByText('Available BTC: 0.12345679 (quote currency of ETH-BTC)')).toBeTruthy()
})

it('shows the amount without a unit when the response has no quote currency', async () => {
  await showConnectionResult({ success: true, balance: { available: 0.12 } })
  expect(screen.getByText('Available: 0.12')).toBeTruthy()
})

it('says a key save may have been applied when no reply was read', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (options?.method === 'PUT') throw new TypeError('Failed to fetch')
    return { ok: true, status: 200, json: async () => ({ configured: false, fields: {} }) }
  }))
  render(<KeysConfig exchange="gemini" funds={[]} />)
  fireEvent.change(await screen.findByLabelText(/API Key/), { target: { value: 'account-abc' } })
  fireEvent.change(screen.getByLabelText(/API Secret/), { target: { value: 'secret' } })
  fireEvent.click(screen.getByRole('button', { name: /save/i }))

  expect((await screen.findAllByText(/may have reached the server/)).length).toBeGreaterThan(0)
})
