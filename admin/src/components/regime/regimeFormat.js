// Display formatters shared by RegimeDashboard and its extracted sections.
import { formatLocalStamp } from '../../utils/format.mjs'

// Format duration in human readable form
export const formatDuration = (ms) => {
  if (!ms || ms < 0) return '0s'
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)

  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

// Format timestamp as YYYY-MM-DD HH:MM:SS local time
export const formatTimestamp = (ts) => (ts ? formatLocalStamp(ts) : '-')
