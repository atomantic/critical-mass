// One countdown formatter for the admin client. `style` picks the layout:
//   'compact' (default) -> "2d 3h 4m", "3h 4m 5s", "4m 5s", "5s"; "now" at/after zero
//   'clock'             -> "HH:MM:SS"; "00:00:00" at/after zero
//   'minutes'           -> "M:SS"; "0:00" at/after zero
export function formatCountdown(ms, style = 'compact') {
  const expired = !(ms > 0)
  const totalSeconds = expired ? 0 : Math.floor(ms / 1000)
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = totalMinutes % 60
  const totalHours = Math.floor(totalMinutes / 60)
  const pad = (n) => String(n).padStart(2, '0')

  if (style === 'clock') return `${pad(totalHours)}:${pad(minutes)}:${pad(seconds)}`
  if (style === 'minutes') return `${totalMinutes}:${pad(seconds)}`

  if (expired) return 'now'
  const days = Math.floor(totalHours / 24)
  if (days > 0) return `${days}d ${totalHours % 24}h ${minutes}m`
  if (totalHours > 0) return `${totalHours}h ${minutes}m ${seconds}s`
  if (totalMinutes > 0) return `${totalMinutes}m ${seconds}s`
  return `${seconds}s`
}
