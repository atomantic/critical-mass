import { expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const { stream } = vi.hoisted(() => ({
  stream: { logs: [], subscribed: false, clear: () => {}, flush: () => {}, flushing: false, flushResult: null, terminal: { reason: 'exited' }, retry: () => {} },
}))
vi.mock('../src/hooks/useLogStream', () => ({ useLogStream: () => stream }))
vi.mock('../src/components/Toast', () => ({ useToast: () => ({ addToast: () => {} }) }))

import LogViewer from '../src/components/LogViewer'

it('gives the LogViewer toolbar buttons touch-sized targets that reset only for fine pointers on desktop', () => {
  render(<LogViewer processName="test-process" />)
  for (const name of ['Retry', 'Clear', 'Flush', 'Fullscreen']) {
    const button = screen.getByRole('button', { name })
    expect(button.className).toContain('min-h-11')
    expect(button.className).toContain('min-w-11')
    expect(button.className).toContain('md:pointer-fine:min-h-0')
    expect(button.className).toContain('md:pointer-fine:min-w-0')
  }
})
