import { createContext, useContext } from 'react'

export const RouterContext = createContext(null)

export function useRouter(hookName) {
  const router = useContext(RouterContext)
  if (!router) throw new Error(`${hookName} must be used within a <BrowserRouter>`)
  return router
}

export const useLocation = () => useRouter('useLocation').location
export const useNavigate = () => useRouter('useNavigate').navigate
