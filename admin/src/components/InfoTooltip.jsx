import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const MARGIN = 8
const GAP = 8

// Compute a viewport-bounded fixed position for a popup anchored to a trigger.
// `align` is only a preference: the result is always clamped inside the viewport.
export function computeTooltipPosition({ trigger, popup, viewport, align = 'center', maxWidth = 208 }) {
  const width = Math.max(0, Math.min(maxWidth, viewport.width - MARGIN * 2))
  let left = align === 'left' ? trigger.left
    : align === 'right' ? trigger.right - width
    : trigger.left + trigger.width / 2 - width / 2
  left = Math.max(MARGIN, Math.min(left, viewport.width - MARGIN - width))

  const maxHeight = Math.max(0, viewport.height - MARGIN * 2)
  const height = Math.min(popup.height, maxHeight)
  const spaceAbove = trigger.top - GAP - MARGIN
  const spaceBelow = viewport.height - trigger.bottom - GAP - MARGIN
  let top = spaceAbove >= height || spaceAbove >= spaceBelow ? trigger.top - GAP - height : trigger.bottom + GAP
  top = Math.max(MARGIN, Math.min(top, viewport.height - MARGIN - height))
  return { left, top, width, maxHeight }
}

const WIDTHS = { 'w-52': 208, 'w-72': 288, 'w-80': 320 }

// Info icon + help popup. Closed content is not mounted, so it never affects layout.
export default function InfoTooltip({ tip, label = 'More information', align = 'center', width = 'w-52', iconClassName = 'w-3 h-3', className = 'ml-1' }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const triggerRef = useRef(null)
  const popupRef = useRef(null)
  const id = useId()
  const descriptionId = `${id}-description`
  const maxWidth = WIDTHS[width] || WIDTHS['w-52']

  const reposition = useCallback(() => {
    if (!triggerRef.current || !popupRef.current) return
    setPos(computeTooltipPosition({
      trigger: triggerRef.current.getBoundingClientRect(),
      popup: { height: popupRef.current.scrollHeight },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      align,
      maxWidth,
    }))
  }, [align, maxWidth])

  useLayoutEffect(() => {
    if (open) reposition()
    else setPos(null)
  }, [open, reposition])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    const onPointerDown = (e) => {
      if (triggerRef.current?.contains(e.target) || popupRef.current?.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open, reposition])

  const hoverOpen = (e) => { if (e.pointerType === 'mouse') setOpen(true) }
  const hoverClose = (e) => { if (e.pointerType === 'mouse' && document.activeElement !== triggerRef.current) setOpen(false) }

  return (
    <span className={`relative inline-flex align-middle ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={descriptionId}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(o => !o)}
        onPointerEnter={hoverOpen}
        onPointerLeave={hoverClose}
        className="relative inline-flex items-center justify-center cursor-help text-gray-400 hover:text-gray-200 focus-visible:text-gray-200 focus-visible:outline focus-visible:outline-1 focus-visible:outline-gray-400 rounded-full transition-colors [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-4 [@media(pointer:coarse)]:after:content-['']"
      >
        <svg className={iconClassName} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4M12 8h.01" />
        </svg>
      </button>
      <span id={descriptionId} className="sr-only" hidden>{tip}</span>
      {open && createPortal(
        <div
          ref={popupRef}
          id={id}
          role="tooltip"
          onPointerEnter={hoverOpen}
          onPointerLeave={hoverClose}
          style={pos
            ? { left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxHeight }
            : { left: MARGIN, top: MARGIN, width: Math.min(maxWidth, (typeof window === 'undefined' ? maxWidth : window.innerWidth) - MARGIN * 2), visibility: 'hidden' }}
          className="fixed overflow-y-auto overscroll-contain break-words px-3 py-2 bg-gray-900 border border-gray-700 text-xs text-gray-300 rounded-lg shadow-lg z-50 space-y-0.5 leading-snug text-left normal-case font-normal"
        >
          {tip}
        </div>,
        document.body
      )}
    </span>
  )
}
