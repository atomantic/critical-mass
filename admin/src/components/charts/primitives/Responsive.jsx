import { useCallback, useLayoutEffect, useState } from 'react'

const ZERO = { width: 0, height: 0 }

// Content-box size: the client box minus padding, so charts inside padded cards fit.
function contentSize(node) {
  const style = getComputedStyle(node)
  const pad = (a, b) => (parseFloat(style[a]) || 0) + (parseFloat(style[b]) || 0)
  return {
    width: node.clientWidth - pad('paddingLeft', 'paddingRight'),
    height: node.clientHeight - pad('paddingTop', 'paddingBottom'),
  }
}

/**
 * Tracks an element's content-box size. Returns a callback ref (so swapping the measured
 * element between placeholder and chart branches keeps observing the live one) and
 * the latest { width, height }; both are 0 until the element mounts.
 */
export function useElementSize() {
  const [node, setNode] = useState(null)
  const [size, setSize] = useState(ZERO)
  const ref = useCallback((el) => setNode(el), [])

  useLayoutEffect(() => {
    if (!node) return undefined
    const measure = () => {
      const next = contentSize(node)
      setSize((prev) => (prev.width === next.width && prev.height === next.height ? prev : next))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [node])

  return [ref, size]
}

/**
 * Full-width block that renders its child with the measured size once laid out.
 * `height` is pixels, or a CSS length (e.g. "100%") whose resolved size is measured.
 */
export function Responsive({ height, className, children }) {
  const [ref, size] = useElementSize()
  const resolved = { width: size.width, height: typeof height === 'number' ? height : size.height }
  return (
    <div ref={ref} className={className} style={{ width: '100%', height }}>
      {resolved.width > 0 && resolved.height > 0 && children(resolved)}
    </div>
  )
}

// Pointer position relative to the element the handler is attached to.
export function localPoint(event) {
  const rect = event.currentTarget.getBoundingClientRect()
  return [event.clientX - rect.left, event.clientY - rect.top]
}

// Clip-path ids must be valid url(#…) fragments; React ids may contain other characters.
export const svgId = (prefix, reactId) => `${prefix}-${reactId.replace(/[^\w-]/g, '')}`
