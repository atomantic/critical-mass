// @ts-check
/**
 * Tests for src/auth-middleware.js
 *
 * The module reads API_TOKEN and ALLOW_UNAUTHENTICATED_API from process.env at
 * require() time, so each scenario re-requires the module with a fresh env state
 * using require() after manipulating process.env and clearing the module cache.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

/**
 * Load a fresh copy of auth-middleware with a specific env configuration.
 * @param {{ API_TOKEN?: string, ALLOW_UNAUTHENTICATED_API?: string }} env
 */
function loadMiddleware(env = {}) {
  // Clear the cached module so env vars are re-read.
  delete require.cache[require.resolve('../src/auth-middleware')];

  const saved = {
    API_TOKEN: process.env.API_TOKEN,
    ALLOW_UNAUTHENTICATED_API: process.env.ALLOW_UNAUTHENTICATED_API,
  };

  // Apply test env
  if ('API_TOKEN' in env) {
    process.env.API_TOKEN = env.API_TOKEN;
  } else {
    delete process.env.API_TOKEN;
  }
  if ('ALLOW_UNAUTHENTICATED_API' in env) {
    process.env.ALLOW_UNAUTHENTICATED_API = env.ALLOW_UNAUTHENTICATED_API;
  } else {
    delete process.env.ALLOW_UNAUTHENTICATED_API;
  }

  const mod = require('../src/auth-middleware');

  // Restore env
  if (saved.API_TOKEN !== undefined) {
    process.env.API_TOKEN = saved.API_TOKEN;
  } else {
    delete process.env.API_TOKEN;
  }
  if (saved.ALLOW_UNAUTHENTICATED_API !== undefined) {
    process.env.ALLOW_UNAUTHENTICATED_API = saved.ALLOW_UNAUTHENTICATED_API;
  } else {
    delete process.env.ALLOW_UNAUTHENTICATED_API;
  }

  return mod;
}

/**
 * Create a minimal mock Express request.
 * @param {{ authorization?: string }} headers
 */
function mockReq(headers = {}) {
  return { headers };
}

/**
 * Create a minimal mock Express response that captures the last json() call.
 */
function mockRes() {
  const res = {
    _status: 200,
    _body: null,
    status(code) { res._status = code; return res; },
    json(body) { res._body = body; return res; },
  };
  return res;
}

// ============================================================================
// apiAuthMiddleware
// ============================================================================

describe('apiAuthMiddleware — API_TOKEN configured', () => {
  const TOKEN = 'super-secret-token-42';

  it('returns 401 when Authorization header is missing', () => {
    const { apiAuthMiddleware } = loadMiddleware({ API_TOKEN: TOKEN });
    const req = mockReq({});
    const res = mockRes();
    let nextCalled = false;
    apiAuthMiddleware(req, res, () => { nextCalled = true; });
    assert.equal(res._status, 401);
    assert.equal(nextCalled, false);
    assert.match(res._body.error, /Missing Authorization/i);
  });

  it('returns 401 when token is wrong', () => {
    const { apiAuthMiddleware } = loadMiddleware({ API_TOKEN: TOKEN });
    const req = mockReq({ authorization: 'Bearer wrong-token' });
    const res = mockRes();
    let nextCalled = false;
    apiAuthMiddleware(req, res, () => { nextCalled = true; });
    assert.equal(res._status, 401);
    assert.equal(nextCalled, false);
    assert.match(res._body.error, /Invalid token/i);
  });

  it('calls next() when token is correct', () => {
    const { apiAuthMiddleware } = loadMiddleware({ API_TOKEN: TOKEN });
    const req = mockReq({ authorization: `Bearer ${TOKEN}` });
    const res = mockRes();
    let nextCalled = false;
    apiAuthMiddleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res._body, null);
  });

  it('returns 401 for non-Bearer auth schemes', () => {
    const { apiAuthMiddleware } = loadMiddleware({ API_TOKEN: TOKEN });
    const req = mockReq({ authorization: `Basic ${TOKEN}` });
    const res = mockRes();
    let nextCalled = false;
    apiAuthMiddleware(req, res, () => { nextCalled = true; });
    assert.equal(res._status, 401);
    assert.equal(nextCalled, false);
  });
});

describe('apiAuthMiddleware — API_TOKEN not set, fail closed', () => {
  it('returns 401 when API_TOKEN is unset and ALLOW_UNAUTHENTICATED_API is not set', () => {
    const { apiAuthMiddleware } = loadMiddleware({});
    const req = mockReq({});
    const res = mockRes();
    let nextCalled = false;
    apiAuthMiddleware(req, res, () => { nextCalled = true; });
    assert.equal(res._status, 401);
    assert.equal(nextCalled, false);
  });

  it('calls next() when API_TOKEN is unset but ALLOW_UNAUTHENTICATED_API=true', () => {
    const { apiAuthMiddleware } = loadMiddleware({ ALLOW_UNAUTHENTICATED_API: 'true' });
    const req = mockReq({});
    const res = mockRes();
    let nextCalled = false;
    apiAuthMiddleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res._body, null);
  });
});

// ============================================================================
// validateSocketToken
// ============================================================================

describe('validateSocketToken — API_TOKEN configured', () => {
  const TOKEN = 'socket-secret-99';

  function mockSocket(opts = {}) {
    const { authToken, queryToken } = opts;
    return {
      handshake: {
        auth: authToken !== undefined ? { token: authToken } : {},
        query: queryToken !== undefined ? { token: queryToken } : {},
      },
    };
  }

  it('returns false when socket provides no token', () => {
    const { validateSocketToken } = loadMiddleware({ API_TOKEN: TOKEN });
    assert.equal(validateSocketToken(mockSocket({})), false);
  });

  it('returns false when socket provides wrong token', () => {
    const { validateSocketToken } = loadMiddleware({ API_TOKEN: TOKEN });
    assert.equal(validateSocketToken(mockSocket({ authToken: 'bad' })), false);
  });

  it('returns true when handshake.auth.token matches', () => {
    const { validateSocketToken } = loadMiddleware({ API_TOKEN: TOKEN });
    assert.equal(validateSocketToken(mockSocket({ authToken: TOKEN })), true);
  });

  it('returns true when handshake.query.token matches', () => {
    const { validateSocketToken } = loadMiddleware({ API_TOKEN: TOKEN });
    assert.equal(validateSocketToken(mockSocket({ queryToken: TOKEN })), true);
  });
});

describe('validateSocketToken — API_TOKEN not set', () => {
  it('returns false when API_TOKEN unset and ALLOW_UNAUTHENTICATED_API is not true', () => {
    const { validateSocketToken } = loadMiddleware({});
    const socket = { handshake: { auth: {}, query: {} } };
    assert.equal(validateSocketToken(socket), false);
  });

  it('returns true when API_TOKEN unset and ALLOW_UNAUTHENTICATED_API=true', () => {
    const { validateSocketToken } = loadMiddleware({ ALLOW_UNAUTHENTICATED_API: 'true' });
    const socket = { handshake: { auth: {}, query: {} } };
    assert.equal(validateSocketToken(socket), true);
  });
});
