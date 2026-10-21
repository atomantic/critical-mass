import { useEffect, useState } from 'react'
import { Link } from '../lib/router'
import { KeyRound, ScrollText } from './icons'
import { apiDelete, apiGet, apiPut, apiRequest } from '../utils/apiClient'

export default function GatewayAccess() {
  const [required, setRequired] = useState(null)
  const [statusError, setStatusError] = useState(false)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [message, setMessage] = useState(null)

  const refresh = async () => {
    setRequired(null)
    setStatusError(false)
    const result = await apiGet('/api/auth/session')
    if (result.ok) setRequired(true)
    else setStatusError(true)
  }

  useEffect(() => { refresh() }, [])

  const handleSet = async (event) => {
    event.preventDefault()
    setMessage(null)
    if (password !== confirm) {
      setMessage({ type: 'error', text: 'Password and confirmation do not match' })
      return
    }
    setSaving(true)
    try {
      const result = await apiPut('/api/auth/password', { password, currentPassword }, { allowEmpty: true })
      if (result.ok) {
        setRequired(true)
        setPassword('')
        setConfirm('')
        setCurrentPassword('')
        setMessage({ type: 'success', text: 'Password changed.' })
      } else {
        setMessage({ type: 'error', text: result.error || 'Could not save password' })
      }
    } finally {
      setSaving(false)
    }
  }

  const handleClear = async () => {
    setMessage(null)
    setClearing(true)
    try {
      // apiDelete carries no body, so send the confirmation through the shared request helper.
      const result = await apiRequest('DELETE', '/api/auth/password', { body: { password: currentPassword }, allowEmpty: true })
      if (result.ok) {
        setMessage({ type: 'success', text: 'Password removed. The gateway will ask you to create a new one when the page reloads.' })
        setTimeout(() => window.location.reload(), 1500)
      } else {
        setMessage({ type: 'error', text: result.error || 'Could not remove password' })
      }
    } finally {
      setClearing(false)
    }
  }

  const handleSignOut = async () => {
    // The server answers 204, so an empty reply is the success case.
    const result = await apiDelete('/api/auth/session', { allowEmpty: true })
    if (result.ok) window.location.reload()
    else setMessage({ type: 'error', text: `Sign out failed: ${result.error}` })
  }

  return (
    <div className="space-y-4">
      <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
        <div className="flex items-center gap-2 mb-1">
          <KeyRound size={16} className="text-blue-400" />
          <h2 className="text-lg font-bold">Gateway access</h2>
        </div>
        <p className="text-sm text-gray-400">
          Gateway APIs always require operator authentication. The password is stored as a hash in <code className="text-gray-300">data/operator-auth.json</code>, not as an environment variable.
          {' '}Authenticated browsers stay signed in for 30 days after each visit.
        </p>
      </div>

      <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">Operator password</h3>
          {required === null
            ? <span className="text-xs font-mono text-gray-400" role="status">Checking…</span>
            : <span className="text-xs font-mono text-green-400">Password set</span>}
        </div>

        {required === null ? (
          statusError ? (
            <div className="space-y-2" role="alert">
              <p className="text-sm text-red-300">Could not read gateway status — reload to retry.</p>
              <button type="button" onClick={refresh} className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-sm text-sm">Retry</button>
            </div>
          ) : null
        ) : (
        <>

        {message && (
          <div className={`mb-3 text-sm rounded px-3 py-2 ${
            message.type === 'success' ? 'bg-green-900/30 text-green-300' : 'bg-red-900/30 text-red-300'
          }`}>
            {message.text}
          </div>
        )}

        <form onSubmit={handleSet} className="space-y-3">
          <div>
            <label htmlFor="current-password" className="text-xs text-gray-400 block mb-1">Current password</label>
            <input
              id="current-password"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              required
              className="w-full bg-gray-900 border border-gray-700 rounded-sm px-3 py-1.5 text-sm text-white focus:outline-hidden focus:border-blue-500"
            />
          </div>
          <div>
            <label htmlFor="new-password" className="text-xs text-gray-400 block mb-1">New password (min 8 characters)</label>
            <input
              id="new-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              className="w-full bg-gray-900 border border-gray-700 rounded-sm px-3 py-1.5 text-sm text-white focus:outline-hidden focus:border-blue-500"
              required
              minLength={8}
            />
          </div>
          <div>
            <label htmlFor="confirm-password" className="text-xs text-gray-400 block mb-1">Confirm</label>
            <input
              id="confirm-password"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              className="w-full bg-gray-900 border border-gray-700 rounded-sm px-3 py-1.5 text-sm text-white focus:outline-hidden focus:border-blue-500"
              required
              minLength={8}
            />
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={saving}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 rounded-sm text-sm font-medium"
            >
              {saving ? 'Saving...' : 'Change password'}
            </button>
            <button
              type="button"
              onClick={handleClear}
              disabled={clearing || !currentPassword}
              className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 rounded-sm text-sm"
            >
              {clearing ? '...' : 'Remove password'}
            </button>
            <button
              type="button"
              onClick={handleSignOut}
              className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-sm text-sm ml-auto"
            >
              Sign out
            </button>
          </div>
        </form>
        </>
        )}
      </div>

      <Link
        to="/gateway/logs"
        className="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 rounded-lg p-4 border border-gray-700 text-sm text-gray-300"
      >
        <ScrollText size={16} className="text-gray-400" />
        Gateway logs
      </Link>
    </div>
  )
}
