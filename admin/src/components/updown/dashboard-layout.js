// Pure DOM helpers for the UpDown dashboard's above-the-fold navigation
// shortcuts (issue #507). Kept dependency-free and framework-agnostic so
// they can be unit tested without a JSX/DOM rendering pipeline.

export const SECTION_IDS = {
  position: 'updown-position-section',
  contractSetup: 'updown-contract-setup-section',
}

const FOCUSABLE_SELECTOR = 'input, textarea, select, button, [tabindex]'

// Scrolls the given section into view and moves focus to its first
// focusable control (falls back to the section itself). No-ops safely
// when the section isn't mounted yet or the environment lacks the APIs,
// so it is safe to call from click handlers before a ref has settled.
export function focusSection(sectionEl) {
  if (!sectionEl) return
  sectionEl.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  const target = sectionEl.querySelector?.(FOCUSABLE_SELECTOR) || sectionEl
  target.focus?.({ preventScroll: true })
}
