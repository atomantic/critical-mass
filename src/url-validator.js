// @ts-check
/**
 * URL Validator — SSRF Defence
 *
 * Validates provider endpoint URLs before they are used to make outbound
 * HTTP requests. Rejects:
 *   - Non-http/https schemes
 *   - Private IPv4 ranges (RFC 1918 + loopback + link-local)
 *   - Private IPv6 ranges (loopback, ULA fc00::/7, link-local fe80::/10)
 *   - Hostnames that resolve to 'localhost' or the empty string
 */

'use strict';

/**
 * Private / reserved IPv4 CIDR ranges to block.
 * Each entry is [networkInt, maskInt].
 */
const BLOCKED_IPV4_RANGES = [
  // 127.0.0.0/8 — loopback
  [0x7f000000, 0xff000000],
  // 10.0.0.0/8 — RFC 1918
  [0x0a000000, 0xff000000],
  // 172.16.0.0/12 — RFC 1918
  [0xac100000, 0xfff00000],
  // 192.168.0.0/16 — RFC 1918
  [0xc0a80000, 0xffff0000],
  // 169.254.0.0/16 — link-local / AWS metadata
  [0xa9fe0000, 0xffff0000],
];

/**
 * Convert a dotted-decimal IPv4 string to a 32-bit integer.
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
 * Handles ::1 (loopback), fc00::/7 (ULA), fe80::/10 (link-local).
 * This is a best-effort textual check — Node's built-in URL parser
 * normalises brackets so the hostname arrives without them.
 * @param {string} ip
 * @returns {boolean}
 */
function isBlockedIPv6(ip) {
  // Normalise: strip surrounding brackets if present
  const addr = ip.replace(/^\[|\]$/g, '').toLowerCase();

  // ::1 — loopback
  if (addr === '::1') return true;

  // fc00::/7 — ULA (fc__ and fd__)
  if (/^f[cd]/i.test(addr)) return true;

  // fe80::/10 — link-local
  if (/^fe[89ab]/i.test(addr)) return true;

  return false;
}

/**
 * Validate an AI provider endpoint URL for SSRF safety.
 *
 * Rules:
 *  1. Must parse as a valid URL.
 *  2. Scheme must be `http` or `https`.
 *  3. Hostname must not resolve to a private/reserved address range.
 *
 * @param {string} url
 * @returns {{ valid: boolean, error?: string }}
 */
function validateEndpointUrl(url) {
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

  // Rule 2: reject bare 'localhost'
  if (hostname === 'localhost') {
    return { valid: false, error: 'Endpoint hostname resolves to a private address (localhost)' };
  }

  // Rule 3: reject private IPv4
  if (isBlockedIPv4(hostname)) {
    return { valid: false, error: `Endpoint IP address is in a private/reserved range: ${hostname}` };
  }

  // Rule 4: reject private IPv6
  if (isBlockedIPv6(hostname)) {
    return { valid: false, error: `Endpoint IPv6 address is in a private/reserved range: ${hostname}` };
  }

  return { valid: true };
}

module.exports = { validateEndpointUrl };
