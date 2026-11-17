import { useState, useEffect } from 'react'

const isDocumentVisible = () =>
  typeof document === 'undefined' || document.visibilityState !== 'hidden'

/**
 * Returns `{ active, everInView }`. `active` is true while the element behind
 * `ref` intersects the viewport AND the document is visible, so decorative
 * WebGL canvases can stop rendering frames nobody can see. `everInView`
 * latches true the first time the element is seen, so callers can lazy-mount
 * heavy content and keep it mounted. Where IntersectionObserver is
 * unavailable only tab visibility is tracked (the element is assumed in view).
 * The element must be mounted together with the calling component.
 */
export function useCanvasActive(ref) {
  const [inView, setInView] = useState(
    () => typeof IntersectionObserver === 'undefined'
  )
  const [tabVisible, setTabVisible] = useState(isDocumentVisible)
  const [everInView, setEverInView] = useState(
    () => typeof IntersectionObserver === 'undefined'
  )

  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (!entry) return
      setInView(entry.isIntersecting)
      if (entry.isIntersecting) setEverInView(true)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])

  useEffect(() => {
    if (typeof document === 'undefined') return
    const onChange = () => setTabVisible(isDocumentVisible())
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])

  return { active: inView && tabVisible, everInView }
}

export default useCanvasActive
