import { useState, useEffect, useCallback } from 'react'
import { createRequestOwner } from '../utils/requestOwner.mjs'
import { apiGet } from '../utils/apiClient'
import useRealtimeRefresh from './useRealtimeRefresh'

export default function useUpDip(enabled) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [owner] = useState(() => createRequestOwner({ readImpl: apiGet }))

  const load = useCallback(async () => {
    const result = await owner.read('/api/updown/up-dip')
    if (!result.owned) return
    if (result.ok && result.data?.success) {
      setData(result.data)
      setError(null)
    } else {
      setError(result.data?.error || 'Up dip recommendations unavailable.')
    }
  }, [owner])

  useEffect(() => {
    if (!enabled) return
    load()
    return () => owner.invalidate()
  }, [enabled, load, owner])

  useRealtimeRefresh({
    events: ['updown:up-dip'],
    rooms: ['updown'],
    enabled,
    minIntervalMs: 5000,
    onRefresh: load,
  })

  return { data, error, load }
}
