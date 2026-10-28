import { useState, useEffect, useRef } from 'react'
import Button from '../ui/Button'
import { Link } from '../../lib/router'
import { apiGet } from '../../utils/apiClient'
import { completePagedItems } from '../../utils/pagedList.mjs'
import useRealtimeRefresh from '../../hooks/useRealtimeRefresh'

/**
 * Compact alert banner shown globally when critical/warning sentinel alerts are active.
 * Keyboard-accessible link that navigates to /sentinel.
 */
export default function AlertBanner() {
  const [activeAlerts, setActiveAlerts] = useState([])
  const [loadError, setLoadError] = useState(null)
  const [politeAnnouncement, setPoliteAnnouncement] = useState({ text: '', revision: 0 })
  const [assertiveAnnouncement, setAssertiveAnnouncement] = useState({ text: '', revision: 0 })
  const alertSnapshot = useRef({ initialized: false, alerts: [] })
  const bannerRef = useRef(null)
  const pending = useRef(false)
  const rerun = useRef(false)
  const [loading, setLoading] = useState(false)
  const visible = activeAlerts.length > 0 || !!loadError

  // The banner is fixed (out of flow), so reserve its height as body padding
  // while visible; otherwise it permanently covers the last rows of the page.
  useEffect(() => {
    if (!visible) return undefined
    const prev = document.body.style.paddingBottom
    document.body.style.paddingBottom = `${bannerRef.current?.offsetHeight || 40}px`
    return () => { document.body.style.paddingBottom = prev }
  }, [visible])

  const fetchAlerts = async () => {
    // A change that lands mid-read must not be lost: re-read once this one ends.
    if (pending.current) { rerun.current = true; return }
    pending.current = true
    setLoading(true)
    try {
      const { ok, data } = await apiGet('/api/sentinel/status')
      if (!ok) throw new Error('Status unavailable')
      if (data.criticalAlerts > 0 || data.warningAlerts > 0) {
        const { ok: alertsOk, data: alertsData } = await apiGet('/api/sentinel/alerts')
        if (!alertsOk) throw new Error('Alerts unavailable')
        const undismissed = (await completePagedItems('/api/sentinel/alerts', alertsData))
          .filter(a => !a.dismissed && (a.severity === 'critical' || a.severity === 'warning'))
        const nextAlerts = undismissed
        const previous = alertSnapshot.current
        let changed = []
        let removed = []
        if (previous.initialized) {
          const before = new Map(previous.alerts.map((alert, index) => [alert.id ?? `${alert.title}-${index}`, alert]))
          const after = new Map(nextAlerts.map((alert, index) => [alert.id ?? `${alert.title}-${index}`, alert]))
          changed = [...after].filter(([id, alert]) => {
            const old = before.get(id)
            return !old || old.severity !== alert.severity
          }).map(([, alert]) => alert)
          removed = [...before].filter(([id]) => !after.has(id)).map(([, alert]) => alert)
        } else {
          changed = nextAlerts
        }
        if (changed.length || removed.length) {
          const criticalCount = nextAlerts.filter(alert => alert.severity === 'critical').length
          const warningCount = nextAlerts.filter(alert => alert.severity === 'warning').length
          let message
          if (nextAlerts.length === 0) {
            message = `All ${removed.length} active Sentinel alert${removed.length === 1 ? '' : 's'} cleared.`
          } else {
            const summary = [
              criticalCount && `${criticalCount} critical alert${criticalCount === 1 ? '' : 's'}`,
              warningCount && `${warningCount} warning${warningCount === 1 ? '' : 's'}`,
            ].filter(Boolean).join(' and ')
            const titles = changed.slice(0, 3).map(alert => alert.title).filter(Boolean).join('; ')
            const additionalTitles = Math.max(0, changed.length - 3)
            const changes = [
              removed.length && `${removed.length} alert${removed.length === 1 ? '' : 's'} cleared`,
              `${summary}${titles ? `: ${titles}${additionalTitles ? `, and ${additionalTitles} more` : ''}` : ''}`,
            ].filter(Boolean).join('. ')
            message = `${changes}. View details in Sentinel.`
          }
          const urgent = changed.some(alert => alert.severity === 'critical') || removed.some(alert => alert.severity === 'critical')
          setAssertiveAnnouncement(current => ({ text: urgent ? message : '', revision: current.revision + 1 }))
          setPoliteAnnouncement(current => ({ text: urgent ? '' : message, revision: current.revision + 1 }))
        }
        alertSnapshot.current = { initialized: true, alerts: nextAlerts }
        setActiveAlerts(nextAlerts.slice(0, 3))
      } else {
        const previous = alertSnapshot.current
        if (previous.initialized && previous.alerts.length) {
          const message = `All ${previous.alerts.length} active Sentinel alert${previous.alerts.length === 1 ? '' : 's'} cleared.`
          const urgent = previous.alerts.some(alert => alert.severity === 'critical')
          setAssertiveAnnouncement(current => ({ text: urgent ? message : '', revision: current.revision + 1 }))
          setPoliteAnnouncement(current => ({ text: urgent ? '' : message, revision: current.revision + 1 }))
        }
        alertSnapshot.current = { initialized: true, alerts: [] }
        setActiveAlerts([])
      }
      setLoadError(null)
    } catch {
      setLoadError('Sentinel alerts unavailable.')
    } finally {
      pending.current = false
      setLoading(false)
      if (rerun.current) {
        rerun.current = false
        fetchAlerts()
      }
    }
  }
  // Initial read, then re-read when the gateway reports a new alert or a status
  // change (dismiss, clear) rather than on a timer (#1880).
  useEffect(() => {
    fetchAlerts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useRealtimeRefresh({ events: ['sentinel:alert', 'sentinel:status'], rooms: ['sentinel'], onRefresh: fetchAlerts })

  // The slot is always rendered as a zero-height anchor so alerts that arrive
  // after the first paint never push <main> down. The banner itself is fixed
  // to the bottom edge (beneath the toast stack, z-50) rather than floating
  // over the top of <main>, where it would cover the first row of content.
  const hasCritical = activeAlerts.some(a => a.severity === 'critical')

  return (
    <>
    <div data-testid="alert-banner-slot" className="h-0">
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only"><span key={politeAnnouncement.revision}>{politeAnnouncement.text}</span></div>
      <div role="alert" aria-live="assertive" aria-atomic="true" className="sr-only"><span key={assertiveAnnouncement.revision}>{assertiveAnnouncement.text}</span></div>
    </div>
    {visible && <div
      ref={bannerRef}
      className={`fixed inset-x-0 bottom-0 z-40 inline-flex items-center gap-2 px-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-sm w-full shadow-lg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-offset-0 ${
        hasCritical
          ? 'bg-red-900/90 border-t border-red-700 text-red-100 focus-visible:ring-white'
          : 'bg-yellow-900/90 border-t border-yellow-700 text-yellow-100 focus-visible:ring-white'
      }`}
    >
    <Link to="/sentinel" className="inline-flex items-center gap-2 min-w-0 flex-1">
      <span className="font-bold shrink-0">
        {hasCritical ? 'ALERT' : 'WARNING'}
      </span>
      <span className="truncate">
        {activeAlerts[0]?.title || 'Active alert details unavailable.'}
        {loadError && <span role="alert"> {loadError}</span>}
        {activeAlerts.length > 1 && ` (+${activeAlerts.length - 1} more)`}
      </span>
      <span className="ml-auto text-xs opacity-75 shrink-0">View details</span>
    </Link>
    {loadError && <Button onClick={fetchAlerts} disabled={loading} variant="link" size="compact" touchTarget="always">{loading ? 'Loading...' : 'Retry'}</Button>}
    </div>}
    </>
  )
}
