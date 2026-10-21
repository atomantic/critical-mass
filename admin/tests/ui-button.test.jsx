import { expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import Button from '../src/components/ui/Button'
import RetryBanner from '../src/components/ui/RetryBanner'

it('Button applies variant colours, touch targets and defaults to type=button', () => {
  render(<Button>Go</Button>)
  const b = screen.getByRole('button', { name: 'Go' })
  expect(b.getAttribute('type')).toBe('button')
  expect(b.className).toContain('bg-blue-600')
  expect(b.className).toContain('min-h-11')
  expect(b.className).toContain('md:min-h-0')
})

it('Button supports the secondary variant and extra classes', () => {
  render(<Button variant="secondary" className="ml-2">X</Button>)
  const b = screen.getByRole('button', { name: 'X' })
  expect(b.className).toContain('bg-gray-700')
  expect(b.className).toContain('ml-2')
})

it('RetryBanner shows the message and fires onRetry', () => {
  const onRetry = vi.fn()
  render(<RetryBanner message="Boom" onRetry={onRetry} />)
  expect(screen.getByRole('alert').textContent).toContain('Boom')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(onRetry).toHaveBeenCalledTimes(1)
})
