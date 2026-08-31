import { useEffect, useState } from 'react'

export default function OperatorLogin({ children }) {
  const [status, setStatus] = useState('loading')
  const [required, setRequired] = useState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  // Keep authentication as an application boundary after the initial session
  // check. If a session expires or a password change revokes it, the mounted
  // SPA must return to sign-in instead of merely showing API errors while
  // continuing to render privileged controls.
  useEffect(() => {
    const originalFetch = window.fetch
    const authenticatedFetch = async (...args) => {
      const response = await originalFetch.apply(window, args)
      if (response.status === 401) setStatus('anonymous')
      return response
    }
    window.fetch = authenticatedFetch
    return () => {
      if (window.fetch === authenticatedFetch) window.fetch = originalFetch
    }
  }, [])

  useEffect(() => {
    fetch('/api/auth/session')
      .then((response) => response.json())
      .then((session) => {
        setRequired(Boolean(session.required))
        setStatus(session.required && !session.authenticated ? 'anonymous' : 'authenticated')
      })
      .catch(() => setStatus('anonymous'))
  }, [])

  const login = async (event) => {
    event.preventDefault()
    setError('')
    const response = await fetch('/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (!response.ok) {
      setError('That password was not accepted.')
      return
    }
    setPassword('')
    setRequired(true)
    setStatus('authenticated')
  }

  if (status === 'authenticated') return children
  if (status === 'loading') {
    return (
      <main className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center px-4">
        <div
          className="w-full max-w-sm rounded-xl border border-gray-700 bg-gray-900 p-8 text-center shadow-2xl"
          role="status"
          aria-live="polite"
        >
          <div className="text-3xl mb-3" aria-hidden="true">⚛</div>
          <h1 className="text-xl font-semibold">Critical Mass</h1>
          <div
            className="mx-auto mt-6 h-7 w-7 animate-spin rounded-full border-2 border-gray-700 border-t-blue-500"
            aria-hidden="true"
          />
          <p className="mt-4 text-sm text-gray-400">Checking operator session…</p>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center px-4">
      <form onSubmit={login} className="w-full max-w-md rounded-xl border border-gray-700 bg-gray-900 p-8 shadow-2xl">
        <div className="text-3xl mb-3">⚛</div>
        <h1 className="text-2xl font-semibold">Operator sign-in</h1>
        <p className="mt-2 text-sm text-gray-400">
          {required
            ? 'Enter the operator password set in Gateway → Access.'
            : 'Could not reach the gateway. Check that critical-mass is running, then retry.'}
        </p>
        {required && (
          <p className="mt-2 text-xs text-gray-500">
            This browser stays signed in for 30 days after each visit.
          </p>
        )}
        <label className="block mt-6 text-sm font-medium text-gray-300" htmlFor="operator-password">Password</label>
        <input
          id="operator-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="mt-2 w-full rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-gray-100 focus:border-blue-500 focus:outline-none"
          required
          autoFocus
        />
        {error && <p className="mt-3 text-sm text-red-400" role="alert">{error}</p>}
        <button type="submit" className="mt-6 w-full rounded-lg bg-blue-600 px-4 py-2 font-medium hover:bg-blue-500">Sign in</button>
      </form>
    </main>
  )
}
