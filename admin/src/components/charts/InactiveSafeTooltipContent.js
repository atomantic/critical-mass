import { createElement } from 'react'
import { DefaultTooltipContent } from 'recharts'

/**
 * Recharts keeps its tooltip wrapper mounted while hidden. Avoid rendering
 * content until there is an active point, while retaining its default layout
 * and formatting for visible tooltips.
 */
export function hasVisibleTooltipPayload({ active, payload }) {
  return Boolean(active && Array.isArray(payload) && payload.some(entry => entry?.value != null))
}

export default function InactiveSafeTooltipContent(props) {
  if (!hasVisibleTooltipPayload(props)) return null
  return createElement(DefaultTooltipContent, props)
}
