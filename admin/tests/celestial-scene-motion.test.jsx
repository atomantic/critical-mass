import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

// Issue #539: the scene stops auto-rotating under reduced motion, and the
// starfield layers are static (no per-frame animation hook).
const fiber = vi.hoisted(() => ({ controls: [], useFrame: null }))
fiber.useFrame = vi.fn()
vi.mock('@react-three/fiber', () => ({
  useFrame: (...args) => fiber.useFrame(...args),
  useThree: (selector) => selector({ camera: { fov: 45 }, size: { width: 800, height: 500 }, invalidate() {} }),
}))
vi.mock('../src/components/celestial/OrbitControlsLite', () => ({
  default: React.forwardRef((props, _ref) => { fiber.controls.push(props.autoRotate); return null }),
}))
vi.mock('../src/components/celestial/BloomEffect', () => ({ default: () => null }))
vi.mock('../src/components/celestial/HierarchicalOrbit', () => ({ default: () => null }))
vi.mock('../src/components/celestial/IncomingOrder', () => ({ default: () => null }))

import CelestialScene from '../src/components/celestial/CelestialScene'
import Starfield from '../src/components/celestial/Starfield'

afterEach(() => { cleanup(); fiber.controls.length = 0; vi.restoreAllMocks() })

it('auto-rotates only when motion is not reduced', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  render(<CelestialScene bodies={[]} reducedMotion={false} />)
  expect(fiber.controls.at(-1)).toBe(true)
  cleanup()
  render(<CelestialScene bodies={[]} reducedMotion />)
  expect(fiber.controls.at(-1)).toBe(false)
})

it('renders the starfield without subscribing to the frame loop', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  render(<CelestialScene bodies={[]} reducedMotion />)
  render(<Starfield count={10} />)
  expect(fiber.useFrame).not.toHaveBeenCalled()
})
