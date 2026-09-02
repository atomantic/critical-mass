const crypto = require('crypto');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { isLoopbackHost } = require('./gateway-listen');
const { log } = require('./logger');

const COOKIE_NAME = 'critical_mass_operator';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MIN_PASSWORD_LENGTH = 8;
const MIN_BOOTSTRAP_SECRET_LENGTH = 32;
const BOOTSTRAP_HEADER = 'x-operator-bootstrap';
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

const isLoopbackRequest = (req) => {
  if (!isLoopbackHost(req.socket?.remoteAddress)) return false;
  // A loopback proxy may preserve the original client. Forwarding headers can
  // only downgrade trust: every reported hop must also be loopback.
  const forwarded = (req.get('x-forwarded-for') || '')
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean);
  if (forwarded.length > 0) return forwarded.every(isLoopbackHost);

  // A direct browser connection has a loopback Host. A reverse proxy that
  // erases X-Forwarded-For must not become a trusted bootstrap channel merely
  // because its backend connection originates on loopback.
  const host = (req.get('host') || '').trim();
  const hostname = host.startsWith('[')
    ? host.slice(1, host.indexOf(']'))
    : host.split(':')[0];
  return isLoopbackHost(hostname);
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

/**
 * Operator auth starts in a fail-closed bootstrap state. The first password may
 * be enrolled from loopback, or remotely with an out-of-band bootstrap secret.
 * Once enrollment succeeds, that bootstrap secret cannot be reused.
 *
 * @param {Object} [opts]
 * @param {string} [opts.authFile]
 * @param {Function} [opts.readJSON]
 * @param {Function} [opts.writeJSON]
 * @param {string} [opts.bootstrapSecret]
 * @param {string} [opts.bootstrapSecretFile]
 * @param {Function} [opts.onPasswordRemoved]
 * @param {(req: import('express').Request) => boolean} [opts.isTrustedBootstrapRequest]
 */
const createOperatorAuth = ({
  authFile = null,
  readJSON = null,
  writeJSON = null,
  bootstrapSecret = '',
  bootstrapSecretFile = '',
  onPasswordRemoved = null,
  isTrustedBootstrapRequest = isLoopbackRequest,
} = {}) => {
  let record = null;
  if (authFile && readJSON) {
    const saved = readJSON(authFile, null);
    if ((saved?.salt && saved?.hash) || saved?.state === 'bootstrap') record = saved;
  }

  if (bootstrapSecret && Buffer.byteLength(bootstrapSecret) < MIN_BOOTSTRAP_SECRET_LENGTH) {
    throw new Error(`OPERATOR_BOOTSTRAP_SECRET must be at least ${MIN_BOOTSTRAP_SECRET_LENGTH} bytes`);
  }

  const hasPassword = () => Boolean(record?.salt && record?.hash);
  const isBootstrapping = () => !hasPassword();
  const isRequired = () => true;
  const bootstrapSecretHash = bootstrapSecret
    ? crypto.createHash('sha256').update(bootstrapSecret).digest('hex')
    : '';
  const hasRemoteBootstrap = () => Boolean(
    bootstrapSecretHash && bootstrapSecretHash !== record?.bootstrapConsumedHash
  );

  const sessionSecret = () => crypto.createHash('sha256')
    .update(`critical-mass-session:${record?.hash || 'bootstrap'}`)
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
    if (!password || !record?.salt || !record?.hash) return false;
    return timingSafeEqual(hashPassword(password, record.salt), record.hash);
  };

  const bootstrapSecretMatches = (req) => {
    if (!hasRemoteBootstrap()) return false;
    return timingSafeEqual(req.get(BOOTSTRAP_HEADER), bootstrapSecret);
  };

  const canBootstrap = (req) => (
    isTrustedBootstrapRequest(req) || bootstrapSecretMatches(req)
  );

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
    if (!hasPassword()) return null;

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
      const auth = authenticate(req.headers);
      if (auth?.source === 'session') setSessionCookie(req, res);
      res.json({
        authenticated: Boolean(auth),
        required: true,
        bootstrapRequired: isBootstrapping(),
        bootstrapSecretRequired: isBootstrapping() && !isTrustedBootstrapRequest(req),
      });
    });

    app.post('/api/auth/session', (req, res) => {
      if (isBootstrapping()) {
        return res.status(401).json({ error: 'Operator setup is required' });
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
      if (isBootstrapping() && !canBootstrap(req)) {
        return res.status(403).json({ error: 'Initial operator setup requires loopback access or a valid bootstrap secret' });
      }
      if (hasPassword() && !passwordMatches(currentPassword) && !authenticate(req.headers)) {
        return res.status(401).json({ error: 'Current password is required' });
      }
      if (hasPassword() && currentPassword && !passwordMatches(currentPassword)) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }
      persist({
        ...makeRecord(password),
        bootstrapConsumedHash: bootstrapSecretHash || record?.bootstrapConsumedHash || null,
      });
      if (bootstrapSecretFile) {
        try { fs.unlinkSync(bootstrapSecretFile); } catch { /* already consumed in the auth record */ }
      }
      setSessionCookie(req, res);
      log('INFO', '🔐 Operator password set — gateway sign-in is now required');
      res.json({ authenticated: true, required: true, bootstrapRequired: false });
    });

    app.delete('/api/auth/password', (req, res) => {
      if (!hasPassword()) {
        return res.json({ authenticated: false, required: true, bootstrapRequired: true });
      }
      const currentPassword = submittedSecret(req.body);
      if (!passwordMatches(currentPassword)) {
        return res.status(401).json({ error: 'Current password is required to remove it' });
      }
      persist({
        state: 'bootstrap',
        bootstrapConsumedHash: record.bootstrapConsumedHash || null,
        updatedAt: new Date().toISOString(),
      });
      res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'strict', path: '/' });
      log('INFO', '🔐 Operator password cleared — local bootstrap is required');
      res.json({ authenticated: false, required: true, bootstrapRequired: true });
      onPasswordRemoved?.();
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
    hasPassword,
    hasRemoteBootstrap,
    isBootstrapping,
    isRequired,
  };
};

module.exports = {
  COOKIE_NAME,
  BOOTSTRAP_HEADER,
  MIN_BOOTSTRAP_SECRET_LENGTH,
  MIN_PASSWORD_LENGTH,
  SESSION_TTL_SECONDS,
  createOperatorAuth,
  isLoopbackAddress: isLoopbackHost,
  isLoopbackRequest,
  parseCookies,
  readBearerToken,
};
