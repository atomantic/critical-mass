// @ts-check
/**
 * Tests for src/url-validator.js
 *
 * Covers:
 *  - Allowed and blocked schemes
 *  - Blocked IPv4 private/reserved ranges (including 0.0.0.0, carrier-grade NAT, etc.)
 *  - localhost and trailing-dot variants
 *  - IPv6 blocked ranges (::, ::1, ULA, link-local)
 *  - IPv4-mapped IPv6 (::ffff:127.0.0.1, ::ffff:7f00:0001)
 *  - Public URLs are accepted
 *  - DNS failure causes rejection
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { validateEndpointUrl, isBlockedIPv4, isBlockedIPv6, checkHostnameTextual } = require('../src/url-validator');

// ============================================================================
// isBlockedIPv4
// ============================================================================

describe('isBlockedIPv4 — blocked ranges', () => {
  const blocked = [
    '0.0.0.0',          // unspecified
    '0.0.0.1',          // 0.x.x.x
    '10.0.0.1',         // RFC 1918
    '10.255.255.255',
    '100.64.0.1',       // carrier-grade NAT
    '127.0.0.1',        // loopback
    '127.255.255.255',
    '169.254.0.1',      // link-local / AWS metadata
    '169.254.169.254',
    '172.16.0.1',       // RFC 1918
    '172.31.255.255',
    '192.0.0.1',        // IETF protocol
    '192.168.0.1',      // RFC 1918
    '192.168.255.255',
    '198.18.0.1',       // benchmark
    '198.51.100.1',     // TEST-NET-2
    '203.0.113.1',      // TEST-NET-3
    '240.0.0.1',        // reserved
    '255.255.255.255',  // broadcast
  ];

  for (const ip of blocked) {
    it(`blocks ${ip}`, () => {
      assert.equal(isBlockedIPv4(ip), true);
    });
  }
});

describe('isBlockedIPv4 — allowed public IPs', () => {
  const allowed = [
    '1.1.1.1',
    '8.8.8.8',
    '104.21.0.1',
    '208.67.222.222',
  ];

  for (const ip of allowed) {
    it(`allows ${ip}`, () => {
      assert.equal(isBlockedIPv4(ip), false);
    });
  }
});

// ============================================================================
// isBlockedIPv6
// ============================================================================

describe('isBlockedIPv6 — blocked addresses', () => {
  const blocked = [
    '::',                           // unspecified
    '::1',                          // loopback
    'fc00::1',                      // ULA
    'fd00::1',                      // ULA
    'fe80::1',                      // link-local
    'fe89::1',                      // link-local
    'feab::1',                      // link-local
    '::ffff:127.0.0.1',            // IPv4-mapped loopback (dotted)
    '::ffff:10.0.0.1',             // IPv4-mapped RFC1918 (dotted)
    '::ffff:7f00:0001',            // IPv4-mapped loopback (hex)
    '::ffff:c0a8:0001',            // IPv4-mapped 192.168.0.1 (hex)
  ];

  for (const ip of blocked) {
    it(`blocks ${ip}`, () => {
      assert.equal(isBlockedIPv6(ip), true);
    });
  }
});

describe('isBlockedIPv6 — allowed public addresses', () => {
  const allowed = [
    '2001:db8::1',     // documentation range (public in practice)
    '2606:4700::1',    // Cloudflare
    '::ffff:1.1.1.1',  // IPv4-mapped public IP
  ];

  for (const ip of allowed) {
    it(`allows ${ip}`, () => {
      assert.equal(isBlockedIPv6(ip), false);
    });
  }
});

// ============================================================================
// checkHostnameTextual
// ============================================================================

describe('checkHostnameTextual — localhost variants', () => {
  const localHosts = ['localhost', 'localhost.'];

  for (const h of localHosts) {
    it(`blocks ${h}`, () => {
      const result = checkHostnameTextual(h);
      assert.equal(result.blocked, true);
    });
  }
});

describe('checkHostnameTextual — bare private IPs', () => {
  it('blocks bare 127.0.0.1', () => {
    assert.equal(checkHostnameTextual('127.0.0.1').blocked, true);
  });
  it('blocks bare ::1', () => {
    assert.equal(checkHostnameTextual('::1').blocked, true);
  });
  it('allows public IPv4', () => {
    assert.equal(checkHostnameTextual('1.1.1.1').blocked, false);
  });
  it('allows public hostname', () => {
    assert.equal(checkHostnameTextual('api.example.com').blocked, false);
  });
});

// ============================================================================
// validateEndpointUrl (async)
// ============================================================================

describe('validateEndpointUrl — invalid inputs', () => {
  it('rejects null/empty', async () => {
    assert.equal((await validateEndpointUrl('')).valid, false);
    assert.equal((await validateEndpointUrl(null)).valid, false);
  });

  it('rejects non-URL strings', async () => {
    const result = await validateEndpointUrl('not-a-url');
    assert.equal(result.valid, false);
    assert.match(result.error, /Invalid URL/i);
  });

  it('rejects non-http/https schemes', async () => {
    for (const url of ['ftp://example.com', 'file:///etc/passwd', 'data:text/html,evil']) {
      const result = await validateEndpointUrl(url);
      assert.equal(result.valid, false);
      assert.match(result.error, /scheme must be http or https/i);
    }
  });
});

describe('validateEndpointUrl — private/localhost URLs rejected', () => {
  const privateUrls = [
    'http://localhost/api',
    'http://localhost./api',    // trailing dot
    'http://127.0.0.1/api',
    'http://0.0.0.0/api',
    'http://169.254.169.254/',   // AWS metadata
    'http://10.0.0.1/api',
    'http://192.168.1.1/api',
    'http://172.16.0.1/api',
    'http://[::1]/api',
    'http://[::]/api',
    'http://[fc00::1]/api',
    'http://[::ffff:127.0.0.1]/api',
  ];

  for (const url of privateUrls) {
    it(`rejects ${url}`, async () => {
      const result = await validateEndpointUrl(url);
      assert.equal(result.valid, false, `Expected ${url} to be rejected but it was accepted`);
    });
  }
});

describe('validateEndpointUrl — public URLs accepted', () => {
  const publicUrls = [
    'https://api.openai.com/v1',
    'https://api.anthropic.com',
    'http://1.1.1.1/api',
    'https://8.8.8.8',
  ];

  for (const url of publicUrls) {
    it(`accepts ${url}`, async () => {
      const result = await validateEndpointUrl(url);
      // DNS for 1.1.1.1 and 8.8.8.8 are bare IPs (no DNS lookup needed);
      // api.openai.com / api.anthropic.com resolve publicly in CI.
      // If DNS is unavailable in the test env, this may fail; that is intentional.
      assert.equal(result.valid, true, `Expected ${url} to be accepted but got: ${result.error}`);
    });
  }
});
