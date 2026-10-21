import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ToastProvider, useToast } from '../src/components/Toast'

beforeEach(() => vi.useFakeTimers())
afterEach(() => { cleanup(); vi.useRealTimers() })

function Trigger({ toast }) {
  const { addToast } = useToast()
  return <button onClick={() => addToast(toast)}>fire</button>
}

function show(toast) {
  render(<ToastProvider><Trigger toast={toast} /></ToastProvider>)
  fireEvent.click(screen.getByText('fire'))
}

it('keeps error toasts until dismissed', () => {
  show({ type: 'error', message: 'boom' })
  act(() => { vi.advanceTimersByTime(60000) })
  expect(screen.getByText('boom')).toBeTruthy()
  fireEvent.click(screen.getByLabelText('Dismiss notification'))
  expect(screen.queryByText('boom')).toBeNull()
})

it('auto-closes info toasts after 5s but pauses while hovered', () => {
  show({ type: 'info', message: 'hello' })
  const alert = screen.getByRole('alert')
  fireEvent.mouseEnter(alert)
  act(() => { vi.advanceTimersByTime(10000) })
  expect(screen.getByText('hello')).toBeTruthy()
  fireEvent.mouseLeave(alert)
  act(() => { vi.advanceTimersByTime(5000) })
  expect(screen.queryByText('hello')).toBeNull()
})
