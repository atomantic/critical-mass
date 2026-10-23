import Button from '../ui/Button'
import { describeConfigSaveError } from '../../utils/configSaveError.mjs'
import { apiPut } from '../../utils/apiClient'
import React, { useId, useState } from 'react'
import { computeCapitalAdjustment } from '../../utils/capitalAdjustment.mjs'
import { signedPrefix } from '../../utils/pnlFormat.mjs'

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
      const result = await apiPut(`/api/${exchange}/regime/config${pairQuery}`, updates)
      if (result.status === 0) throw new Error(result.error || 'Network error')
      const data = result.data ?? {}
      if (result.ok && data.success) {
        // Report the values the server actually applied (data.config), not
        // just what we sent — the source of truth after persistence (#701).
        const appliedDeposited = data.config?.depositedCapital ?? updates.depositedCapital
        const appliedMax = data.config?.maxUsdcDeployed ?? updates.maxUsdcDeployed
        addToast?.({
          type: 'success',
          title: 'Capital Adjusted',
          message: `${signedPrefix(delta)}$${delta.toLocaleString()} applied — deposited: $${appliedDeposited.toLocaleString()}, max: $${appliedMax.toLocaleString()}`,
        })
        await Promise.all([fetchConfig?.(), fetchStatus?.()])
      } else {
        const { kind, message } = describeConfigSaveError(result.status, data)
        if (kind === 'notApplied') {
          addToast?.({ type: 'warning', title: 'Capital saved, not yet live', message: 'Restart the engine to apply it.' })
          await Promise.all([fetchConfig?.(), fetchStatus?.()])
        } else {
          addToast?.({ type: 'error', title: 'Adjust Failed', message })
        }
      }
    } catch (err) {
      addToast?.({ type: 'error', title: 'Adjust Failed', message: describeConfigSaveError(null, err).message })
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
          className="w-24 bg-gray-700 border border-cyan-500 rounded-sm px-1 py-0.5 text-cyan-400 text-xs font-mono focus:outline-hidden focus:ring-1 focus:ring-cyan-500"
          value={capitalAdjustValue}
          onChange={(e) => setCapitalAdjustValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleCapitalAdjust()
            if (e.key === 'Escape') setCapitalAdjustMode(false)
          }}
          autoFocus
          disabled={capitalAdjusting}
        />
        <Button
          onClick={handleCapitalAdjust}
          disabled={capitalAdjusting}
          variant="quiet-success" size="inline"
          title="Apply"
        >
          {capitalAdjusting ? '...' : '✓'}
        </Button>
        <Button
          onClick={() => setCapitalAdjustMode(false)}
          variant="quiet" size="inline"
          title="Cancel"
        >
          {'✗'}
        </Button>
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
