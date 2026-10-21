const COLORS = {
  gray: 'bg-gray-800 border-gray-700',
  blue: 'bg-blue-900/50 border-blue-700',
  green: 'bg-green-900/50 border-green-700',
  yellow: 'bg-yellow-900/50 border-yellow-700',
  purple: 'bg-purple-900/50 border-purple-700',
  red: 'bg-red-900/50 border-red-700',
}

// Small label/value tile. A null/undefined value renders as '---'.
export default function StatCard({ label, value, subtext, color = 'gray' }) {
  return (
    <div className={`p-2 rounded-lg border min-w-0 overflow-hidden ${COLORS[color] ?? COLORS.gray}`}>
      <div className="text-xs text-gray-400 truncate">{label}</div>
      <div className="text-sm sm:text-base font-bold truncate">{value ?? '---'}</div>
      {subtext && <div className="text-xs text-gray-400 overflow-hidden">{subtext}</div>}
    </div>
  )
}
