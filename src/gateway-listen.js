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

/**
 * @param {string|undefined} envHost
 * @param {string[]} [tailscale]
 * @returns {string[]}
 */
const resolveListenHosts = (envHost, tailscale = tailscaleIpv4s()) => {
  const raw = typeof envHost === 'string' ? envHost.trim() : ''
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

module.exports = {
  isTailscaleIpv4,
  tailscaleIpv4s,
  resolveListenHosts,
  isGatewayOrigin,
}
