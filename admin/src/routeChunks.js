import { lazy } from 'react'
import { matchPath, rankRoutes } from './lib/routeMatching'

export const routePaths = {
  fund: '/:exchange/:pair',
  config: '/:exchange/:pair/config',
  transactions: '/:exchange/:pair/transactions',
  charts: '/:exchange/:pair/charts',
  costBasis: '/:exchange/:pair/cost-basis',
  backtest: '/:exchange/:pair/backtest',
  optimizer: '/:exchange/:pair/optimizer',
  overview: '/',
  keys: '/:exchange/:pair/keys',
  notifications: '/notifications',
  backups: '/backups',
  systems: '/systems',
  ai: '/ai',
  logs: '/:exchange/:pair/logs',
  gateway: '/gateway',
  updown: '/updown',
  updownAnalysis: '/updown/analysis',
  sentinel: '/sentinel',
  arbitrage: '/arbitrage',
  gatewayLogs: '/gateway/logs',
}

const loadChunks = new Map()
const lazyRoute = (path, load) => {
  const loaders = loadChunks.get(path) ?? []
  loaders.push(load)
  loadChunks.set(path, loaders)
  return lazy(load)
}

export const Dashboard = lazyRoute(routePaths.fund, () => import('./components/Dashboard'))
export const ConfigEditor = lazyRoute(routePaths.config, () => import('./components/ConfigEditor'))
export const TransactionsDCA = lazyRoute(routePaths.transactions, () => import('./components/TransactionsDCA'))
export const TransactionsRegime = lazyRoute(routePaths.transactions, () => import('./components/TransactionsRegime'))
export const ChartsDCA = lazyRoute(routePaths.charts, () => import('./components/ChartsDCA'))
export const ChartsRegime = lazyRoute(routePaths.charts, () => import('./components/ChartsRegime'))
export const CostBasisDCA = lazyRoute(routePaths.costBasis, () => import('./components/CostBasisDCA'))
export const CostBasisRegime = lazyRoute(routePaths.costBasis, () => import('./components/CostBasisRegime'))
export const Backtest = lazyRoute(routePaths.backtest, () => import('./components/Backtest'))
export const Optimizer = lazyRoute(routePaths.optimizer, () => import('./components/Optimizer'))
export const Overview = lazyRoute(routePaths.overview, () => import('./components/Overview'))
export const KeysConfig = lazyRoute(routePaths.keys, () => import('./components/KeysConfig'))
export const NotificationsConfig = lazyRoute(routePaths.notifications, () => import('./components/NotificationsConfig'))
export const BackupRestore = lazyRoute(routePaths.backups, () => import('./components/BackupRestore'))
export const RegimeDashboard = lazyRoute(routePaths.fund, () => import('./components/RegimeDashboard'))
export const Systems = lazyRoute(routePaths.systems, () => import('./components/Systems'))
export const AIProviders = lazyRoute(routePaths.ai, () => import('./components/ai/Providers'))
export const GatewayAccess = lazyRoute(routePaths.gateway, () => import('./components/GatewayAccess'))
export const UpDownDashboard = lazyRoute(routePaths.updown, () => import('./components/updown/Dashboard'))
export const ScorecardAnalysis = lazyRoute(routePaths.updownAnalysis, () => import('./components/updown/ScorecardAnalysis'))
export const SentinelDashboard = lazyRoute(routePaths.sentinel, () => import('./components/sentinel/Dashboard'))
export const ArbitrageDashboard = lazyRoute(routePaths.arbitrage, () => import('./components/arbitrage/Dashboard'))
const loadLogs = () => import('./components/LogViewer')
export const LogViewer = lazyRoute(routePaths.logs, loadLogs)
loadChunks.set(routePaths.gatewayLogs, [loadLogs])

// Start fetching the static chunk while the session request is in flight.
// Fund strategy is private configuration, so defer routes with two variants.
export function preloadInitialRoute(pathname) {
  const routes = rankRoutes([...loadChunks.keys()].map(path => ({ path })))
  const route = routes.find(({ path }) => matchPath(path, pathname))
  const loaders = loadChunks.get(route?.path)
  if (loaders?.length === 1) {
    // Let the route error boundary report a failure when the route renders.
    void loaders[0]().catch(() => {})
  }
}
