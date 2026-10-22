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

it('Button maps dialog variants to their colours', () => {
  render(<><Button variant="cancel">C</Button><Button variant="warning">W</Button><Button variant="destructive">D</Button></>)
  expect(screen.getByRole('button', { name: 'C' }).className).toContain('text-gray-400')
  expect(screen.getByRole('button', { name: 'W' }).className).toContain('bg-yellow-800')
  expect(screen.getByRole('button', { name: 'D' }).className).toContain('bg-red-700')
})

it('RetryBanner shows the message and fires onRetry', () => {
  const onRetry = vi.fn()
  render(<RetryBanner message="Boom" onRetry={onRetry} />)
  expect(screen.getByRole('alert').textContent).toContain('Boom')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(onRetry).toHaveBeenCalledTimes(1)
})

it('Button maps tinted, text-only and responsive-size options', () => {
  render(<>
    <Button variant="soft-danger" size="compact">S</Button>
    <Button variant="quiet">Q</Button>
    <Button variant="link" size="responsive">L</Button>
    <Button variant="primary-muted">M</Button>
  </>)
  const soft = screen.getByRole('button', { name: 'S' })
  expect(soft.className).toContain('bg-red-500/20')
  expect(soft.className).toContain('px-3 py-1.5')
  expect(screen.getByRole('button', { name: 'Q' }).className).toContain('hover:text-white')
  const link = screen.getByRole('button', { name: 'L' })
  expect(link.className).toContain('text-blue-400')
  expect(link.className).toContain('md:px-3')
  expect(screen.getByRole('button', { name: 'M' }).className).toContain('bg-blue-600/50')
})
