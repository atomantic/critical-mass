// Owned replacement for the slice of react-router-dom the admin uses: a
// history-backed provider, flat <Routes>/<Route> matching, <Navigate>, <Link>,
// useNavigate and useLocation. Export names match react-router-dom so call
// sites only change their import path.
import { Children, Fragment, isValidElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RouterContext, useRouter, useNavigate, useLocation } from './routerContext'
import { matchPath, rankRoutes } from './routeMatching'
import ConfirmDialog from '../components/ui/ConfirmDialog'

const readLocation = () => {
  const { pathname, search, hash } = window.location
  return { pathname, search, hash }
}

export function BrowserRouter({ children }) {
  const [location, setLocation] = useState(readLocation)

  const blockers = useRef(new Set())
  const historyIndex = useRef(null)
  const restoreHistory = useRef(null)
  const acceptedHistoryIndex = useRef(null)
  const [pendingNavigation, setPendingNavigation] = useState(null)
  const registerUnsavedChanges = useCallback(() => {
    const token = {}
    blockers.current.add(token)
    return () => blockers.current.delete(token)
  }, [])

  useEffect(() => {
    const history = window.history
    historyIndex.current = history.state?.criticalMassIndex ?? 0
    history.replaceState({ ...history.state, criticalMassIndex: historyIndex.current }, '')
    // An indexed entry lets a cancelled Back/Forward restore the prior entry
    // without pushing a duplicate or losing the Forward stack.
    const onPopState = (event) => {
      if (restoreHistory.current) {
        const { index, delta } = restoreHistory.current
        restoreHistory.current = null
        setPendingNavigation(() => () => {
          acceptedHistoryIndex.current = index
          history.go(delta)
        })
        return
      }
      const index = event.state?.criticalMassIndex
      const accepted = index === acceptedHistoryIndex.current
      acceptedHistoryIndex.current = null
      if (!accepted && index != null && index !== historyIndex.current && blockers.current.size > 0) {
        const delta = index - historyIndex.current
        restoreHistory.current = { index, delta }
        history.go(-delta)
        return
      }
      historyIndex.current = index ?? 0
      setLocation(readLocation())
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const navigate = useCallback((to, { replace = false, onNavigate } = {}) => {
    if (typeof to === 'number') {
      window.history.go(to)
      return
    }
    const { pathname, search, hash } = readLocation()
    const destination = new URL(to, window.location.href)
    const changesUrl = destination.pathname + destination.search + destination.hash !== pathname + search + hash
    const commit = () => {
      const index = (historyIndex.current ?? 0) + (replace ? 0 : 1)
      window.history[replace ? 'replaceState' : 'pushState']({ criticalMassIndex: index }, '', to)
      historyIndex.current = index
      setLocation(readLocation())
      onNavigate?.()
    }
    if (changesUrl && blockers.current.size > 0) setPendingNavigation(() => commit)
    else commit()
  }, [])

  const value = useMemo(() => ({ location, navigate, registerUnsavedChanges }), [location, navigate, registerUnsavedChanges])
  return (
    <RouterContext.Provider value={value}>
      {children}
      {pendingNavigation && (
        <ConfirmDialog
          title="Discard Unsaved Changes?"
          description="Your unsaved configuration and preset changes will be lost if you leave."
          cancelLabel="Keep Editing"
          confirmLabel="Discard Changes"
          onClose={() => setPendingNavigation(null)}
          onConfirm={() => {
            setPendingNavigation(null)
            pendingNavigation()
          }}
        />
      )}
    </RouterContext.Provider>
  )
}

export function Navigate({ to, replace = false }) {
  const navigate = useNavigate()
  useEffect(() => { navigate(to, { replace }) }, [navigate, to, replace])
  return null
}

const isModifiedClick = (event) => event.metaKey || event.altKey || event.ctrlKey || event.shiftKey

// Like react-router, a link to the URL already showing replaces the entry
// instead of stacking a duplicate, unless `replace` is passed explicitly.
export function Link({ to, replace, onClick, onNavigate, target, ...rest }) {
  const { location, navigate } = useRouter('Link')
  const handleClick = (event) => {
    onClick?.(event)
    if (event.defaultPrevented || event.button !== 0 || isModifiedClick(event)) return
    if (target && target !== '_self') return
    event.preventDefault()
    const sameUrl = to === location.pathname + location.search + location.hash
    navigate(to, { replace: replace ?? sameUrl, onNavigate })
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
