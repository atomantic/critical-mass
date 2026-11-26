import { useElementSize } from './chartMeasurement'

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
