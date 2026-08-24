const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'critical_mass_operator';
const SESSION_TTL_SECONDS = 12 * 60 * 60;
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

const createOperatorAuth = ({ operatorToken = process.env.OPERATOR_TOKEN } = {}) => {
  if (!operatorToken || Buffer.byteLength(operatorToken) < 32) {
    throw new Error('OPERATOR_TOKEN must be set to a secret of at least 32 characters');
  }

  const sessionSecret = crypto.createHash('sha256')
    .update(`critical-mass-session:${operatorToken}`)
    .digest('hex');

  const createSession = () => jwt.sign(
    { sub: 'operator', role: 'operator' },
    sessionSecret,
    { algorithm: 'HS256', audience: 'critical-mass', issuer: 'critical-mass', expiresIn: SESSION_TTL_SECONDS }
  );

  const verifySession = (token) => {
    if (!token) return false;
    try {
      return Boolean(jwt.verify(token, sessionSecret, {
        algorithms: ['HS256'],
        audience: 'critical-mass',
        issuer: 'critical-mass',
      }));
    } catch {
      return false;
    }
  };

  const authenticate = (headers = {}) => {
    const bearer = readBearerToken(headers.authorization);
    if (bearer && timingSafeEqual(bearer, operatorToken)) return { source: 'bearer' };

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

  const registerSessionRoutes = (app) => {
    app.get('/api/auth/session', (req, res) => {
      res.json({ authenticated: Boolean(authenticate(req.headers)) });
    });

    app.post('/api/auth/session', (req, res) => {
      if (!timingSafeEqual(req.body?.token, operatorToken)) {
        return res.status(401).json({ error: 'Invalid operator token' });
      }
      const forwardedProto = (req.get('x-forwarded-proto') || '').split(',')[0].trim();
      const secure = req.secure || forwardedProto === 'https';
      res.cookie(COOKIE_NAME, createSession(), {
        httpOnly: true,
        sameSite: 'strict',
        secure,
        maxAge: SESSION_TTL_SECONDS * 1000,
        path: '/',
      });
      res.json({ authenticated: true });
    });

    app.delete('/api/auth/session', requireAuth, (req, res) => {
      res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'strict', path: '/' });
      res.status(204).send();
    });
  };

  return { authenticate, registerSessionRoutes, requireAuth, socketMiddleware };
};

module.exports = { COOKIE_NAME, createOperatorAuth, parseCookies, readBearerToken };
