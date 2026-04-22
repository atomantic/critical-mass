// @ts-check
/**
 * Bearer Token Auth Middleware
 *
 * Protects all /api/* routes with a static bearer token loaded from
 * the API_TOKEN environment variable. Uses crypto.timingSafeEqual to
 * prevent timing-based token enumeration attacks.
 *
 * If API_TOKEN is not set, a warning is printed but requests are allowed
 * through for backward-compatibility during transition.
 */

'use strict';

const crypto = require('crypto');
const { log } = require('./logger');

const API_TOKEN = process.env.API_TOKEN || '';

if (!API_TOKEN) {
  log('WARN', '[auth] API_TOKEN env var is not set — all /api/* routes are UNPROTECTED. Set API_TOKEN to enable authentication.');
}

/**
 * Express middleware that enforces bearer token auth on /api/* routes.
 * Skips authentication when API_TOKEN is not configured (backward compat).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function apiAuthMiddleware(req, res, next) {
  // No token configured — warn once at startup (above) and allow through.
  if (!API_TOKEN) return next();

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
 * Returns true if the connection is authorised (or if API_TOKEN is not set).
 *
 * @param {import('socket.io').Socket} socket
 * @returns {boolean}
 */
function validateSocketToken(socket) {
  if (!API_TOKEN) return true;

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
