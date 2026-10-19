import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import * as icons from '../src/components/icons'
import recorded from './fixtures-lucide-icons.json'

// recorded = icon node data captured from lucide-react@0.574.0 before removal
describe('vendored icons', () => {
  it('exports exactly the recorded icon set', () => {
    expect(Object.keys(icons).sort()).toEqual(Object.keys(recorded).sort())
  })

  it.each(Object.entries(recorded))('%s matches lucide output', (name, nodes) => {
    const Icon = icons[name]
    const { container } = render(<Icon />)
    const svg = container.querySelector('svg')
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(svg.getAttribute('width')).toBe('24')
    expect(svg.getAttribute('height')).toBe('24')
    expect(svg.getAttribute('fill')).toBe('none')
    expect(svg.getAttribute('stroke')).toBe('currentColor')
    expect(svg.getAttribute('stroke-width')).toBe('2')
    expect(svg.getAttribute('stroke-linecap')).toBe('round')
    expect(svg.getAttribute('stroke-linejoin')).toBe('round')
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    const actual = [...svg.children].map(el => [el.tagName.toLowerCase(), Object.fromEntries([...el.attributes].map(a => [a.name, a.value]))])
    expect(actual).toEqual(nodes)
  })

  it('honours size, strokeWidth, className and spread props', () => {
    const { container } = render(<icons.Plus size={12} strokeWidth={3} className="x" data-testid="p" aria-hidden="false" />)
    const svg = container.querySelector('svg')
    expect(svg.getAttribute('width')).toBe('12')
    expect(svg.getAttribute('stroke-width')).toBe('3')
    expect(svg.getAttribute('class')).toBe('x')
    expect(svg.getAttribute('data-testid')).toBe('p')
    expect(svg.getAttribute('aria-hidden')).toBe('false')
  })
})
