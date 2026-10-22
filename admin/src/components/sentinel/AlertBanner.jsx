import { useState } from 'react'
import { Link } from '../../lib/router'
import { apiGet } from '../../utils/apiClient'
import { completePagedItems } from '../../utils/pagedList.mjs'
import usePolling from '../../hooks/usePolling'

/**
 * Compact alert banner shown globally when critical/warning sentinel alerts are active.
 * Keyboard-accessible link that navigates to /sentinel.
 */
export default function AlertBanner() {
  const [activeAlerts, setActiveAlerts] = useState([])

  const fetchAlerts = async () => {
      try {
        const { ok, data } = await apiGet('/api/sentinel/status')
        if (!ok) return
        if (data.criticalAlerts > 0 || data.warningAlerts > 0) {
          const { ok: alertsOk, data: alertsData } = await apiGet('/api/sentinel/alerts')
          if (!alertsOk) return
          const undismissed = (await completePagedItems('/api/sentinel/alerts', alertsData)).filter(a => !a.dismissed && (a.severity === 'critical' || a.severity === 'warning'))
          setActiveAlerts(prev => {
            // Skip update if alerts haven't changed
            if (prev.length === undismissed.length && prev.every((a, i) => a.id === undismissed[i]?.id)) return prev
            return undismissed.slice(0, 3)
          })
        } else {
          setActiveAlerts(prev => prev.length === 0 ? prev : [])
        }
      } catch {
        // silently fail
      }
  }
  usePolling(fetchAlerts, 30000)

  // The slot is always rendered as a zero-height anchor so alerts that arrive
  // after the first paint never push <main> down. The banner itself is fixed
  // to the bottom edge (beneath the toast stack, z-50) rather than floating
  // over the top of <main>, where it would cover the first row of content.
  if (activeAlerts.length === 0) return <div data-testid="alert-banner-slot" className="h-0" />

  const hasCritical = activeAlerts.some(a => a.severity === 'critical')

  return (
    <div data-testid="alert-banner-slot" className="h-0">
    <Link
      to="/sentinel"
      className={`fixed inset-x-0 bottom-0 z-40 inline-flex items-center gap-2 px-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-sm w-full shadow-lg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-offset-0 ${
        hasCritical
          ? 'bg-red-900/90 border-t border-red-700 text-red-100 focus-visible:ring-white'
          : 'bg-yellow-900/90 border-t border-yellow-700 text-yellow-100 focus-visible:ring-white'
      }`}
    >
      <span className="font-bold shrink-0">
        {hasCritical ? 'ALERT' : 'WARNING'}
      </span>
      <span className="truncate">
        {activeAlerts[0].title}
        {activeAlerts.length > 1 && ` (+${activeAlerts.length - 1} more)`}
      </span>
      <span className="ml-auto text-xs opacity-75 shrink-0">View details</span>
    </Link>
    </div>
  )
}
