import { useEffect, useState } from 'react'

export default function OperatorLogin({ children }) {
  const [status, setStatus] = useState('loading')
  const [token, setToken] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/auth/session')
      .then((response) => response.json())
      .then((session) => setStatus(session.authenticated ? 'authenticated' : 'anonymous'))
      .catch(() => setStatus('anonymous'))
  }, [])

  const login = async (event) => {
    event.preventDefault()
    setError('')
    const response = await fetch('/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    if (!response.ok) {
      setError('The operator token was not accepted.')
      return
    }
    setToken('')
    setStatus('authenticated')
  }

  if (status === 'authenticated') return children
  if (status === 'loading') return <div className="min-h-screen bg-gray-950" />

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center px-4">
      <form onSubmit={login} className="w-full max-w-md rounded-xl border border-gray-700 bg-gray-900 p-8 shadow-2xl">
        <div className="text-3xl mb-3">⚛</div>
        <h1 className="text-2xl font-semibold">Operator authentication</h1>
        <p className="mt-2 text-sm text-gray-400">Enter the token configured as <code>OPERATOR_TOKEN</code> on this gateway.</p>
        <label className="block mt-6 text-sm font-medium text-gray-300" htmlFor="operator-token">Operator token</label>
        <input
          id="operator-token"
          type="password"
          autoComplete="current-password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
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
