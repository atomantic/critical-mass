import { useState } from 'react'
import Button from '../ui/Button'
import { apiPut, apiDelete, describeMutationFailure } from '../../utils/apiClient'
import { formatUsd } from '../../utils/format.mjs'
import { pnlColorClass, signedPrefix } from '../../utils/pnlFormat.mjs'

// The operator's own contract, typed in from the app, with the Up dip exit rule
// applied to it. Advice only; saving or clearing here places no order.

const FIELD = 'w-full bg-gray-900 border border-gray-700 rounded-sm px-2 py-1 text-xs text-white focus:outline-hidden focus:border-blue-500'
const ACTION_STYLE = {
  EXIT: 'text-amber-300 border-amber-700 bg-amber-900/30',
  CHECK_APP: 'text-red-300 border-red-700 bg-red-900/30',
  HOLD: 'text-blue-300 border-blue-700 bg-blue-900/30',
}
const k = (v) => `${(v / 1000).toFixed(1)}k`

export default function UpDipHeld({ held, onChange }) {
  const [form, setForm] = useState({ floor: '', range: '2000', contracts: '1', cost: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const field = (name) => ({ value: form[name], onChange: (e) => setForm(f => ({ ...f, [name]: e.target.value })), className: FIELD })

  const mutate = async (request, fallback) => {
    setBusy(true)
    setError('')
    try {
      const res = await request()
      if (!res.ok) throw new Error(describeMutationFailure(res, fallback))
      onChange()
    } catch (err) {
      setError(err.message || fallback)
    } finally {
      setBusy(false)
    }
  }
  const save = () => mutate(() => apiPut('/api/updown/up-dip/held', {
    floor: Number(form.floor), ceiling: Number(form.floor) + Number(form.range), contracts: Number(form.contracts), cost: Number(form.cost),
  }), 'Failed to save contract')
  const clear = () => mutate(() => apiDelete('/api/updown/up-dip/held'), 'Failed to clear contract')

  return (
    <div className="bg-gray-900/50 border border-gray-700 rounded-sm px-2 py-1.5 mb-2 text-xs">
      <div className="text-gray-400 text-2xs mb-1">Your contract</div>
      {error && <div role="alert" className="text-red-400 mb-1">{error}</div>}
      {held ? (
        <div data-testid="up-dip-held">
          <div className={`border rounded-sm px-2 py-1 mb-1 ${ACTION_STYLE[held.decision.action] || 'text-gray-300 border-gray-600'}`}>
            <div className="flex justify-between">
              <span className="font-semibold">{held.decision.action.replace('_', ' ')}</span>
              <span className={`font-mono ${pnlColorClass(held.pnl)}`}>{held.pnl == null ? '---' : `${signedPrefix(held.pnl)}${formatUsd(held.pnl)}`}</span>
            </div>
            {held.decision.reasons?.[0] && <div className="text-2xs text-gray-300">{held.decision.reasons[0]}</div>}
          </div>
          <div className="flex justify-between items-center">
            <span className="text-2xs text-gray-400">Up {k(held.contract.floor)}–{k(held.contract.ceiling)} ×{held.contracts} · cost {formatUsd(held.cost)} · exp {held.contract.expiryDate}</span>
            <Button onClick={clear} disabled={busy} variant="soft-danger" size="sm">Clear</Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-1.5">
          <label className="text-2xs text-gray-400">Floor<input type="number" {...field('floor')} /></label>
          <label className="text-2xs text-gray-400">Range<select {...field('range')}><option value="2000">$2,000</option><option value="500">$500</option></select></label>
          <label className="text-2xs text-gray-400">Contracts<input type="number" min="1" step="1" {...field('contracts')} /></label>
          <label className="text-2xs text-gray-400">Total cost (with fees)<input type="number" {...field('cost')} /></label>
          <Button onClick={save} disabled={busy} variant="primary" size="sm" className="col-span-2">Track</Button>
        </div>
      )}
    </div>
  )
}
