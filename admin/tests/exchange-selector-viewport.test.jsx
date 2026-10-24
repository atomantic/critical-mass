import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ExchangeSelector from '../src/components/ExchangeSelector'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const exchanges = Array.from({ length: 12 }, (_, index) => ({ name: 'coinbase', pair: `ASSET${index}-USD` }))
function setup() {
  render(<ExchangeSelector currentExchange="coinbase" currentPair="ASSET0-USD" exchanges={exchanges} onChange={vi.fn()} onAddFund={vi.fn()} onRefresh={vi.fn()} />)
  const trigger = screen.getAllByRole('button')[0]
  vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ bottom: 153, right: 624 })
  fireEvent.click(trigger)
  return { trigger, popup: document.getElementById('exchange-selector-options') }
}

it('bounds the entire popup including footer actions at a short viewport', () => {
  vi.stubGlobal('innerWidth', 640)
  vi.stubGlobal('innerHeight', 360)
  const { popup, trigger } = setup()
  expect(popup.style.top).toBe('161px')
  expect(popup.style.left).toBe('16px')
  expect(popup.style.width).toBe('608px')
  expect(popup.style.maxHeight).toBe('183px')
  expect(popup.classList.contains('overflow-y-auto')).toBe(true)
  expect(popup.contains(screen.getByRole('button', { name: 'Add Fund' }))).toBe(true)
  expect(popup.contains(screen.getByRole('button', { name: 'Refresh Exchanges' }))).toBe(true)
  screen.getByRole('button', { name: 'Refresh Exchanges' }).focus()
  fireEvent.keyDown(document.activeElement, { key: 'Escape' })
  expect(document.getElementById('exchange-selector-options')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

it('recalculates desktop bounds on resize, ancestor scroll, and reopening', () => {
  vi.stubGlobal('innerWidth', 1280)
  vi.stubGlobal('innerHeight', 720)
  const { popup, trigger } = setup()
  expect(popup.style.width).toBe('320px')
  vi.stubGlobal('innerHeight', 240)
  fireEvent(window, new Event('resize'))
  expect(popup.style.top).toBe('64px')
  expect(popup.style.maxHeight).toBe('160px')
  trigger.getBoundingClientRect.mockReturnValue({ bottom: 30, right: 10 })
  fireEvent.scroll(document)
  expect(popup.style.top).toBe('38px')
  expect(popup.style.left).toBe('16px')
  fireEvent.click(trigger)
  vi.stubGlobal('innerWidth', 300)
  fireEvent.click(trigger)
  expect(document.getElementById('exchange-selector-options').style.width).toBe('268px')
})

it('tracks visual viewport changes, including zoom and viewport panning', () => {
  const viewport = Object.assign(new EventTarget(), { width: 640, height: 360, offsetLeft: 20, offsetTop: 40 })
  vi.stubGlobal('visualViewport', viewport)
  const { popup } = setup()
  expect(popup.style.left).toBe('36px')
  expect(popup.style.maxHeight).toBe('223px')
  viewport.height = 200
  viewport.offsetTop = 80
  fireEvent(viewport, new Event('resize'))
  expect(popup.style.top).toBe('104px')
  expect(popup.style.maxHeight).toBe('160px')
  viewport.offsetLeft = 70
  fireEvent(viewport, new Event('scroll'))
  expect(popup.style.left).toBe('86px')
})
