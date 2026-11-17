import React from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// Issue #539: the celestial visualization honours prefers-reduced-motion, gives
// the operator a persisted pause control, and names its <canvas>.
const fiber = vi.hoisted(() => ({ canvasProps: [], scene: [], controls: [], useFrame: null }))
fiber.useFrame = vi.fn()
vi.mock('@react-three/fiber', () => ({
  useFrame: (...args) => fiber.useFrame(...args),
  useThree: (selector) => selector({ camera: { fov: 45 }, size: { width: 800, height: 500 }, invalidate() {} }),
  Canvas: ({ children, onCreated, frameloop }) => {
    fiber.canvasProps.push({ frameloop })
    const hostRef = React.useRef(null)
    React.useEffect(() => {
      const gl = { setClearColor() {}, domElement: document.createElement('canvas') }
      hostRef.current.appendChild(gl.domElement)
      onCreated({ gl })
    }, []) // eslint-disable-line react-hooks/exhaustive-deps
    return <div ref={hostRef} data-testid="canvas-host" data-frameloop={frameloop}>{children}</div>
  },
}))
vi.mock('../src/components/celestial/CelestialScene', () => ({
  default: (props) => { fiber.scene.push(props.reducedMotion); return null },
}))
vi.mock('../src/hooks/useCanvasActive', () => ({
  default: () => ({ active: true, everInView: true }),
  useCanvasActive: () => ({ active: true, everInView: true }),
}))

import CelestialVisualization from '../src/components/celestial/CelestialVisualization'
import useReducedMotion from '../src/hooks/useReducedMotion'

const celestial = { enabled: true, bodies: [{ id: 'a', tier: 'sun', costBasis: 100 }, { id: 'b', tier: 'planet', costBasis: 50 }, { id: 'c', tier: 'planet', costBasis: 40 }] }
let osReduced
let listeners
const stubMatchMedia = () => {
  listeners = new Set()
  window.matchMedia = vi.fn(() => ({
    matches: osReduced,
    addEventListener: (_e, fn) => listeners.add(fn),
    removeEventListener: (_e, fn) => listeners.delete(fn),
  }))
}
beforeEach(() => {
  osReduced = false
  stubMatchMedia()
  window.localStorage.clear()
  fiber.canvasProps.length = 0
  fiber.scene.length = 0
})
afterEach(() => { cleanup(); delete window.matchMedia })

it('defaults to paused, demand-driven rendering when the OS prefers reduced motion', () => {
  osReduced = true
  render(<CelestialVisualization celestial={celestial} />)
  const toggle = screen.getByRole('button', { name: 'Paused' })
  expect(toggle.getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByTestId('canvas-host').dataset.frameloop).toBe('demand')
  expect(fiber.scene.at(-1)).toBe(true)
})

it('animates by default and lets the operator pause, persisting the explicit choice over the OS preference', () => {
  render(<CelestialVisualization celestial={celestial} />)
  expect(screen.getByTestId('canvas-host').dataset.frameloop).toBe('always')
  const toggle = screen.getByRole('button', { name: 'Pause motion' })
  expect(toggle.getAttribute('aria-pressed')).toBe('false')
  expect(fiber.scene.at(-1)).toBe(false)

  fireEvent.click(toggle)
  expect(screen.getByRole('button', { name: 'Paused' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByTestId('canvas-host').dataset.frameloop).toBe('demand')
  expect(window.localStorage.getItem('celestial-motion-paused')).toBe('true')
  cleanup()

  // A stored "false" beats an OS preference for reduced motion on the next visit.
  window.localStorage.setItem('celestial-motion-paused', 'false')
  osReduced = true
  render(<CelestialVisualization celestial={celestial} />)
  expect(screen.getByRole('button', { name: 'Pause motion' }).getAttribute('aria-pressed')).toBe('false')
  expect(screen.getByTestId('canvas-host').dataset.frameloop).toBe('always')
})

it('names the real canvas element from the tier and order counts', () => {
  render(<CelestialVisualization celestial={celestial} pendingOrders={[{ side: 'buy', status: 'open' }]} />)
  const canvas = screen.getByRole('img', { name: /^Celestial system:/ })
  expect(canvas.tagName).toBe('CANVAS')
  expect(canvas.getAttribute('aria-label')).toBe('Celestial system: 1 sun, 2 planet, 1 incoming buy order')
})

it('does not use window.confirm or alert when toggling', () => {
  const confirm = vi.spyOn(window, 'confirm').mockImplementation(() => true)
  const alert = vi.spyOn(window, 'alert').mockImplementation(() => {})
  render(<CelestialVisualization celestial={celestial} />)
  fireEvent.click(screen.getByRole('button', { name: 'Pause motion' }))
  expect(confirm).not.toHaveBeenCalled()
  expect(alert).not.toHaveBeenCalled()
})

it('useReducedMotion follows live preference changes and unsubscribes on unmount', () => {
  const { result, unmount } = renderHook(() => useReducedMotion())
  expect(result.current).toBe(false)
  expect(listeners.size).toBe(1)
  act(() => { listeners.forEach(fn => fn({ matches: true })) })
  expect(result.current).toBe(true)
  unmount()
  expect(listeners.size).toBe(0)
})
