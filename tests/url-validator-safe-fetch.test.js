// @ts-check
/**
 * Tests for src/url-validator.js — createSafeLookup() and safeFetch()
 *
 * Covers the remediation for issue #207 (UpDown SSRF + credential leak)
 * and issue #215-A (sentinel feed SSRF), both of which reuse this module:
 *  - createSafeLookup(): the connect-time DNS re-check that closes the
 *    TOCTOU / DNS-rebinding gap between validateEndpointUrl's lookup and
 *    the real outbound connection.
 *  - safeFetch(): redirect targets are re-validated, Authorization is
 *    stripped on cross-origin redirects, method/body are downgraded per
 *    fetch semantics on 301/302/303, and the response body is capped.
 *
 * http.request/https.request are mocked throughout — no real sockets or
 * network calls are made.
 */
const { describe, it, before, after, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const dns = require('dns');
const http = require('http');
const https = require('https');

const { createSafeLookup, safeFetch } = require('../src/url-validator');

// ---------------------------------------------------------------------------
// DNS stub — makes validateEndpointUrl() treat every test hostname as public.
// ---------------------------------------------------------------------------
let _origDnsLookup;
function stubDnsLookup(impl) {
  _origDnsLookup = dns.lookup;
  dns.lookup = impl;
}
function restoreDnsLookup() {
  if (_origDnsLookup) dns.lookup = _origDnsLookup;
  _origDnsLookup = null;
}
const publicLookup = (hostname, options, callback) => {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (options && options.all) return callback(null, [{ address: '104.21.0.1', family: 4 }]);
  callback(null, '104.21.0.1', 4);
};

// ============================================================================
// createSafeLookup
// ============================================================================

describe('createSafeLookup — connect-time TOCTOU re-check', () => {
  afterEach(() => restoreDnsLookup());

  it('rejects a lookup that resolves to a private IPv4 address', () => {
    stubDnsLookup((hostname, options, callback) => {
      if (typeof options === 'function') callback = options;
      callback(null, '169.254.169.254', 4);
    });
    const lookup = createSafeLookup();
    return new Promise((resolve) => {
      lookup('rebound.example.com', {}, (err, address) => {
        assert.ok(err, 'expected an error for a private resolved address');
        assert.match(err.message, /Blocked private\/reserved IPv4/);
        resolve();
      });
    });
  });

  it('rejects a lookup that resolves to a private IPv6 address', () => {
    stubDnsLookup((hostname, options, callback) => {
      if (typeof options === 'function') callback = options;
      callback(null, '::1', 6);
    });
    const lookup = createSafeLookup();
    return new Promise((resolve) => {
      lookup('rebound6.example.com', {}, (err) => {
        assert.ok(err, 'expected an error for a private resolved IPv6 address');
        assert.match(err.message, /Blocked private\/reserved IPv6/);
        resolve();
      });
    });
  });

  it('passes through a public address unchanged', () => {
    stubDnsLookup(publicLookup);
    const lookup = createSafeLookup();
    return new Promise((resolve) => {
      lookup('1.1.1.1', {}, (err, address, family) => {
        assert.equal(err, null);
        assert.equal(address, '104.21.0.1');
        assert.equal(family, 4);
        resolve();
      });
    });
  });

  it('propagates the underlying DNS error', () => {
    stubDnsLookup((hostname, options, callback) => {
      if (typeof options === 'function') callback = options;
      callback(new Error('getaddrinfo ENOTFOUND'));
    });
    const lookup = createSafeLookup();
    return new Promise((resolve) => {
      lookup('unresolvable.invalid', {}, (err) => {
        assert.match(err.message, /ENOTFOUND/);
        resolve();
      });
    });
  });

  it('accepts the (hostname, callback) 2-arg form', () => {
    stubDnsLookup(publicLookup);
    const lookup = createSafeLookup();
    return new Promise((resolve) => {
      lookup('1.1.1.1', (err, address, family) => {
        assert.equal(err, null);
        assert.equal(address, '104.21.0.1');
        assert.equal(family, 4);
        resolve();
      });
    });
  });
});

// ============================================================================
// safeFetch
// ============================================================================

/** Build a fake IncomingMessage-like response (listeners attached by the caller first). */
function fakeResponse({ statusCode, headers = {} }) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.headers = headers;
  res.destroy = () => {};
  return res;
}

/**
 * Install a fake http.request/https.request that pops the next descriptor
 * from `responses` for each call and records the call args in `calls`.
 *
 * Ordering matters here: the response callback (`cb`) must attach its
 * `res.on('data'/'end', ...)` listeners *before* any data/end events are
 * emitted, exactly like a real socket — emitting first would silently
 * drop the events and hang the caller's Promise forever.
 */
function installFakeRequest(responses, calls) {
  const factory = (urlOrOptions, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : options;
    calls.push({ url: urlOrOptions, options: opts });
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      const descriptor = responses.shift();
      if (!descriptor) throw new Error('installFakeRequest: no more responses queued');
      if (descriptor.error) {
        process.nextTick(() => req.emit('error', descriptor.error));
        return;
      }
      const res = fakeResponse(descriptor);
      process.nextTick(() => {
        cb(res); // attaches res.on('data'/'end'/'error', ...) synchronously
        process.nextTick(() => {
          for (const c of descriptor.chunks || []) res.emit('data', Buffer.isBuffer(c) ? c : Buffer.from(c));
          res.emit('end');
        });
      });
    };
    return req;
  };
  mock.method(http, 'request', factory);
  mock.method(https, 'request', factory);
}

describe('safeFetch', () => {
  before(() => stubDnsLookup(publicLookup));
  after(() => restoreDnsLookup());
  afterEach(() => mock.restoreAll());

  it('rejects an unsafe initial URL without making any request', async () => {
    const calls = [];
    installFakeRequest([], calls);
    await assert.rejects(
      () => safeFetch('http://169.254.169.254/latest/meta-data/'),
      /Blocked endpoint/
    );
    assert.equal(calls.length, 0);
  });

  it('returns a fetch-like response for a plain 200', async () => {
    const calls = [];
    installFakeRequest([
      { statusCode: 200, headers: { 'content-type': 'application/json' }, chunks: [JSON.stringify({ hello: 'world' })] },
    ], calls);

    const response = await safeFetch('http://1.1.1.1/api');
    assert.equal(response.ok, true);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.deepEqual(await response.json(), { hello: 'world' });
    assert.equal(calls.length, 1);
  });

  it('follows a same-origin redirect and keeps the Authorization header', async () => {
    const calls = [];
    installFakeRequest([
      { statusCode: 302, headers: { location: 'http://1.1.1.1/final' } },
      { statusCode: 200, headers: {}, chunks: ['ok'] },
    ], calls);

    const response = await safeFetch('http://1.1.1.1/start', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret-key' },
      body: '{}',
    });
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    // Same-origin redirect: credential must still be present.
    assert.equal(calls[1].options.headers.Authorization, 'Bearer secret-key');
  });

  it('strips Authorization on a cross-origin redirect (issue #207 credential leak)', async () => {
    const calls = [];
    installFakeRequest([
      { statusCode: 302, headers: { location: 'http://8.8.8.8/steal' } },
      { statusCode: 200, headers: {}, chunks: ['ok'] },
    ], calls);

    const response = await safeFetch('http://1.1.1.1/start', {
      method: 'GET',
      headers: { Authorization: 'Bearer secret-key' },
    });
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-key');
    assert.equal(calls[1].options.headers.Authorization, undefined, 'Authorization must not be re-sent cross-origin');
  });

  it('re-validates a redirect target and refuses to follow it into a private range (issue #207 redirect bypass)', async () => {
    const calls = [];
    installFakeRequest([
      { statusCode: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' } },
    ], calls);

    await assert.rejects(
      () => safeFetch('http://1.1.1.1/start', { headers: { Authorization: 'Bearer secret-key' } }),
      /Blocked endpoint/
    );
    // Only the first (validated) request should have been attempted.
    assert.equal(calls.length, 1);
  });

  it('downgrades POST to GET with no body on a 303', async () => {
    const calls = [];
    installFakeRequest([
      { statusCode: 303, headers: { location: 'http://1.1.1.1/final' } },
      { statusCode: 200, headers: {}, chunks: ['ok'] },
    ], calls);

    await safeFetch('http://1.1.1.1/start', { method: 'POST', body: 'payload' });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.method, 'GET');
    assert.equal(calls[1].options.headers['Content-Length'], undefined);
  });

  it('preserves method and body on a 307', async () => {
    const calls = [];
    installFakeRequest([
      { statusCode: 307, headers: { location: 'http://1.1.1.1/final' } },
      { statusCode: 200, headers: {}, chunks: ['ok'] },
    ], calls);

    await safeFetch('http://1.1.1.1/start', { method: 'POST', body: 'payload' });
    assert.equal(calls[1].options.method, 'POST');
    assert.equal(calls[1].options.headers['Content-Length'], String(Buffer.byteLength('payload')));
  });

  it('gives up after too many redirects', async () => {
    const calls = [];
    const responses = [];
    for (let i = 0; i < 10; i++) {
      responses.push({ statusCode: 302, headers: { location: `http://1.1.1.1/hop${i}` } });
    }
    installFakeRequest(responses, calls);

    await assert.rejects(
      () => safeFetch('http://1.1.1.1/start', { maxRedirects: 3 }),
      /Too many redirects/
    );
    // initial attempt + 3 redirects = 4 requests before giving up
    assert.equal(calls.length, 4);
  });

  it('rejects when the response body exceeds maxResponseBytes', async () => {
    const calls = [];
    installFakeRequest([
      { statusCode: 200, headers: {}, chunks: [Buffer.alloc(100, 'a')] },
    ], calls);

    await assert.rejects(
      () => safeFetch('http://1.1.1.1/big', { maxResponseBytes: 10 }),
      /exceeded maximum size/
    );
  });
});
