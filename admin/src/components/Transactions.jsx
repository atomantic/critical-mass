import { useState } from 'react'
import { formatCurrency, formatPrice } from './charts/chartUtils'

function Transactions({ transactions = [], quoteCurrency = 'USDC' }) {
  const [filter, setFilter] = useState('all')
  const [sortField, setSortField] = useState('Date')
  const [sortDir, setSortDir] = useState('desc')

  // Map data keys to display names (for dynamic currency)
  const getDisplayName = (key) => {
    if (key === 'USDC Amount') return `${quoteCurrency} Amount`
    return key
  }

  const filteredTx = transactions.filter(tx => {
    if (filter === 'all') return true
    return tx.Type === filter
  })

  const sortedTx = [...filteredTx].sort((a, b) => {
    const aVal = a[sortField]
    const bVal = b[sortField]
    const dir = sortDir === 'asc' ? 1 : -1
    if (typeof aVal === 'number') return (aVal - bVal) * dir
    return String(aVal).localeCompare(String(bVal)) * dir
  })

  const handleSort = (field) => {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDir('desc')
    }
  }

  // formatCurrency for totals, formatPrice for per-unit prices
  const formatBTC = (n) => (n || 0).toFixed(8)

  const typeColors = {
    BUY: 'text-blue-400',
    SELL_ORDER: 'text-yellow-400',
    SELL_FILLED: 'text-green-400',
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex gap-2">
        {['all', 'BUY', 'SELL_ORDER', 'SELL_FILLED'].map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1 rounded text-sm ${
              filter === f
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            {f === 'all' ? 'All' : f.replace('_', ' ')}
          </button>
        ))}
        <span className="ml-auto text-gray-400 text-sm">
          {sortedTx.length} transactions
        </span>
      </div>

      {/* Table */}
      <div className="bg-gray-800 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-700 text-gray-300 text-left">
                {['Date', 'Type', 'Price', 'BTC Amount', 'USDC Amount', 'Fees', 'Rebates', 'Net Fees', 'Fund Size'].map(col => (
                  <th
                    key={col}
                    onClick={() => handleSort(col)}
                    className="px-4 py-3 cursor-pointer hover:bg-gray-600"
                  >
                    <div className="flex items-center gap-1">
                      {getDisplayName(col)}
                      {sortField === col && (
                        <span>{sortDir === 'asc' ? '↑' : '↓'}</span>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedTx.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
                    No transactions found
                  </td>
                </tr>
              ) : (
                sortedTx.map((tx, i) => (
                  <tr key={i} className="border-t border-gray-700 hover:bg-gray-700/50">
                    <td className="px-4 py-3">{tx.Date}</td>
                    <td className={`px-4 py-3 font-medium ${typeColors[tx.Type] || ''}`}>
                      {tx.Type}
                    </td>
                    <td className="px-4 py-3">{formatPrice(tx.Price)}</td>
                    <td className="px-4 py-3 font-mono">
                      <span className={tx['BTC Amount'] >= 0 ? 'text-green-400' : 'text-red-400'}>
                        {tx['BTC Amount'] >= 0 ? '+' : ''}{formatBTC(tx['BTC Amount'])}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={tx['USDC Amount'] >= 0 ? 'text-green-400' : 'text-red-400'}>
                        {tx['USDC Amount'] >= 0 ? '+' : ''}{formatCurrency(tx['USDC Amount'])}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-red-400">{formatCurrency(tx.Fees)}</td>
                    <td className="px-4 py-3 text-green-400">{formatCurrency(tx.Rebates)}</td>
                    <td className="px-4 py-3">{formatCurrency(tx['Net Fees'])}</td>
                    <td className="px-4 py-3">{formatCurrency(tx['Fund Size'])}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Summary */}
      {sortedTx.length > 0 && (
        <div className="bg-gray-800 rounded-lg p-4">
          <h3 className="text-sm font-medium text-gray-400 mb-3">Summary</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-gray-500">Total {quoteCurrency} Spent:</span>
              <span className="ml-2 text-white">
                {formatCurrency(sortedTx
                  .filter(t => t.Type === 'BUY')
                  .reduce((sum, t) => sum + Math.abs(t['USDC Amount'] || 0), 0)
                )}
              </span>
            </div>
            <div>
              <span className="text-gray-500">Total {quoteCurrency} Received:</span>
              <span className="ml-2 text-white">
                {formatCurrency(sortedTx
                  .filter(t => t.Type === 'SELL_FILLED')
                  .reduce((sum, t) => sum + (t['USDC Amount'] || 0), 0)
                )}
              </span>
            </div>
            <div>
              <span className="text-gray-500">Total Fees:</span>
              <span className="ml-2 text-red-400">
                {formatCurrency(sortedTx.reduce((sum, t) => sum + (t.Fees || 0), 0))}
              </span>
            </div>
            <div>
              <span className="text-gray-500">Total Rebates:</span>
              <span className="ml-2 text-green-400">
                {formatCurrency(sortedTx.reduce((sum, t) => sum + (t.Rebates || 0), 0))}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Transactions
