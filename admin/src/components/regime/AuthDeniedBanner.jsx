import Button from '../ui/Button'
import React from 'react'

export default function AuthDeniedBanner({ health, handleResumeFromAuthDenied, resumingAuth }) {
  return (
    <>
      {health.mode === 'AUTH_DENIED' && (
        <div className="bg-red-900/40 border border-red-600/60 rounded-lg px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="text-red-400 text-xl">🔑</span>
            <div>
              <div className="text-red-300 font-medium text-sm">
                API key denied — trading paused
              </div>
              <div className="text-gray-400 text-xs mt-0.5">
                The exchange rejected the API key (commonly the server IP is not on the key's allowlist). New orders are halted; existing orders are left untouched. Allowlist the IP, then resume — the engine also auto-resumes once an API call succeeds again.
              </div>
              {health.reason && (
                <div className="text-red-400/80 text-2xs mt-1 font-mono break-all">{health.reason}</div>
              )}
            </div>
          </div>
          <Button
            onClick={handleResumeFromAuthDenied}
            disabled={resumingAuth}
            variant="destructive" size="compact-xs" className="shrink-0 font-medium"
          >
            {resumingAuth ? 'Resuming…' : 'Resume'}
          </Button>
        </div>
      )}
    </>
  )
}
