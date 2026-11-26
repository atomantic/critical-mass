export const MARGIN = 8
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
