// @ts-check
/**
 * Where the operator gateway should listen.
 *
 * Default is loopback plus any Tailscale 100.64/10 addresses so the admin UI
 * is reachable at http://100.x:5570 and http://<machine>.ts.net:5570 without
 * publishing on LAN/WAN. HOST=0.0.0.0 still binds every interface.
 */

const os = require('os')

/** @param {string} addr */
const isTailscaleIpv4 = (addr) => {
  if (typeof addr !== 'string') return false
  const p = addr.split('.')
  if (p.length !== 4) return false
  const o = p.map((n) => Number(n))
  if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  return o[0] === 100 && o[1] >= 64 && o[1] <= 127
}

/** @param {NodeJS.Dict<os.NetworkInterfaceInfo[]>} [nets] */
const tailscaleIpv4s = (nets = os.networkInterfaces()) => {
  const out = []
  for (const addrs of Object.values(nets || {})) {
    for (const a of addrs || []) {
      const family = a.family === 4 || a.family === 'IPv4'
      if (!family || a.internal) continue
      if (isTailscaleIpv4(a.address)) out.push(a.address)
    }
  }
  return out
}

/** @param {string} host */
const isLoopbackHost = (host) => {
  const normalized = String(host).toLowerCase().split('%')[0]
  if (normalized === 'localhost' || normalized === '::1') return true
  const ipv4 = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized
  const octets = ipv4.split('.').map(Number)
  return octets.length === 4
    && octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    && octets[0] === 127
}

/**
 * @param {string|undefined} envHost
 * @param {string[]} [tailscale]
 * @param {{allowRemote?: boolean}} [options]
 * @returns {string[]}
 */
const resolveListenHosts = (envHost, tailscale = tailscaleIpv4s(), { allowRemote = true } = {}) => {
  const raw = typeof envHost === 'string' ? envHost.trim() : ''
  if (!allowRemote) {
    if (!raw) return ['127.0.0.1']
    const loopbacks = raw.split(',').map((s) => s.trim()).filter(isLoopbackHost)
    if (loopbacks.length === 0) {
      throw new Error('Refusing non-loopback HOST while operator authentication is uninitialized; set a password locally or configure OPERATOR_BOOTSTRAP_SECRET')
    }
    return [...new Set(loopbacks)]
  }
  if (raw === '0.0.0.0' || raw === '::') return [raw]
  const listed = raw
    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
    : ['127.0.0.1']
  if (listed.includes('0.0.0.0') || listed.includes('::')) return ['0.0.0.0']
  return [...new Set([...listed, ...tailscale])]
}

/**
 * Browser Origin allowed for the gateway: explicit list, *.ts.net, or 100.64/10.
 * @param {string|undefined} origin
 * @param {string[]} allowlist
 */
const isGatewayOrigin = (origin, allowlist = []) => {
  if (!origin) return true
  if (allowlist.includes(origin)) return true
  if (!URL.canParse(origin)) return false
  const { hostname } = new URL(origin)
  if (hostname.endsWith('.ts.net')) return true
  return isTailscaleIpv4(hostname)
}

/**
 * Express CORS middleware honoring isGatewayOrigin.
 * @param {string[]} [allowlist]
 */
const createCorsMiddleware = (allowlist = []) => (req, res, next) => {
  const origin = req.headers?.origin;
  if (isGatewayOrigin(origin, allowlist)) {
    if (origin) res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Operator-Bootstrap');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
};

/**
 * Bind one HTTP listener per host on `port` and resolve only once EVERY one
 * is listening. The first host uses `server`; each later host gets a fresh
 * `createServer()` handed to `onExtra` (Socket.IO attach) before it listens.
 *
 * The first bind failure rejects with the error carrying `host`/`port`, after
 * closing every listener that did bind, so a caller that exits on rejection
 * leaves no half-bound gateway behind. Callers start writers only after the
 * resolution: a port already owned by another gateway must stop this one
 * before it touches any state (see server.js).
 *
 * @param {{hosts: string[], port: number|string, server: import('http').Server, createServer: () => import('http').Server, onExtra?: (server: import('http').Server) => void, log?: (level: string, message: string) => void}} options
 * @returns {Promise<import('http').Server[]>} the extra servers (hosts after the first), in host order
 */
const bindGatewayListeners = ({ hosts, port, server, createServer, onExtra = () => {}, log = () => {} }) => {
  const listeners = hosts.map((host, i) => {
    const s = i === 0 ? server : createServer()
    if (i > 0) onExtra(s)
    return { host, server: s }
  })
  const bound = listeners.map(({ host, server: s }) => new Promise((resolve, reject) => {
    const onError = (err) => {
      s.removeListener('listening', onListening)
      reject(Object.assign(err, { host, port }))
    }
    const onListening = () => {
      s.removeListener('error', onError)
      log('INFO', `Critical Mass listening on http://${host}:${port}`)
      resolve(s)
    }
    s.once('error', onError)
    s.once('listening', onListening)
    s.listen(port, host)
  }))
  return Promise.all(bound).then(
    () => listeners.slice(1).map(({ server: s }) => s),
    async (err) => {
      await Promise.allSettled(listeners.map(({ server: s }) => new Promise((resolve) => s.close(() => resolve()))))
      throw err
    },
  )
}

/**
 * Bind Tailscale addresses that appear after startup (tailscaled finishing its
 * handshake after the process manager started the gateway, or a re-key). The
 * initial resolveListenHosts() enumeration happens once; this re-scans on an
 * unref'd interval and binds any address not yet listened on, one listener per
 * address with the same `onExtra` bookkeeping as the initial bind so the
 * shutdown path closes it. Addresses that disappear are not unbound (the OS
 * closes those sockets). A failed bind is retried on the next scan.
 *
 * @param {{bound: string[], port: number|string, createServer: () => import('http').Server, onExtra?: (server: import('http').Server) => void, isStopping?: () => boolean, scan?: () => string[], intervalMs?: number, log?: (level: string, message: string) => void}} options
 * @returns {{scan: () => Promise<string[]>, stop: () => void}} `scan` runs one pass and resolves the newly bound addresses
 */
const watchTailscaleListeners = ({
  bound, port, createServer, onExtra = () => {}, isStopping = () => false,
  scan = tailscaleIpv4s, intervalMs = 30_000, log = () => {},
}) => {
  const claimed = new Set(bound)
  const warned = new Set()
  let scanning = false
  const bindOne = async (host) => {
    const server = createServer()
    onExtra(server)
    claimed.add(host)
    await bindGatewayListeners({ hosts: [host], port, server, createServer, log })
    return host
  }
  const scanOnce = async () => {
    if (scanning || isStopping()) return []
    scanning = true
    try {
      const fresh = [...new Set(scan())].filter((host) => !claimed.has(host))
      const results = await Promise.allSettled(fresh.map(bindOne))
      return results.flatMap((r, i) => {
        if (r.status === 'fulfilled') return [r.value]
        claimed.delete(fresh[i])
        if (!isStopping() && !warned.has(fresh[i])) {
          warned.add(fresh[i])
          log('WARN', `Late Tailscale bind http://${fresh[i]}:${port} failed (${r.reason?.code || r.reason?.message}); retrying every ${intervalMs / 1000}s`)
        }
        return []
      })
    } finally {
      scanning = false
    }
  }
  const timer = setInterval(() => { scanOnce().catch(() => {}) }, intervalMs)
  timer.unref()
  return { scan: scanOnce, stop: () => clearInterval(timer) }
}

module.exports = {
  isTailscaleIpv4,
  isLoopbackHost,
  tailscaleIpv4s,
  resolveListenHosts,
  isGatewayOrigin,
  createCorsMiddleware,
  bindGatewayListeners,
  watchTailscaleListeners,
}

