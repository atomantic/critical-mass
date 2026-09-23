import React, { useId, useState } from 'react'
import { computeCapitalAdjustment } from '../../utils/capitalAdjustment.mjs'

/**
 * RegimeDashboard "Available capital" inline form, inside the Position/APY
 * card. Owns its own edit-mode/draft/in-flight state; the clamp logic itself
 * lives in utils/capitalAdjustment.mjs (#701) — this component only wires
 * that pure function to the config PUT endpoint and the toast/refetch flow.
 */
function CapitalAdjust({ apy, exchange, pairQuery, fetchConfig, fetchStatus, addToast }) {
  const capitalAdjustInputId = useId()
  const [capitalAdjustMode, setCapitalAdjustMode] = useState(false)
  const [capitalAdjustValue, setCapitalAdjustValue] = useState('')
  const [capitalAdjusting, setCapitalAdjusting] = useState(false)

  const handleCapitalAdjust = async () => {
    const newAvailable = parseFloat(capitalAdjustValue)
    const adjustment = computeCapitalAdjustment(apy, newAvailable)
    if (!adjustment.ok) {
      addToast?.({ type: 'error', title: 'Invalid Amount', message: adjustment.error })
      return
    }
    if (adjustment.noop) {
      setCapitalAdjustMode(false)
      return
    }
    const { delta, updates } = adjustment
    setCapitalAdjusting(true)
    try {
      const res = await fetch(`/api/${exchange}/regime/config${pairQuery}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      const data = await res.json()
      if (data.success) {
        // Report the values the server actually applied (data.config), not
        // just what we sent — the source of truth after persistence (#701).
        const appliedDeposited = data.config?.depositedCapital ?? updates.depositedCapital
        const appliedMax = data.config?.maxUsdcDeployed ?? updates.maxUsdcDeployed
        addToast?.({
          type: 'success',
          title: 'Capital Adjusted',
          message: `${delta >= 0 ? '+' : ''}$${delta.toLocaleString()} applied — deposited: $${appliedDeposited.toLocaleString()}, max: $${appliedMax.toLocaleString()}`,
        })
        await Promise.all([fetchConfig?.(), fetchStatus?.()])
      } else {
        addToast?.({ type: 'error', title: 'Adjust Failed', message: data.errors?.join(', ') || 'Unknown error' })
      }
    } catch (err) {
      addToast?.({ type: 'error', title: 'Adjust Failed', message: err.message })
    }
    setCapitalAdjusting(false)
    setCapitalAdjustMode(false)
  }

  if (capitalAdjustMode) {
    return (
      <span className="inline-flex items-center gap-1">
        <label htmlFor={capitalAdjustInputId} className="text-cyan-400">Available: $</label>
        <input
          id={capitalAdjustInputId}
          type="number"
          className="w-24 bg-gray-700 border border-cyan-500 rounded px-1 py-0.5 text-cyan-400 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-cyan-500"
          value={capitalAdjustValue}
          onChange={(e) => setCapitalAdjustValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleCapitalAdjust()
            if (e.key === 'Escape') setCapitalAdjustMode(false)
          }}
          autoFocus
          disabled={capitalAdjusting}
        />
        <button
          onClick={handleCapitalAdjust}
          disabled={capitalAdjusting}
          className="text-green-400 hover:text-green-300 disabled:opacity-50"
          title="Apply"
        >
          {capitalAdjusting ? '...' : '✓'}
        </button>
        <button
          onClick={() => setCapitalAdjustMode(false)}
          className="text-gray-400 hover:text-gray-300"
          title="Cancel"
        >
          {'✗'}
        </button>
      </span>
    )
  }

  return (
    <span
      className="text-cyan-400 cursor-pointer hover:underline"
      onClick={() => {
        setCapitalAdjustValue(String(Math.round(apy.availableCapital || 0)))
        setCapitalAdjustMode(true)
      }}
      title="Click to adjust available capital (updates deposited & max)"
    >
      Available: ${apy.availableCapital?.toLocaleString()}
    </span>
  )
}

export default CapitalAdjust
