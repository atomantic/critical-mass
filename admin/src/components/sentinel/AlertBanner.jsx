import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'

/**
 * Compact alert banner shown globally when critical/warning sentinel alerts are active.
 * Keyboard-accessible link that navigates to /sentinel.
 */
export default function AlertBanner() {
  const [activeAlerts, setActiveAlerts] = useState([])

  useEffect(() => {
    const fetchAlerts = async () => {
      try {
        const res = await fetch('/api/sentinel/status')
        if (!res.ok) return
        const data = await res.json()
        if (data.criticalAlerts > 0 || data.warningAlerts > 0) {
          const alertsRes = await fetch('/api/sentinel/alerts')
          if (!alertsRes.ok) return
          const alertsData = await alertsRes.json()
          const undismissed = (alertsData.alerts || []).filter(a => !a.dismissed && (a.severity === 'critical' || a.severity === 'warning'))
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

    fetchAlerts()
    const interval = setInterval(fetchAlerts, 30000)
    return () => clearInterval(interval)
  }, [])

  if (activeAlerts.length === 0) return null

  const hasCritical = activeAlerts.some(a => a.severity === 'critical')

  return (
    <Link
      to="/sentinel"
      className={`inline-flex items-center gap-2 px-4 py-2 text-sm w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-0 ${
        hasCritical
          ? 'bg-red-900/70 border-b border-red-700 text-red-100 focus-visible:ring-white'
          : 'bg-yellow-900/70 border-b border-yellow-700 text-yellow-100 focus-visible:ring-white'
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
  )
}
