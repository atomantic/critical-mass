import { useState } from 'react'
import { DISCLOSURE_CARD_FIELDS, countChangedFromDefault, hasUnsavedEdit, readStoredOpen, writeStoredOpen } from '../../utils/regimeCardState.mjs'

// A SectionCard that is collapsed by default. Native <details>/<summary> gives
// keyboard and screen-reader operation for free. The card is held open while it
// contains an unsaved edit or a field the server rejected, so neither can hide
// behind a collapsed header. `disclosure` is built once by ConfigEditor.
export default function DisclosureCard({ cardId, title, className = '', disclosure, children }) {
  const keys = DISCLOSURE_CARD_FIELDS[cardId]
  const { regimeConfig, baseline, defaults, errorKeys = [] } = disclosure
  const [userOpen, setUserOpen] = useState(() => readStoredOpen(cardId))
  const changed = countChangedFromDefault(keys, regimeConfig, defaults)
  const pinned = hasUnsavedEdit(keys, regimeConfig, baseline) || keys.some(key => errorKeys.includes(key))
  const open = pinned || userOpen
  const toggle = (event) => {
    event.preventDefault() // React owns `open`; the browser must not also flip it
    if (pinned) return
    setUserOpen(!open)
    writeStoredOpen(cardId, !open)
  }
  return (
    <details open={open} className={`bg-gray-900/40 rounded-lg p-4 ${className}`}>
      <summary onClick={toggle} className="flex flex-wrap items-center gap-2 cursor-pointer select-none min-h-6 rounded-sm focus-visible:outline-2 focus-visible:outline-blue-500">
        <h3 className="text-sm font-medium text-purple-400">{title}</h3>
        {changed > 0 && <span className="text-xs text-amber-300 bg-amber-900/30 rounded-full px-2 py-0.5">{changed} changed from default</span>}
        <span className="ml-auto text-xs text-gray-400">{open ? 'Hide' : 'Show'}</span>
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  )
}
