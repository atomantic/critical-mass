// Owned replacement for the slice of react-router-dom the admin uses: a
// history-backed provider, flat <Routes>/<Route> matching, <Navigate>, <Link>,
// useNavigate and useLocation. Export names match react-router-dom so call
// sites only change their import path.
import { Children, Fragment, createContext, isValidElement, useCallback, useContext, useEffect, useMemo, useState } from 'react'

const RouterContext = createContext(null)

const readLocation = () => {
  const { pathname, search, hash } = window.location
  return { pathname, search, hash }
}

export function BrowserRouter({ children }) {
  const [location, setLocation] = useState(readLocation)

  useEffect(() => {
    const onPopState = () => setLocation(readLocation())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const navigate = useCallback((to, { replace = false } = {}) => {
    if (typeof to === 'number') {
      window.history.go(to)
      return
    }
    window.history[replace ? 'replaceState' : 'pushState']({}, '', to)
    setLocation(readLocation())
  }, [])

  const value = useMemo(() => ({ location, navigate }), [location, navigate])
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>
}

function useRouter(hookName) {
  const router = useContext(RouterContext)
  if (!router) throw new Error(`${hookName} must be used within a <BrowserRouter>`)
  return router
}

export const useLocation = () => useRouter('useLocation').location
export const useNavigate = () => useRouter('useNavigate').navigate

export function Navigate({ to, replace = false }) {
  const navigate = useNavigate()
  useEffect(() => { navigate(to, { replace }) }, [navigate, to, replace])
  return null
}

const isModifiedClick = (event) => event.metaKey || event.altKey || event.ctrlKey || event.shiftKey

export function Link({ to, replace = false, onClick, target, ...rest }) {
  const navigate = useNavigate()
  const handleClick = (event) => {
    onClick?.(event)
    if (event.defaultPrevented || event.button !== 0 || isModifiedClick(event)) return
    if (target && target !== '_self') return
    event.preventDefault()
    navigate(to, { replace })
  }
  return <a href={to} target={target} onClick={handleClick} {...rest} />
}

// Marker element: <Routes> reads its props and never renders it directly.
export function Route() {
  return null
}

const splitPath = (path) => path.split('/').filter(Boolean)

const safeDecode = (segment) => {
  try { return decodeURIComponent(segment) } catch { return segment }
}

// Mirrors react-router's computeScore so specific routes outrank params
// regardless of declaration order (e.g. /updown/analysis beats /:exchange/:pair):
// one point per segment, +10 static, +3 param, -2 for a splat. Ties keep
// declaration order.
export function scorePath(path) {
  const segments = `/${path}`.replace(/\/+/g, '/').split('/')
  const hasSplat = segments.includes('*')
  return segments
    .filter(segment => segment !== '*')
    .reduce((score, segment) => score + (segment.startsWith(':') ? 3 : segment === '' ? 1 : 10), segments.length - (hasSplat ? 2 : 0))
}

// Static segments compare case-insensitively (react-router's default), params
// capture one decoded segment, a trailing `*` swallows the rest, and trailing
// slashes on the pathname are ignored.
export function matchPath(path, pathname) {
  const patternSegments = splitPath(path)
  const pathSegments = splitPath(pathname).map(safeDecode)
  const params = {}
  for (let i = 0; i < patternSegments.length; i++) {
    const pattern = patternSegments[i]
    if (pattern === '*') {
      params['*'] = pathSegments.slice(i).join('/')
      return params
    }
    const segment = pathSegments[i]
    if (segment === undefined) return null
    if (pattern.startsWith(':')) params[pattern.slice(1)] = segment
    else if (pattern.toLowerCase() !== segment.toLowerCase()) return null
  }
  return pathSegments.length === patternSegments.length ? params : null
}

// Flattens <Route> children, descending into fragments and skipping the falsy
// values left by conditional route groups.
function collectRoutes(children) {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement(child)) return []
    if (child.type === Fragment) return collectRoutes(child.props.children)
    return child.type === Route ? [child.props] : []
  })
}

export function rankRoutes(routes) {
  return routes
    .map((route, index) => ({ route, index, score: scorePath(route.path ?? '') }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ route }) => route)
}

export function Routes({ children }) {
  const { pathname } = useLocation()
  const match = rankRoutes(collectRoutes(children)).find(route => matchPath(route.path ?? '', pathname))
  return match ? match.element ?? null : null
}
