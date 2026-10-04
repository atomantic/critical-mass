import { Link } from 'react-router-dom'
import { formatCurrency } from './charts/chartUtils'

// Closed fund summary link. Flex-wrap + min-w-0/break-words keep identity and
// result summary inside the card at any container width.
function ClosedFundCard({ card, icon, iconClass }) {
  return (
    <Link
      to={`/${card.exchange}/${card.pair}`}
      className="min-w-0 bg-gray-800/60 rounded-lg border border-gray-700/50 p-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 hover:bg-gray-800 transition-colors"
    >
      <div className="flex items-center gap-2 min-w-0 flex-1 basis-32">
        <span className={`w-6 h-6 flex items-center justify-center rounded shrink-0 text-sm ${iconClass}`}>
          {icon}
        </span>
        <div className="min-w-0 break-words [overflow-wrap:anywhere]">
          <span className="font-medium capitalize text-gray-400 text-sm">{card.exchange}</span>
          <span className="text-gray-400 mx-1">/</span>
          <span className="text-sm text-gray-400">{card.pair}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs min-w-0">
        <span className="text-gray-400">{card.cyclesCompleted} cycles</span>
        {card.realizedPnL !== 0 && (
          <span className={`font-mono ${card.realizedPnL >= 0 ? 'text-green-500' : 'text-red-500'}`}>
            {card.realizedPnL >= 0 ? '+' : ''}{formatCurrency(card.realizedPnL)}
          </span>
        )}
        <span className="px-1.5 py-0.5 rounded bg-gray-700 text-gray-400">Closed</span>
      </div>
    </Link>
  )
}

export default ClosedFundCard
