const crypto = require('crypto');
const fs = require('fs');
const { signJwt, verifyHs256Jwt } = require('./jwt');
const { isLoopbackHost } = require('./gateway-listen');
const { log } = require('./logger');

const COOKIE_NAME = 'critical_mass_operator';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_BYTES = 256;
const ATTEMPT_WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;
const MAX_TRACKED_PEERS = 1024;
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

const requestOriginMatches = (req) => {
  const origin = (typeof req?.get === 'function' ? req.get('origin') : req?.headers?.origin) || '';
  if (!origin) return true;
  const hostHeader = (typeof req?.get === 'function'
    ? (req.get('x-forwarded-host') || req.get('host'))
    : (req?.headers?.['x-forwarded-host'] || req?.headers?.host)) || '';
  const expectedHost = hostHeader.split(',')[0].trim();
  return URL.canParse(origin) && new URL(origin).host === expectedHost;
};

const isLoopbackRequest = (req) => {
  if (!requestOriginMatches(req)) return false;
  if (!isLoopbackHost(req?.socket?.remoteAddress)) return false;
  const getHeader = (name) => (typeof req?.get === 'function' ? req.get(name) : req?.headers?.[name]) || '';
  const isLoopbackHostHeader = (hostHeader) => {
    const host = hostHeader.trim();
    const hostname = host.startsWith('[')
      ? host.slice(1, host.indexOf(']'))
      : host.split(':')[0];
    return isLoopbackHost(hostname);
  };
  const host = getHeader('host');
  const forwardedHost = getHeader('x-forwarded-host');
  if (!host || !host.split(',').every(isLoopbackHostHeader)) return false;
  if (forwardedHost && !forwardedHost.split(',').every(isLoopbackHostHeader)) return false;

  // A loopback proxy may preserve the original client. Forwarding headers can
  // only downgrade trust: every reported hop must also be loopback.
  const forwardedHeader = getHeader('x-forwarded-for');
  const forwarded = forwardedHeader
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean);
  if (forwarded.length > 0) return forwarded.every(isLoopbackHost);
  // A reverse proxy that erases X-Forwarded-For must not become a trusted
  // bootstrap channel merely because its backend connection is loopback.
  return true;
};

const submittedSecret = (body = {}) => {
  const value = body.password ?? body.token;
  return typeof value === 'string' ? value : '';
};

// A single active KDF and no waiting queue bound CPU/memory across all peers.
let hashBusy = false;
const authError = (status, message, headers) => Object.assign(new Error(message), { status, headers });
const checkPasswordSize = (password) => {
  if (Buffer.byteLength(password) > MAX_PASSWORD_BYTES) {
    throw authError(400, `Password must be at most ${MAX_PASSWORD_BYTES} bytes`);
  }
};
const hashPassword = async (password, saltHex) => {
  checkPasswordSize(password);
  // Thrown with no try/catch in every caller (including requireAuth on the
  // unauthenticated pre-auth path) — the JSON error middleware in server.js
  // is what turns this into a response. Retry-After matches the sibling
  // limitAttempts 429 so both rate-limit paths behave consistently (#530).
  if (hashBusy) throw authError(429, 'Password verification is busy; retry later', { 'Retry-After': '1' });
  hashBusy = true;
  try {
    return await new Promise((resolve, reject) => {
      crypto.scrypt(password, Buffer.from(saltHex, 'hex'), 32, (error, key) => {
        if (error) return reject(error);
        resolve(key.toString('hex'));
      });
    });
  } finally {
    hashBusy = false;
  }
};

const makeRecord = async (password) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    kdf: 'scrypt',
    salt,
    hash: await hashPassword(password, salt),
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
 * @param {Function} [opts.onPasswordChanged] Called after successful credential persistence
 * @param {Function} [opts.onPasswordRemoved]
 * @param {() => number} [opts.now] Clock for the peer attempt window
 * @param {(req: import('express').Request) => boolean} [opts.isTrustedBootstrapRequest]
 */
const authFileUnreadableError = () => ({
  error: 'Operator auth file is unreadable; move data/operator-auth.json aside and restart the gateway to re-enroll',
});

/**
 * @param {string} file
 * @returns {string|null} Why the file is unreadable, or null when it is
 *   missing, empty or a parseable JSON object
 */
const unreadableAuthFileReason = (file) => {
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return err.code === 'ENOENT' ? null : err.message;
  }
  if (!content.trim()) return null;
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? null : 'not a JSON object';
  } catch (err) {
    return err.message;
  }
};

const createOperatorAuth = ({
  authFile = null,
  readJSON = null,
  writeJSON = null,
  bootstrapSecret = '',
  bootstrapSecretFile = '',
  onPasswordChanged = null,
  onPasswordRemoved = null,
  isTrustedBootstrapRequest = isLoopbackRequest,
  now = Date.now,
} = {}) => {
  const attempts = new Map();
  const reserveAttempt = (peer = 'unknown') => {
    const time = now();
    for (const [tracked, entry] of attempts) {
      if (time >= entry.expires) attempts.delete(tracked);
    }
    // Forwarded headers never create a fresh budget. Unknown peers share one.
    let entry = attempts.get(peer);
    if (!entry && attempts.size < MAX_TRACKED_PEERS) {
      entry = { count: 0, expires: time + ATTEMPT_WINDOW_MS };
      attempts.set(peer, entry);
    }
    if (!entry || entry.count >= MAX_ATTEMPTS) {
      const retryAfter = String(Math.max(1, Math.ceil(((entry?.expires || time + ATTEMPT_WINDOW_MS) - time) / 1000)));
      throw authError(429, 'Too many authentication attempts; retry later', { 'Retry-After': retryAfter });
    }
    entry.count += 1;
    return entry;
  };
  const limitAttempts = (req, res, next) => {
    try {
      reserveAttempt(req.socket?.remoteAddress);
      req.operatorAttemptReserved = true;
      next();
    } catch (error) {
      res.set('Retry-After', error.headers['Retry-After']);
      res.status(error.status).json({ error: error.message });
    }
  };
  const validatePasswords = (req, res, next) => {
    for (const value of [submittedSecret(req.body), req.body?.currentPassword, readBearerToken(req.headers.authorization)]) {
      if (typeof value === 'string') checkPasswordSize(value);
    }
    next();
  };
  let record = null;
  // A present-but-unreadable auth file must NOT look like "no password set":
  // that would reopen bootstrap enrollment. Fail closed until the operator
  // moves the file aside.
  let authFileUnreadable = false;
  if (authFile && readJSON) {
    const reason = unreadableAuthFileReason(authFile);
    if (reason) {
      authFileUnreadable = true;
      log('ERROR', `🔐 ${authFile} is present but unreadable (${reason}). Operator sign-in and enrollment are refused. Move that file aside (do not delete it if it holds a password you need) and restart to re-enroll.`);
    } else {
      const saved = readJSON(authFile, null);
      if ((saved?.salt && saved?.hash) || saved?.state === 'bootstrap') record = saved;
    }
  }

  if (bootstrapSecret && Buffer.byteLength(bootstrapSecret) < MIN_BOOTSTRAP_SECRET_LENGTH) {
    throw new Error(`OPERATOR_BOOTSTRAP_SECRET must be at least ${MIN_BOOTSTRAP_SECRET_LENGTH} bytes`);
  }

  const hasPassword = () => Boolean(record?.salt && record?.hash);
  const isBootstrapping = () => !hasPassword() && !authFileUnreadable;
  const isRequired = () => true;
  const bootstrapSecretHash = bootstrapSecret
    ? crypto.createHash('sha256').update(bootstrapSecret).digest('hex')
    : '';
  const hasRemoteBootstrap = () => Boolean(
    !authFileUnreadable && bootstrapSecretHash && bootstrapSecretHash !== record?.bootstrapConsumedHash
  );

  const sessionSecret = () => crypto.createHash('sha256')
    .update(`critical-mass-session:${record?.hash || 'bootstrap'}`)
    .digest('hex');

  const createSession = () => signJwt(
    { sub: 'operator', role: 'operator' },
    sessionSecret(),
    { algorithm: 'HS256', audience: 'critical-mass', issuer: 'critical-mass', expiresIn: SESSION_TTL_SECONDS }
  );

  const verifySession = (token) => Boolean(
    verifyHs256Jwt(token, sessionSecret(), { audience: 'critical-mass', issuer: 'critical-mass' })
  );

  const passwordMatches = async (password) => {
    if (!password || !record?.salt || !record?.hash) return false;
    const expected = record;
    const hash = await hashPassword(password, expected.salt);
    return record === expected && timingSafeEqual(hash, expected.hash);
  };

  const bootstrapSecretMatches = (req) => {
    if (!hasRemoteBootstrap()) return false;
    return timingSafeEqual(req.get(BOOTSTRAP_HEADER), bootstrapSecret);
  };

  const canBootstrap = (req) => (
    (isTrustedBootstrapRequest(req) && requestOriginMatches(req)) || bootstrapSecretMatches(req)
  );

  const persist = (next) => {
    if (!authFile || !writeJSON) {
      record = next;
      return;
    }
    if (!next) {
      try { fs.unlinkSync(authFile); } catch { /* missing is the cleared state */ }
      record = next;
      return;
    }
    writeJSON(authFile, next);
    record = next;
  };

  const authenticate = async (headers = {}, peer, attemptReserved = false) => {
    if (!hasPassword()) return null;

    const bearer = readBearerToken(headers.authorization);
    if (bearer) {
      // Reserve before the KDF so every credential entry point shares the same
      // peer budget. Successful automation does not accumulate failed guesses.
      const attempt = attemptReserved ? null : reserveAttempt(peer);
      if (await passwordMatches(bearer)) {
        if (attempt) attempt.count -= 1;
        return { source: 'bearer' };
      }
    }

    const session = parseCookies(headers.cookie)[COOKIE_NAME];
    if (!session) return null;
    return verifySession(session) ? { source: 'session' } : null;
  };

  const requireAuth = async (req, res, next) => {
    const auth = await authenticate(req.headers, req.socket?.remoteAddress, req.operatorAttemptReserved);
    if (!auth) return res.status(401).json({ error: 'Operator authentication required' });
    if (auth.source === 'session' && MUTATING_METHODS.has(req.method) && !requestOriginMatches(req)) {
      return res.status(403).json({ error: 'Request origin is not authorized' });
    }
    req.operator = { role: 'operator', authSource: auth.source };
    next();
  };

  // Realtime bus upgrade check (src/realtime-bus.js): the same session cookie
  // or bearer password as requireAuth. A browser always sends Origin on a
  // WebSocket handshake, and it must name this gateway — the same rule as a
  // session-cookie mutation, so another page cannot ride the operator's cookie.
  const authorizeUpgrade = async (req) => {
    if (!requestOriginMatches(req)) return false;
    return Boolean(await authenticate(req.headers, req.socket?.remoteAddress));
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
    app.get('/api/auth/session', async (req, res) => {
      const auth = await authenticate(req.headers, req.socket?.remoteAddress, req.operatorAttemptReserved);
      if (auth?.source === 'session') setSessionCookie(req, res);
      res.json({
        authenticated: Boolean(auth),
        required: true,
        bootstrapRequired: isBootstrapping(),
        bootstrapSecretRequired: isBootstrapping() && !isTrustedBootstrapRequest(req),
        ...(authFileUnreadable && { authFileUnreadable: true }),
      });
    });

    app.post('/api/auth/session', validatePasswords, limitAttempts, async (req, res) => {
      if (authFileUnreadable) return res.status(503).json(authFileUnreadableError());
      if (isBootstrapping()) {
        return res.status(401).json({ error: 'Operator setup is required' });
      }
      if (!await passwordMatches(submittedSecret(req.body))) {
        return res.status(401).json({ error: 'Invalid operator password' });
      }
      setSessionCookie(req, res);
      res.json({ authenticated: true, required: true });
    });

    app.put('/api/auth/password', validatePasswords, limitAttempts, async (req, res) => {
      if (authFileUnreadable) return res.status(503).json(authFileUnreadableError());
      const previousRecord = record;
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
      if (Buffer.byteLength(password) < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      }
      if (isBootstrapping() && !canBootstrap(req)) {
        return res.status(403).json({ error: 'Initial operator setup requires loopback access or a valid bootstrap secret' });
      }
      const auth = await authenticate(req.headers, req.socket?.remoteAddress, req.operatorAttemptReserved);
      if (auth?.source === 'session' && !requestOriginMatches(req)) {
        return res.status(403).json({ error: 'Request origin is not authorized' });
      }
      // A bearer token already proves knowledge of the current password (it IS the
      // password); a session cookie does not, so it must not exempt the caller from
      // the currentPassword check below.
      if (hasPassword() && auth?.source !== 'bearer') {
        if (!currentPassword) {
          return res.status(401).json({ error: 'Current password is required' });
        }
        if (!await passwordMatches(currentPassword)) {
          return res.status(401).json({ error: 'Current password is incorrect' });
        }
      }
      const nextRecord = await makeRecord(password);
      if (record !== previousRecord) throw authError(409, 'Operator password changed; retry with current credentials');
      persist({
        ...nextRecord,
        bootstrapConsumedHash: bootstrapSecretHash || record?.bootstrapConsumedHash || null,
      });
      onPasswordChanged?.();
      if (bootstrapSecretFile) {
        try { fs.unlinkSync(bootstrapSecretFile); } catch { /* already consumed in the auth record */ }
      }
      setSessionCookie(req, res);
      log('INFO', '🔐 Operator password set — gateway sign-in is now required');
      res.json({ authenticated: true, required: true, bootstrapRequired: false });
    });

    app.delete('/api/auth/password', validatePasswords, limitAttempts, async (req, res) => {
      if (authFileUnreadable) return res.status(503).json(authFileUnreadableError());
      if (!hasPassword()) {
        return res.json({ authenticated: false, required: true, bootstrapRequired: true });
      }
      if ((await authenticate(req.headers, req.socket?.remoteAddress, req.operatorAttemptReserved))?.source === 'session' && !requestOriginMatches(req)) {
        return res.status(403).json({ error: 'Request origin is not authorized' });
      }
      const currentPassword = submittedSecret(req.body);
      if (!await passwordMatches(currentPassword)) {
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

    app.delete('/api/auth/session', async (req, res) => {
      if ((await authenticate(req.headers, req.socket?.remoteAddress, req.operatorAttemptReserved))?.source === 'session' && !requestOriginMatches(req)) {
        return res.status(403).json({ error: 'Request origin is not authorized' });
      }
      res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'strict', path: '/' });
      res.status(204).send();
    });
  };

  return {
    authenticate,
    registerSessionRoutes,
    requireAuth,
    authorizeUpgrade,
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
  MAX_PASSWORD_BYTES,
  SESSION_TTL_SECONDS,
  createOperatorAuth,
  isLoopbackAddress: isLoopbackHost,
  isLoopbackRequest,
  parseCookies,
  readBearerToken,
};
