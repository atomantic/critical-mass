import Button from './ui/Button'
import { useState } from 'react'
import ModalDialog from './ModalDialog'
import { apiPost } from '../utils/apiClient'

/**
 * AddFundModal — create a new (exchange, pair) fund.
 *
 * The modal lets the operator pick an exchange that has API keys configured,
 * type a pair, set an initial allocation, and choose dry-run mode. The new
 * fund is created via POST /api/:exchange/funds and remains stopped until the
 * operator presses Start from the fund header.
 */

// Per-exchange pair format conventions and defaults
const EXCHANGE_FORMATS = {
  coinbase: {
    placeholder: 'BTC-USDC',
    defaultPair: 'BTC-USDC',
    hint: 'Coinbase format: BASE-QUOTE (e.g. BTC-USDC, ETH-USDC, SOL-USDC)',
    separator: '-',
  },
  gemini: {
    placeholder: 'BTCUSD',
    defaultPair: 'BTCUSD',
    hint: 'Gemini format: BASEQUOTE all uppercase (e.g. BTCUSD, ETHUSD, SOLUSD)',
    separator: '',
  },
  cryptocom: {
    placeholder: 'BTC_USD',
    defaultPair: 'BTC_USD',
    hint: 'Crypto.com format: BASE_QUOTE (e.g. BTC_USD, ETH_USD, CRO_USD)',
    separator: '_',
  },
}

const fallbackFormat = {
  placeholder: 'BTC-USDC',
  defaultPair: 'BTC-USDC',
  hint: 'Enter the trading pair as it appears on the exchange.',
  separator: '-',
}

/**
 * Normalize a pair string to the selected exchange's format.
 * - Uppercase, alphanumeric only
 * - Coinbase: any separator → '-' (BTCUSDC stays as-is, BTC_USD → BTC-USD)
 * - Gemini: separators stripped (BTC-USD → BTCUSD, BTC_USD → BTCUSD)
 * - Crypto.com: any separator → '_' (BTC-USD → BTC_USD)
 */
const formatPairForExchange = (input, exchange) => {
  if (!input) return ''
  // Strip anything that isn't alphanumeric, dash, or underscore
  let cleaned = input.toUpperCase().replace(/[^A-Z0-9_-]/g, '')
  const fmt = EXCHANGE_FORMATS[exchange] || fallbackFormat
  if (fmt.separator === '') {
    return cleaned.replace(/[-_]/g, '')
  }
  if (fmt.separator === '-') {
    return cleaned.replace(/_/g, '-')
  }
  if (fmt.separator === '_') {
    return cleaned.replace(/-/g, '_')
  }
  return cleaned
}

// Mounted only while open (ModalDialog's mount-once contract), so every open
// starts from fresh initial state — no reset-on-open effect needed.
function AddFundDialog({ onClose, onCreated, exchanges = [] }) {
  // The exchanges prop contains one entry per (exchange, pair) fund — collapse
  // to unique exchange names so the dropdown lists each exchange once.
  const exchangeNames = Array.from(new Set((exchanges || []).map(e => e.name)))
  const initialExchange = exchangeNames[0] || 'gemini'
  const [exchange, setExchange] = useState(initialExchange)
  const [pair, setPair] = useState(EXCHANGE_FORMATS[initialExchange]?.defaultPair || '')
  const [totalAllocation, setTotalAllocation] = useState('5000')
  const [dryRun, setDryRun] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const fmt = EXCHANGE_FORMATS[exchange] || fallbackFormat

  // When the exchange dropdown changes, re-format the existing pair value
  // to the new exchange's separator convention. This lets the operator type
  // BTC-USDC, switch to gemini, and have it automatically become BTCUSD.
  const handleExchangeChange = (newExchange) => {
    setExchange(newExchange)
    setPair((prev) => {
      // If the previous value matches the previous exchange's default, swap
      // to the new exchange's default (so switching exchanges shows the new
      // format right away). Otherwise just re-format whatever the user typed.
      const prevDefault = EXCHANGE_FORMATS[exchange]?.defaultPair
      if (prev === prevDefault) {
        return EXCHANGE_FORMATS[newExchange]?.defaultPair || ''
      }
      return formatPairForExchange(prev, newExchange)
    })
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
    if (!/^[A-Z0-9]{2,8}([-_][A-Z0-9]{2,8})?$/.test(trimmedPair)) {
      setError(`Invalid pair format: ${trimmedPair}. Expected ${fmt.placeholder} for ${exchange}.`)
      return
    }
    const allocation = parseFloat(totalAllocation)
    if (isNaN(allocation) || allocation <= 0) {
      setError('Total allocation must be a positive number')
      return
    }

    setSubmitting(true)
    try {
      const res = await apiPost(`/api/${exchange}/funds`, {
        pair: trimmedPair,
        productId: trimmedPair,
        totalAllocation: allocation,
        dryRun,
      })
      if (!res.ok) {
        setError(res.error)
        setSubmitting(false)
        return
      }
      // The fund exists now. Whatever the follow-up refresh does, close the
      // modal so the operator is not invited to create it a second time.
      try {
        await onCreated?.({ exchange, pair: trimmedPair })
      } catch (err) {
        console.error('Add fund follow-up failed:', err)
      } finally {
        onClose?.()
      }
    } catch (err) {
      setError(err.message || 'Network error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ModalDialog onClose={onClose} labelledBy="add-fund-title" describedBy="add-fund-description" dismissible={!submitting}>
      <h2 id="add-fund-title" className="text-lg font-bold text-white mb-4">Add Fund</h2>
      <p id="add-fund-description" className="text-sm text-gray-400 mb-4">
        Create a new trading fund on an existing exchange. The fund is created stopped, and in <span className="text-purple-400">dry-run mode</span> unless you untick the box below. Nothing trades until you press Start in the fund header, so review its config first.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="add-fund-exchange" className="block text-xs uppercase tracking-wider text-gray-400 mb-1">Exchange</label>
          <select
            id="add-fund-exchange"
            value={exchange}
            onChange={(e) => handleExchangeChange(e.target.value)}
            className="w-full min-h-11 bg-gray-900 border border-gray-700 rounded-sm px-3 py-2 text-white focus:border-blue-500 focus:outline-hidden"
            disabled={submitting}
          >
            {exchangeNames.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="add-fund-pair" className="block text-xs uppercase tracking-wider text-gray-400 mb-1">Pair</label>
          <input
            id="add-fund-pair"
            autoFocus
            onFocus={(e) => e.target.select()}
            type="text"
            value={pair}
            onChange={(e) => setPair(formatPairForExchange(e.target.value, exchange))}
            placeholder={fmt.placeholder}
            className="w-full min-h-11 bg-gray-900 border border-gray-700 rounded-sm px-3 py-2 text-white font-mono focus:border-blue-500 focus:outline-hidden"
            disabled={submitting}
            autoComplete="off"
          />
          <div className="text-xs text-gray-400 mt-1">{fmt.hint}</div>
        </div>

        <div>
          <label htmlFor="add-fund-allocation" className="block text-xs uppercase tracking-wider text-gray-400 mb-1">Initial Capital (quote currency)</label>
          <input
            id="add-fund-allocation"
            type="number"
            min="0"
            step="100"
            value={totalAllocation}
            onChange={(e) => setTotalAllocation(e.target.value)}
            className="w-full min-h-11 bg-gray-900 border border-gray-700 rounded-sm px-3 py-2 text-white font-mono focus:border-blue-500 focus:outline-hidden"
            disabled={submitting}
          />
          <div className="text-xs text-gray-400 mt-1">Seeds <span className="font-mono">deposited capital</span> and <span className="font-mono">max deployed</span> for this fund. You can adjust both later in the fund's config.</div>
        </div>

        <div className="flex items-center gap-2">
          <input
            id="addFundDryRun"
            type="checkbox"
            checked={dryRun}
            onChange={(e) => setDryRun(e.target.checked)}
            className="w-4 h-4 bg-gray-900 border-gray-700 rounded-sm"
            disabled={submitting}
          />
          <label htmlFor="addFundDryRun" className="text-sm text-gray-300">
            Start in dry-run mode (recommended)
          </label>
        </div>

        {error && (
          <div className="bg-red-900/50 border border-red-700 text-red-200 text-sm rounded-sm p-3">
            {error}
          </div>
        )}

        <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2 pt-2">
          <Button
            type="button"
            onClick={onClose}
            disabled={submitting}
            variant="quiet" size="md" touchTarget="always"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={submitting}
            variant="primary" size="md" touchTarget="always" className="font-medium"
          >
            {submitting ? 'Creating...' : 'Create Fund'}
          </Button>
        </div>
      </form>
    </ModalDialog>
  )
}

function AddFundModal({ open, ...props }) {
  if (!open) return null
  return <AddFundDialog {...props} />
}

export default AddFundModal
