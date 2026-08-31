import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { KeyRound, ScrollText } from 'lucide-react'

export default function GatewayAccess() {
  const [required, setRequired] = useState(false)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [message, setMessage] = useState(null)

  const refresh = async () => {
    const res = await fetch('/api/auth/session').catch(() => null)
    if (res?.ok) {
      const data = await res.json()
      setRequired(Boolean(data.required))
    }
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
    const res = await fetch('/api/auth/password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, currentPassword: currentPassword || undefined }),
    })
    const data = await res.json().catch(() => ({}))
    if (res.ok) {
      setRequired(true)
      setPassword('')
      setConfirm('')
      setCurrentPassword('')
      setMessage({ type: 'success', text: 'Password saved. Sign-in is now required.' })
    } else {
      setMessage({ type: 'error', text: data.error || 'Could not save password' })
    }
    setSaving(false)
  }

  const handleClear = async () => {
    setMessage(null)
    setClearing(true)
    const res = await fetch('/api/auth/password', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: currentPassword }),
    })
    const data = await res.json().catch(() => ({}))
    if (res.ok) {
      window.location.reload()
    } else {
      setMessage({ type: 'error', text: data.error || 'Could not remove password' })
    }
    setClearing(false)
  }

  const handleSignOut = async () => {
    await fetch('/api/auth/session', { method: 'DELETE' })
    window.location.reload()
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
          <span className={`text-xs font-mono ${required ? 'text-yellow-400' : 'text-green-400'}`}>
            {required ? 'sign-in required' : 'open'}
          </span>
        </div>

        {message && (
          <div className={`mb-3 text-sm rounded px-3 py-2 ${
            message.type === 'success' ? 'bg-green-900/30 text-green-300' : 'bg-red-900/30 text-red-300'
          }`}>
            {message.text}
          </div>
        )}

        <form onSubmit={handleSet} className="space-y-3">
          {required && (
            <div>
              <label className="text-xs text-gray-400 block mb-1">Current password</label>
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
              />
            </div>
          )}
          <div>
            <label className="text-xs text-gray-400 block mb-1">{required ? 'New password' : 'Password'} (min 8 characters)</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
              required
              minLength={8}
            />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Confirm</label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
              required
              minLength={8}
            />
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={saving}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 rounded text-sm font-medium"
            >
              {saving ? 'Saving...' : required ? 'Change password' : 'Require sign-in'}
            </button>
            {required && (
              <button
                type="button"
                onClick={handleClear}
                disabled={clearing || !currentPassword}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 rounded text-sm"
              >
                {clearing ? '...' : 'Remove password'}
              </button>
            )}
            {required && (
              <button
                type="button"
                onClick={handleSignOut}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm ml-auto"
              >
                Sign out
              </button>
            )}
          </div>
        </form>
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
