const crypto = require('crypto');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { log } = require('./logger');

const COOKIE_NAME = 'critical_mass_operator';
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const MIN_PASSWORD_LENGTH = 8;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const parseCookies = (header = '') => Object.fromEntries(
  header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const separator = part.indexOf('=');
    return separator === -1
      ? [part, '']
      : [part.slice(0, separator), part.slice(separator + 1)];
  })
);

const readBearerToken = (header = '') => {
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] || null;
};

const timingSafeEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const requestOriginMatches = (req) => {
  const origin = req.get('origin');
  if (!origin) return true;
  const expectedHost = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  return URL.canParse(origin) && new URL(origin).host === expectedHost;
};

const submittedSecret = (body = {}) => {
  const value = body.password ?? body.token;
  return typeof value === 'string' ? value : '';
};

const hashPassword = (password, saltHex) => crypto
  .scryptSync(password, Buffer.from(saltHex, 'hex'), 32)
  .toString('hex');

const makeRecord = (password) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    kdf: 'scrypt',
    salt,
    hash: hashPassword(password, salt),
    updatedAt: new Date().toISOString(),
  };
};

const normalizeEnvToken = (raw) => {
  const token = typeof raw === 'string' ? raw.trim() : '';
  return token.length >= MIN_PASSWORD_LENGTH ? token : '';
};

/**
 * Operator auth is off until a password is set in the admin panel (or an
 * optional OPERATOR_TOKEN env secret is present). Missing env does not crash.
 *
 * @param {Object} [opts]
 * @param {string} [opts.operatorToken]
 * @param {string} [opts.authFile]
 * @param {Function} [opts.readJSON]
 * @param {Function} [opts.writeJSON]
 */
const createOperatorAuth = ({
  operatorToken = process.env.OPERATOR_TOKEN,
  authFile = null,
  readJSON = null,
  writeJSON = null,
} = {}) => {
  const envToken = normalizeEnvToken(operatorToken);
  let record = null;
  if (authFile && readJSON) {
    const saved = readJSON(authFile, null);
    if (saved?.salt && saved?.hash) record = saved;
  }

  const isRequired = () => Boolean(record || envToken);

  const sessionSecret = () => crypto.createHash('sha256')
    .update(`critical-mass-session:${record?.hash || envToken || 'open'}`)
    .digest('hex');

  const createSession = () => jwt.sign(
    { sub: 'operator', role: 'operator' },
    sessionSecret(),
    { algorithm: 'HS256', audience: 'critical-mass', issuer: 'critical-mass', expiresIn: SESSION_TTL_SECONDS }
  );

  const verifySession = (token) => {
    if (!token) return false;
    try {
      return Boolean(jwt.verify(token, sessionSecret(), {
        algorithms: ['HS256'],
        audience: 'critical-mass',
        issuer: 'critical-mass',
      }));
    } catch {
      return false;
    }
  };

  const passwordMatches = (password) => {
    if (!password) return false;
    if (envToken && timingSafeEqual(password, envToken)) return true;
    if (record?.salt && record?.hash) {
      return timingSafeEqual(hashPassword(password, record.salt), record.hash);
    }
    return false;
  };

  const persist = (next) => {
    record = next;
    if (!authFile || !writeJSON) return;
    if (!next) {
      try { fs.unlinkSync(authFile); } catch { /* missing is the cleared state */ }
      return;
    }
    writeJSON(authFile, next);
  };

  const authenticate = (headers = {}) => {
    if (!isRequired()) return { source: 'open' };

    const bearer = readBearerToken(headers.authorization);
    if (bearer && passwordMatches(bearer)) return { source: 'bearer' };

    const session = parseCookies(headers.cookie)[COOKIE_NAME];
    if (!session) return null;
    return verifySession(session) ? { source: 'session' } : null;
  };

  const requireAuth = (req, res, next) => {
    const auth = authenticate(req.headers);
    if (!auth) return res.status(401).json({ error: 'Operator authentication required' });
    if (auth.source === 'session' && MUTATING_METHODS.has(req.method) && !requestOriginMatches(req)) {
      return res.status(403).json({ error: 'Request origin is not authorized' });
    }
    req.operator = { role: 'operator', authSource: auth.source };
    next();
  };

  const socketMiddleware = (socket, next) => {
    if (!isRequired()) return next();
    const headers = { ...socket.handshake.headers };
    if (socket.handshake.auth?.token) headers.authorization = `Bearer ${socket.handshake.auth.token}`;
    if (authenticate(headers)) return next();
    const error = new Error('Operator authentication required');
    error.data = { code: 'UNAUTHORIZED' };
    next(error);
  };

  const setSessionCookie = (req, res) => {
    const forwardedProto = (req.get('x-forwarded-proto') || '').split(',')[0].trim();
    const secure = req.secure || forwardedProto === 'https';
    res.cookie(COOKIE_NAME, createSession(), {
      httpOnly: true,
      sameSite: 'strict',
      secure,
      maxAge: SESSION_TTL_SECONDS * 1000,
      path: '/',
    });
  };

  const registerSessionRoutes = (app) => {
    app.get('/api/auth/session', (req, res) => {
      const required = isRequired();
      const auth = authenticate(req.headers);
      res.json({
        authenticated: required ? Boolean(auth && auth.source !== 'open') : true,
        required,
      });
    });

    app.post('/api/auth/session', (req, res) => {
      if (!isRequired()) {
        return res.json({ authenticated: true, required: false });
      }
      if (!passwordMatches(submittedSecret(req.body))) {
        return res.status(401).json({ error: 'Invalid operator password' });
      }
      setSessionCookie(req, res);
      res.json({ authenticated: true, required: true });
    });

    app.put('/api/auth/password', (req, res) => {
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
      if (Buffer.byteLength(password) < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      }
      if (isRequired() && !passwordMatches(currentPassword) && !authenticate(req.headers)) {
        return res.status(401).json({ error: 'Current password is required' });
      }
      if (isRequired() && currentPassword && !passwordMatches(currentPassword)) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }
      persist(makeRecord(password));
      setSessionCookie(req, res);
      log('INFO', '🔐 Operator password set — gateway sign-in is now required');
      res.json({ authenticated: true, required: true });
    });

    app.delete('/api/auth/password', (req, res) => {
      if (!record && !envToken) {
        return res.json({ authenticated: true, required: false });
      }
      const currentPassword = submittedSecret(req.body);
      if (!passwordMatches(currentPassword)) {
        return res.status(401).json({ error: 'Current password is required to remove it' });
      }
      persist(null);
      res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'strict', path: '/' });
      const stillRequired = isRequired();
      log('INFO', stillRequired
        ? '🔐 Operator panel password cleared — OPERATOR_TOKEN env still requires sign-in'
        : '🔐 Operator password cleared — gateway sign-in is off');
      res.json({ authenticated: true, required: stillRequired });
    });

    app.delete('/api/auth/session', (req, res) => {
      res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'strict', path: '/' });
      res.status(204).send();
    });
  };

  return {
    authenticate,
    registerSessionRoutes,
    requireAuth,
    socketMiddleware,
    isRequired,
  };
};

module.exports = {
  COOKIE_NAME,
  MIN_PASSWORD_LENGTH,
  createOperatorAuth,
  parseCookies,
  readBearerToken,
};
