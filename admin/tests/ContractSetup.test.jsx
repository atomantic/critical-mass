import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ContractSetup from '../src/components/updown/ContractSetup'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function mockFetchForSave(saveResponse) {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
  vi.stubGlobal('fetch', vi.fn((url) => {
    if (url === '/api/updown/providers') {
      return Promise.resolve({ json: async () => ({ success: false }) })
    }
    return saveResponse()
  }))
}

describe('ContractSetup save feedback', () => {
  it('shows the server validation error and re-enables Save', async () => {
    mockFetchForSave(() => Promise.resolve({
      ok: false,
      json: async () => ({ error: 'stop must be a positive number' }),
    }))
    render(<ContractSetup />)

    fireEvent.click(screen.getByRole('button', { name: 'Save Contract' }))

    expect((await screen.findByRole('alert')).textContent).toContain('stop must be a positive number')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save Contract' }).disabled).toBe(false))
  })

  it('shows a network error and re-enables Save when fetch rejects', async () => {
    mockFetchForSave(() => Promise.reject(new Error('gateway unavailable')))
    render(<ContractSetup />)

    fireEvent.click(screen.getByRole('button', { name: 'Save Contract' }))

    expect((await screen.findByRole('alert')).textContent).toContain('gateway unavailable')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save Contract' }).disabled).toBe(false))
  })

  it('keeps the Saved confirmation on success', async () => {
    mockFetchForSave(() => Promise.resolve({ ok: true }))
    render(<ContractSetup />)

    fireEvent.click(screen.getByRole('button', { name: 'Save Contract' }))

    expect(await screen.findByRole('button', { name: 'Saved' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
