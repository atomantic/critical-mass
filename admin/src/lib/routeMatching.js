// Drops the leading slash and any trailing slashes but keeps interior empty
// segments, so `/gateway//logs` does not collapse into `/gateway/logs`.
const splitPath = (path) => {
  const trimmed = path.replace(/^\//, '').replace(/\/+$/, '')
  return trimmed ? trimmed.split('/') : []
}

const safeDecode = (segment) => {
  try { return decodeURIComponent(segment) } catch { return segment }
}

// Mirrors react-router's computeScore so specific routes outrank params
// regardless of declaration order (e.g. /updown/analysis beats /:exchange/:pair):
// one point per segment, +10 static, +3 param, -2 for a splat. Ties keep
// declaration order.
function scorePath(path) {
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
    if (!segment) return null
    if (pattern.startsWith(':')) params[pattern.slice(1)] = segment
    else if (pattern.toLowerCase() !== segment.toLowerCase()) return null
  }
  return pathSegments.length === patternSegments.length ? params : null
}

export function rankRoutes(routes) {
  return routes
    .map((route, index) => ({ route, index, score: scorePath(route.path ?? '') }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ route }) => route)
}
