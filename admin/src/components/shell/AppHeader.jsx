import { Link, NavLink } from '../../lib/router'

// Top-level section links, rendered in both the desktop bar and the mobile menu.
const SECTION_LINKS = [
  { to: '/', label: 'Funds', end: true },
  { to: '/notifications', label: 'Notifications' },
  { to: '/backups', label: 'Backups' },
  { to: '/updown', label: 'UpDown' },
  { to: '/sentinel', label: 'Sentinel' },
  { to: '/arbitrage', label: 'Arbitrage' },
  { to: '/ai', label: 'AI Providers' },
  { to: '/gateway', label: 'Gateway' },
]

export default function AppHeader({ mobileMenuOpen, onToggleMobileMenu, onMobileSection }) {
  return (
    <header className="bg-gray-800 border-b border-gray-700">
      <div className="max-w-[95%] xl:max-w-[1400px] 2xl:max-w-[1800px] 3xl:max-w-[2000px] mx-auto px-4 2xl:px-6 py-2 md:py-4">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2 xl:gap-3">
          {/* Top row: Title + Exchange selector */}
          <div className="flex items-center justify-between">
            <Link to="/" className="text-lg md:text-2xl font-bold text-white hover:text-gray-200 flex items-center gap-2 whitespace-nowrap min-w-0 shrink">
              <svg viewBox="0 0 32 32" className="w-6 h-6 md:w-8 md:h-8 shrink-0" aria-hidden="true">
                {/* Outer orbit ring */}
                <ellipse cx="16" cy="16" rx="14" ry="5" fill="none" stroke="#6366f1" strokeWidth="0.8" opacity="0.5" transform="rotate(-20 16 16)" />
                {/* Middle orbit ring */}
                <ellipse cx="16" cy="16" rx="10" ry="4" fill="none" stroke="#818cf8" strokeWidth="0.8" opacity="0.6" transform="rotate(25 16 16)" />
                {/* Core glow */}
                <circle cx="16" cy="16" r="5" fill="url(#cmCoreGlow)" />
                {/* Bright core */}
                <circle cx="16" cy="16" r="2.5" fill="#e0e7ff" />
                {/* Orbiting body */}
                <circle cx="27" cy="12" r="1.5" fill="#a5b4fc" />
                <defs>
                  <radialGradient id="cmCoreGlow">
                    <stop offset="0%" stopColor="#c7d2fe" />
                    <stop offset="60%" stopColor="#6366f1" />
                    <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
                  </radialGradient>
                </defs>
              </svg>
              Critical Mass
            </Link>
            <div className="flex items-center gap-1.5 lg:hidden shrink-0">
              {/* Hamburger menu button for mobile */}
              <button
                onClick={() => onToggleMobileMenu()}
                className="min-h-11 min-w-11 p-2 text-gray-400 hover:text-white transition-colors inline-flex items-center justify-center"
                aria-label="Toggle menu"
              >
                {mobileMenuOpen ? (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {/* Bottom row on mobile / Right side on desktop */}
          <nav aria-label="Sections" className="hidden lg:flex items-center justify-end gap-1 xl:gap-4">
            {SECTION_LINKS.map(({ to, label, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) => `min-h-11 inline-flex items-center px-2 xl:px-3 py-1.5 text-xs xl:text-sm hover:text-white transition-colors whitespace-nowrap ${isActive ? 'text-white underline underline-offset-4 decoration-blue-500' : 'text-gray-400'}`}
              >
                {label}
              </NavLink>
            ))}
          </nav>
        </div>

        {/* Mobile menu dropdown */}
        {mobileMenuOpen && (
          <nav aria-label="Sections" className="lg:hidden mt-2 pt-2 border-t border-gray-700 flex flex-col gap-1">
            {SECTION_LINKS.map(({ to, label, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                onNavigate={() => onMobileSection(to)}
                className={({ isActive }) => `min-h-11 px-3 py-2 text-sm hover:text-white hover:bg-gray-700 rounded-sm transition-colors flex items-center ${isActive ? 'text-white bg-gray-700' : 'text-gray-400'}`}
              >
                {label}
              </NavLink>
            ))}
          </nav>
        )}
      </div>
    </header>
  )
}
