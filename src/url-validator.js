// @ts-check
/**
 * URL Validator — SSRF Defence
 *
 * Validates provider endpoint URLs before they are used to make outbound
 * HTTP requests. Rejects:
 *   - Non-http/https schemes
 *   - Private IPv4 ranges (RFC 1918, loopback, link-local, unspecified, and other reserved)
 *   - Private IPv6 ranges (unspecified ::, loopback ::1, ULA fc00::/7, link-local fe80::/10,
 *     IPv4-mapped ::ffff:x.x.x.x where the embedded address is private)
 *   - localhost (including trailing-dot variants like 'localhost.')
 *   - Hostnames that DNS-resolve to any of the above private addresses
 */

'use strict';

const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const { promisify } = require('util');

const dnsLookup = promisify(dns.lookup);

/**
 * Private / reserved IPv4 CIDR ranges to block.
 * Each entry is [networkInt, maskInt].
 */
const BLOCKED_IPV4_RANGES = [
  // 0.0.0.0/8 — unspecified / "this" network
  [0x00000000, 0xff000000],
  // 10.0.0.0/8 — RFC 1918
  [0x0a000000, 0xff000000],
  // 100.64.0.0/10 — Shared address space (carrier-grade NAT)
  [0x64400000, 0xffc00000],
  // 127.0.0.0/8 — loopback
  [0x7f000000, 0xff000000],
  // 169.254.0.0/16 — link-local / cloud metadata (AWS/GCP/Azure)
  [0xa9fe0000, 0xffff0000],
  // 172.16.0.0/12 — RFC 1918
  [0xac100000, 0xfff00000],
  // 192.0.0.0/24 — IETF Protocol Assignments
  [0xc0000000, 0xffffff00],
  // 192.168.0.0/16 — RFC 1918
  [0xc0a80000, 0xffff0000],
  // 198.18.0.0/15 — Benchmark testing
  [0xc6120000, 0xfffe0000],
  // 198.51.100.0/24 — TEST-NET-2 (documentation)
  [0xc6336400, 0xffffff00],
  // 203.0.113.0/24 — TEST-NET-3 (documentation)
  [0xcb007100, 0xffffff00],
  // 240.0.0.0/4 — Reserved
  [0xf0000000, 0xf0000000],
  // 255.255.255.255/32 — Limited broadcast
  [0xffffffff, 0xffffffff],
];

/**
 * Convert a dotted-decimal IPv4 string to a 32-bit unsigned integer.
 * Returns null if the input is not a valid IPv4 address.
 * @param {string} ip
 * @returns {number | null}
 */
function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const byte = parseInt(part, 10);
    if (!Number.isInteger(byte) || byte < 0 || byte > 255 || String(byte) !== part) return null;
    n = (n << 8) | byte;
  }
  // Shift to unsigned 32-bit
  return n >>> 0;
}

/**
 * Return true if the IPv4 address falls within any blocked range.
 * @param {string} ip
 * @returns {boolean}
 */
function isBlockedIPv4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  for (const [network, mask] of BLOCKED_IPV4_RANGES) {
    if ((n & mask) >>> 0 === network) return true;
  }
  return false;
}

/**
 * Return true if the IPv6 address string is in a blocked range.
 * Handles:
 *   - :: (unspecified address)
 *   - ::1 (loopback)
 *   - fc00::/7 (ULA: fc__ and fd__)
 *   - fe80::/10 (link-local)
 *   - ::ffff:x.x.x.x (IPv4-mapped) — also checks the embedded IPv4 address
 *
 * Note: Node's built-in URL parser strips brackets so the hostname arrives
 * without them (e.g. ::1 not [::1]).
 * @param {string} ip
 * @returns {boolean}
 */
function isBlockedIPv6(ip) {
  // Normalise: strip surrounding brackets if present
  const addr = ip.replace(/^\[|\]$/g, '').toLowerCase();

  // :: — unspecified address
  if (addr === '::') return true;

  // ::1 — loopback
  if (addr === '::1') return true;

  // fc00::/7 — ULA (fc__ and fd__)
  if (/^f[cd]/i.test(addr)) return true;

  // fe80::/10 — link-local
  if (/^fe[89ab]/i.test(addr)) return true;

  // ::ffff:x.x.x.x — IPv4-mapped (dotted-decimal form)
  const ipv4MappedDotted = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4MappedDotted) {
    return isBlockedIPv4(ipv4MappedDotted[1]);
  }

  // ::ffff:xxxx:xxxx — IPv4-mapped (hex form, e.g. ::ffff:7f00:0001 → 127.0.0.1)
  const ipv4MappedHex = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (ipv4MappedHex) {
    const hi = parseInt(ipv4MappedHex[1], 16);
    const lo = parseInt(ipv4MappedHex[2], 16);
    const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isBlockedIPv4(dotted);
  }

  return false;
}

/**
 * Run textual checks on a URL hostname (after URL parsing, brackets stripped).
 * Covers bare IPs and localhost variants before DNS resolution.
 * @param {string} hostname — lower-cased hostname from parsed URL
 * @returns {{ blocked: boolean, reason?: string }}
 */
function checkHostnameTextual(hostname) {
  // Strip trailing dot (FQDN notation) — e.g. "localhost." → "localhost"
  const h = hostname.replace(/\.$/, '');

  // Reject localhost in all forms (with or without trailing dot)
  if (h === 'localhost') {
    return { blocked: true, reason: 'Endpoint hostname resolves to a private address (localhost)' };
  }

  // Bare IPv4 address
  if (net.isIPv4(h)) {
    if (isBlockedIPv4(h)) {
      return { blocked: true, reason: `Endpoint IP address is in a private/reserved range: ${h}` };
    }
    return { blocked: false };
  }

  // Bare IPv6 address (Node's URL parser strips brackets; net.isIPv6 handles unbracketed form)
  if (net.isIPv6(h)) {
    if (isBlockedIPv6(h)) {
      return { blocked: true, reason: `Endpoint IPv6 address is in a private/reserved range: ${h}` };
    }
    return { blocked: false };
  }

  return { blocked: false };
}

/**
 * Validate an AI provider endpoint URL for SSRF safety.
 *
 * Rules:
 *  1. Must parse as a valid URL.
 *  2. Scheme must be `http` or `https`.
 *  3. Hostname must not be a private/reserved name or IP (textual check).
 *  4. Hostname must DNS-resolve without errors, and all resolved addresses
 *     must be public (mitigates basic DNS-based SSRF).
 *
 * @param {string} url
 * @returns {Promise<{ valid: boolean, error?: string }>}
 */
async function validateEndpointUrl(url) {
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'Endpoint URL is required' };
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, error: `Invalid URL: ${url}` };
  }

  // Rule 1: scheme must be http or https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, error: `Endpoint scheme must be http or https, got: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Rule 2: fast textual checks (localhost, bare IPs) before DNS round-trip
  const textCheck = checkHostnameTextual(hostname);
  if (textCheck.blocked) {
    return { valid: false, error: textCheck.reason };
  }

  // Rule 3: DNS resolution — reject if ANY resolved address is private/reserved.
  // Skip DNS lookup for bare IP addresses (already checked textually above).
  if (!net.isIP(hostname)) {
    try {
      const resolved = await dnsLookup(hostname, { all: true });
      for (const { address, family } of resolved) {
        if (family === 4 && isBlockedIPv4(address)) {
          return { valid: false, error: 'Endpoint hostname resolves to a private/reserved IPv4 address' };
        }
        if (family === 6 && isBlockedIPv6(address)) {
          return { valid: false, error: 'Endpoint hostname resolves to a private/reserved IPv6 address' };
        }
      }
    } catch (err) {
      // DNS lookup failed — treat as invalid to avoid SSRF via unresolvable hosts.
      return { valid: false, error: `Endpoint hostname could not be resolved: ${/** @type {Error} */(err).message}` };
    }
  }

  return { valid: true };
}

/**
 * Build a `dns.lookup`-compatible function to pass as the `lookup` option
 * on an `http.request`/`https.request` call.
 *
 * Why this exists: `validateEndpointUrl()` resolves DNS once, up front.
 * The actual outbound connection resolves DNS again, independently,
 * milliseconds later. A hostname whose record flips public -> private
 * between those two round trips (DNS rebinding) would sail through the
 * validator and then connect to the private address anyway (TOCTOU).
 *
 * This lookup function is invoked by Node's own connection machinery at
 * the moment the socket is actually opened, so re-checking the resolved
 * address here closes that gap — the address that gets checked is the
 * address that gets connected to.
 *
 * @returns {(hostname: string, options: object, callback: Function) => void}
 */
function createSafeLookup() {
  return (hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    dns.lookup(hostname, options, (err, address, family) => {
      if (err) return callback(err);
      if (family === 4 && isBlockedIPv4(address)) {
        return callback(new Error(`Blocked private/reserved IPv4 address for ${hostname}: ${address}`));
      }
      if (family === 6 && isBlockedIPv6(address)) {
        return callback(new Error(`Blocked private/reserved IPv6 address for ${hostname}: ${address}`));
      }
      callback(null, address, family);
    });
  };
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_RESPONSE_BYTES = 20 * 1024 * 1024; // 20MB

/**
 * Strip Authorization headers (any casing) from a headers object. Used
 * whenever a redirect crosses origins so credentials are never re-sent
 * to a host the caller didn't configure.
 * @param {Record<string,string>} headers
 * @returns {Record<string,string>}
 */
function stripAuthHeaders(headers) {
  const out = {};
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'authorization') continue;
    out[key] = headers[key];
  }
  return out;
}

/**
 * SSRF-safe, redirect-safe replacement for `fetch()`.
 *
 * Unlike a plain `fetch(url, { headers })`, this:
 *  1. Runs every URL — including every redirect target — through
 *     `validateEndpointUrl()` before connecting (fixes redirect bypass).
 *  2. Never auto-follows a redirect to an origin different from the one
 *     that was validated without re-validating it first.
 *  3. Strips the `Authorization` header whenever a redirect changes
 *     origin (fixes credential leak on cross-origin redirect).
 *  4. Uses a connect-time DNS `lookup` hook that re-checks the resolved
 *     address against the private-range denylist (fixes DNS-rebinding
 *     TOCTOU — see `createSafeLookup`).
 *  5. Caps the response body size to avoid unbounded memory growth from
 *     a malicious or misbehaving remote endpoint.
 *
 * Method/body handling on redirect mirrors the WHATWG fetch spec: a 303
 * always downgrades to GET with no body; a 301/302 downgrades POST to
 * GET with no body; 307/308 preserve the original method and body.
 *
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string,string>, body?: string, signal?: AbortSignal, maxRedirects?: number, maxResponseBytes?: number }} [options]
 * @returns {Promise<{ ok: boolean, status: number, headers: { get: (name: string) => string | undefined }, text: () => Promise<string>, json: () => Promise<any> }>}
 */
async function safeFetch(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    signal,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  } = options;

  const originalOrigin = new URL(url).origin;
  let currentUrl = url;
  let currentMethod = method;
  let currentHeaders = { ...headers };
  let currentBody = body;

  for (let attempt = 0; attempt <= maxRedirects; attempt++) {
    const validation = await validateEndpointUrl(currentUrl);
    if (!validation.valid) {
      throw new Error(`Blocked endpoint: ${validation.error}`);
    }

    const parsed = new URL(currentUrl);
    if (parsed.origin !== originalOrigin) {
      currentHeaders = stripAuthHeaders(currentHeaders);
    }

    const reqHeaders = { ...currentHeaders };
    if (currentBody != null) {
      reqHeaders['Content-Length'] = String(Buffer.byteLength(currentBody));
    } else {
      delete reqHeaders['Content-Length'];
      delete reqHeaders['content-length'];
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    /** @type {{ status: number, headers: Record<string, string | string[] | undefined>, buffer: Buffer }} */
    const result = await new Promise((resolve, reject) => {
      const req = lib.request(parsed, {
        method: currentMethod,
        headers: reqHeaders,
        lookup: createSafeLookup(),
        signal,
      }, (res) => {
        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > maxResponseBytes) {
            res.destroy();
            reject(new Error(`Response exceeded maximum size of ${maxResponseBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) });
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      if (currentBody != null) req.write(currentBody);
      req.end();
    });

    const location = result.headers.location;
    if (REDIRECT_STATUSES.has(result.status) && location) {
      currentUrl = new URL(String(location), currentUrl).toString();
      if (result.status === 303 || ((result.status === 301 || result.status === 302) && currentMethod === 'POST')) {
        currentMethod = 'GET';
        currentBody = undefined;
      }
      continue;
    }

    const responseHeaders = result.headers;
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      headers: { get: (name) => {
        const v = responseHeaders[name.toLowerCase()];
        return Array.isArray(v) ? v.join(', ') : v;
      } },
      text: async () => result.buffer.toString('utf-8'),
      json: async () => JSON.parse(result.buffer.toString('utf-8')),
    };
  }

  throw new Error(`Too many redirects (>${maxRedirects}) for ${url}`);
}

module.exports = {
  validateEndpointUrl,
  isBlockedIPv4,
  isBlockedIPv6,
  checkHostnameTextual,
  createSafeLookup,
  safeFetch,
};
