import { createContext, useContext, useLayoutEffect } from 'react'

export const RouterContext = createContext(null)

export function useRouter(hookName) {
  const router = useContext(RouterContext)
  if (!router) throw new Error(`${hookName} must be used within a <BrowserRouter>`)
  return router
}

export const useLocation = () => useRouter('useLocation').location
export const useNavigate = () => useRouter('useNavigate').navigate

export function useUnsavedChanges(dirty) {
  const register = useContext(RouterContext)?.registerUnsavedChanges
  useLayoutEffect(() => {
    if (!dirty) return
    const unregister = register?.()
    const beforeUnload = (event) => {
      event.preventDefault()
      event.returnValue = true
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      unregister?.()
      window.removeEventListener('beforeunload', beforeUnload)
    }
  }, [dirty, register])
}
