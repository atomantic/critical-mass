// Owned replacement for the slice of react-router-dom the admin uses: a
// history-backed provider, flat <Routes>/<Route> matching, <Navigate>, <Link>,
// useNavigate and useLocation. Export names match react-router-dom so call
// sites only change their import path.
import { Children, Fragment, isValidElement, useCallback, useEffect, useMemo, useState } from 'react'
import { RouterContext, useRouter, useNavigate, useLocation } from './routerContext'
import { matchPath, rankRoutes } from './routeMatching'

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

export function Navigate({ to, replace = false }) {
  const navigate = useNavigate()
  useEffect(() => { navigate(to, { replace }) }, [navigate, to, replace])
  return null
}

const isModifiedClick = (event) => event.metaKey || event.altKey || event.ctrlKey || event.shiftKey

// Like react-router, a link to the URL already showing replaces the entry
// instead of stacking a duplicate, unless `replace` is passed explicitly.
export function Link({ to, replace, onClick, target, ...rest }) {
  const { location, navigate } = useRouter('Link')
  const handleClick = (event) => {
    onClick?.(event)
    if (event.defaultPrevented || event.button !== 0 || isModifiedClick(event)) return
    if (target && target !== '_self') return
    event.preventDefault()
    const sameUrl = to === location.pathname + location.search + location.hash
    navigate(to, { replace: replace ?? sameUrl })
  }
  return <a href={to} target={target} onClick={handleClick} {...rest} />
}

// Like react-router's NavLink: marks the link whose route is showing with
// aria-current="page" and an `active` class suffix. A link matches its own path
// and anything below it, or only the exact path when `end` is passed.
export function NavLink({ to, end = false, className, activeClassName = '', ...rest }) {
  const { location } = useRouter('NavLink')
  const current = location.pathname.replace(/\/+$/, '') || '/'
  const target = to.replace(/\/+$/, '') || '/'
  const isActive = current === target || (!end && target !== '/' && current.startsWith(`${target}/`))
  const resolvedClass = typeof className === 'function' ? className({ isActive }) : className
  const classes = [resolvedClass, isActive ? activeClassName : ''].filter(Boolean).join(' ')
  return <Link to={to} aria-current={isActive ? 'page' : undefined} className={classes || undefined} {...rest} />
}

// Marker element: <Routes> reads its props and never renders it directly.
export function Route() {
  return null
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

export function Routes({ children }) {
  const { pathname } = useLocation()
  const match = rankRoutes(collectRoutes(children)).find(route => matchPath(route.path ?? '', pathname))
  return match ? match.element ?? null : null
}
