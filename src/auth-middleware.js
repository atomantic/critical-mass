// @ts-check
/**
 * Bearer Token Auth Middleware
 *
 * Protects all /api/* routes with a static bearer token loaded from
 * the API_TOKEN environment variable. Uses crypto.timingSafeEqual to
 * prevent timing-based token enumeration attacks.
 *
 * By default the middleware FAILS CLOSED — if API_TOKEN is not set,
 * all /api/* requests are rejected with 401. To explicitly opt out of
 * authentication during local development, set:
 *   ALLOW_UNAUTHENTICATED_API=true
 */

'use strict';

const crypto = require('crypto');
const { log } = require('./logger');

const API_TOKEN = process.env.API_TOKEN || '';
const ALLOW_UNAUTH = process.env.ALLOW_UNAUTHENTICATED_API === 'true';

if (!API_TOKEN && ALLOW_UNAUTH) {
  log('WARN', '[auth] API_TOKEN is not set and ALLOW_UNAUTHENTICATED_API=true — all /api/* routes are UNPROTECTED. Do not use in production.');
} else if (!API_TOKEN) {
  log('ERROR', '[auth] API_TOKEN env var is not set — all /api/* requests will be rejected with 401. Set API_TOKEN to enable authentication, or set ALLOW_UNAUTHENTICATED_API=true to disable auth (development only).');
}

/**
 * Express middleware that enforces bearer token auth on /api/* routes.
 * Fails closed by default: rejects all requests if API_TOKEN is not set,
 * unless ALLOW_UNAUTHENTICATED_API=true is explicitly set.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function apiAuthMiddleware(req, res, next) {
  // No token configured — fail closed unless explicitly opted out.
  if (!API_TOKEN) {
    if (ALLOW_UNAUTH) return next();
    return res.status(401).json({ success: false, error: 'API authentication is not configured. Set the API_TOKEN environment variable.' });
  }

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ success: false, error: 'Missing Authorization header' });
  }

  // Constant-time comparison to prevent timing attacks.
  let valid = false;
  try {
    const expected = Buffer.from(API_TOKEN, 'utf8');
    const received = Buffer.from(token, 'utf8');
    // Buffers must be the same length for timingSafeEqual; derive same-length
    // comparison by hashing both so the lengths are always equal (32 bytes).
    const expectedHash = crypto.createHash('sha256').update(expected).digest();
    const receivedHash = crypto.createHash('sha256').update(received).digest();
    valid = crypto.timingSafeEqual(expectedHash, receivedHash);
  } catch {
    valid = false;
  }

  if (!valid) {
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }

  return next();
}

/**
 * Validate a Socket.IO handshake for the bearer token.
 * Checks `socket.handshake.auth.token` or `socket.handshake.query.token`.
 *
 * Returns true if the connection is authorised (or if API_TOKEN is not set and
 * ALLOW_UNAUTHENTICATED_API=true). Returns false when no token is configured
 * and authentication is not explicitly bypassed.
 *
 * @param {import('socket.io').Socket} socket
 * @returns {boolean}
 */
function validateSocketToken(socket) {
  if (!API_TOKEN) return ALLOW_UNAUTH;

  const token =
    socket.handshake?.auth?.token ||
    socket.handshake?.query?.token ||
    '';

  if (!token) return false;

  try {
    const expectedHash = crypto.createHash('sha256').update(Buffer.from(API_TOKEN, 'utf8')).digest();
    const receivedHash = crypto.createHash('sha256').update(Buffer.from(String(token), 'utf8')).digest();
    return crypto.timingSafeEqual(expectedHash, receivedHash);
  } catch {
    return false;
  }
}

module.exports = { apiAuthMiddleware, validateSocketToken };
