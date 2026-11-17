import React, { useRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import useCanvasActive from '../src/hooks/useCanvasActive'

let observers
let visibility

class MockIO {
  constructor(cb) { this.cb = cb; this.disconnected = false; observers.push(this) }
  observe() {}
  disconnect() { this.disconnected = true }
  fire(isIntersecting) { this.cb([{ isIntersecting }]) }
}

function Probe({ out }) {
  const ref = useRef(null)
  Object.assign(out, useCanvasActive(ref))
  return <div ref={ref} />
}

beforeEach(() => {
  observers = []
  visibility = 'visible'
  vi.stubGlobal('IntersectionObserver', MockIO)
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const setVisibility = (v) => act(() => { visibility = v; document.dispatchEvent(new Event('visibilitychange')) })

it('is inactive until the element intersects, then active', () => {
  const out = {}
  render(<Probe out={out} />)
  expect(out.active).toBe(false)
  expect(out.everInView).toBe(false)
  act(() => observers[0].fire(true))
  expect(out.active).toBe(true)
  expect(out.everInView).toBe(true)
})

it('goes inactive when scrolled away but remembers it was in view', () => {
  const out = {}
  render(<Probe out={out} />)
  act(() => observers[0].fire(true))
  act(() => observers[0].fire(false))
  expect(out.active).toBe(false)
  expect(out.everInView).toBe(true)
})

it('goes inactive when the tab is hidden and resumes when visible', () => {
  const out = {}
  render(<Probe out={out} />)
  act(() => observers[0].fire(true))
  setVisibility('hidden')
  expect(out.active).toBe(false)
  setVisibility('visible')
  expect(out.active).toBe(true)
})

it('disconnects the observer on unmount', () => {
  const out = {}
  const { unmount } = render(<Probe out={out} />)
  unmount()
  expect(observers[0].disconnected).toBe(true)
})

it('falls back to visibility-only tracking without IntersectionObserver', () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  const out = {}
  render(<Probe out={out} />)
  expect(out.active).toBe(true)
  expect(out.everInView).toBe(true)
  setVisibility('hidden')
  expect(out.active).toBe(false)
})
