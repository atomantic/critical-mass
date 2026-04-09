import { useState, useEffect, useRef } from 'react'

/**
 * AddFundModal — create a new (exchange, pair) fund.
 *
 * The modal lets the operator pick an exchange that has API keys configured,
 * type a pair (e.g. "ETH-USDC"), set an initial allocation, and choose
 * dry-run mode. The new fund is created via POST /api/:exchange/funds and
 * starts disabled — the operator must explicitly enable + start it from the
 * fund's dashboard.
 */
function AddFundModal({ open, onClose, onCreated, exchanges = [] }) {
  // Default to the first exchange that has API keys configured (we infer
  // this from the existing exchanges list — any exchange listed is configured).
  const exchangeNames = Array.from(new Set((exchanges || []).map(e => e.name)))
  const [exchange, setExchange] = useState(exchangeNames[0] || 'gemini')
  const [pair, setPair] = useState('')
  const [totalAllocation, setTotalAllocation] = useState('5000')
  const [dryRun, setDryRun] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)

  useEffect(() => {
    if (open) {
      setError(null)
      setPair('')
      setTotalAllocation('5000')
      setDryRun(true)
      setExchange(exchangeNames[0] || 'gemini')
      // Focus the pair input on open
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Per-exchange hint about pair format conventions
  const pairHint = {
    coinbase: 'Coinbase format: BASE-QUOTE (e.g. ETH-USDC, SOL-USDC)',
    gemini: 'Gemini format: BASEQUOTE all uppercase (e.g. ETHUSD, SOLUSD)',
    cryptocom: 'Crypto.com format: BASE_QUOTE (e.g. ETH_USD, SOL_USD)',
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(null)

    const trimmedPair = pair.trim()
    if (!trimmedPair) {
      setError('Pair is required')
      return
    }
    // Light client-side format validation matching the server regex
    if (!/^[A-Z0-9]+[-_][A-Z0-9]+$/.test(trimmedPair) && !/^[A-Z0-9]{6,}$/.test(trimmedPair)) {
      setError('Pair must use BASE-QUOTE, BASE_QUOTE, or BASEQUOTE format (uppercase)')
      return
    }
    const allocation = parseFloat(totalAllocation)
    if (isNaN(allocation) || allocation <= 0) {
      setError('Total allocation must be a positive number')
      return
    }

    setSubmitting(true)
    try {
      const res = await fetch(`/api/${exchange}/funds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pair: trimmedPair,
          productId: trimmedPair,
          totalAllocation: allocation,
          dryRun,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Failed to create fund')
        setSubmitting(false)
        return
      }
      onCreated?.({ exchange, pair: trimmedPair })
      onClose?.()
    } catch (err) {
      setError(err.message || 'Network error')
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="bg-gray-800 rounded-lg border border-gray-700 shadow-xl w-full max-w-md p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold text-white mb-4">Add Fund</h2>
        <p className="text-sm text-gray-400 mb-4">
          Create a new trading fund on an existing exchange. The fund starts <span className="text-yellow-400">disabled</span> and in <span className="text-purple-400">dry-run mode</span> by default — enable it manually from the fund dashboard once you've reviewed the config.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs uppercase tracking-wider text-gray-400 mb-1">Exchange</label>
            <select
              value={exchange}
              onChange={(e) => setExchange(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
              disabled={submitting}
            >
              {exchangeNames.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wider text-gray-400 mb-1">Pair</label>
            <input
              ref={inputRef}
              type="text"
              value={pair}
              onChange={(e) => setPair(e.target.value.toUpperCase())}
              placeholder="ETHUSD, ETH-USDC, ETH_USD"
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-white font-mono focus:border-blue-500 focus:outline-none"
              disabled={submitting}
              autoComplete="off"
            />
            <div className="text-xs text-gray-500 mt-1">{pairHint[exchange] || 'Enter the trading pair as it appears on the exchange.'}</div>
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wider text-gray-400 mb-1">Total Allocation (quote currency)</label>
            <input
              type="number"
              min="0"
              step="100"
              value={totalAllocation}
              onChange={(e) => setTotalAllocation(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-white font-mono focus:border-blue-500 focus:outline-none"
              disabled={submitting}
            />
            <div className="text-xs text-gray-500 mt-1">Initial budget for this fund. You can adjust this later in the fund's config.</div>
          </div>

          <div className="flex items-center gap-2">
            <input
              id="addFundDryRun"
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
              className="w-4 h-4 bg-gray-900 border-gray-700 rounded"
              disabled={submitting}
            />
            <label htmlFor="addFundDryRun" className="text-sm text-gray-300">
              Start in dry-run mode (recommended)
            </label>
          </div>

          {error && (
            <div className="bg-red-900/50 border border-red-700 text-red-200 text-sm rounded p-3">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 text-sm text-gray-300 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 rounded text-sm font-medium text-white"
            >
              {submitting ? 'Creating...' : 'Create Fund'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default AddFundModal
