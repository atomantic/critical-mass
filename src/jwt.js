// @ts-check
/**
 * Owned JWS compact serialization (RFC 7515/7519) for the two token shapes this
 * codebase issues, replacing the jsonwebtoken package:
 *   - ES256 Coinbase CDP request/websocket tokens (sign only)
 *   - HS256 operator session tokens (sign + verify)
 *
 * Algorithms are fixed per call site and verification accepts exactly one, so
 * there is no alg-switching or unsigned ("none") surface. Header and claim
 * layout match jsonwebtoken 9.x byte-for-byte for these shapes (tests/jwt.test.js
 * pins a token that library minted), so operator sessions issued before the swap
 * keep verifying after it. Cryptography stays in node:crypto.
 */
const crypto = require('crypto');

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const P256_CURVE = 'prime256v1';

const nowSeconds = () => Math.floor(Date.now() / 1000);
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const isClaimsObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const SIGNERS = {
  HS256: (input, secret) => crypto.createHmac('sha256', secret).update(input).digest(),
  // ieee-p1363 yields the fixed-width r||s (64 bytes for P-256) that JWS requires.
  ES256: (input, key) => crypto.sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }),
};

const toEs256Key = (pem) => {
  let key;
  try {
    key = crypto.createPrivateKey(pem);
  } catch (err) {
    throw new Error(`ES256 requires a PEM EC private key: ${err.message}`);
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== P256_CURVE) {
    throw new Error(`ES256 requires a ${P256_CURVE} (P-256) EC private key`);
  }
  return key;
};

/**
 * Sign claims as a JWT.
 * `iat` is stamped from the clock unless the claims carry one; `expiresIn`
 * (seconds) sets `exp` relative to `iat`; `audience`/`issuer` become `aud`/`iss`.
 * Extra `header` fields (kid, nonce) follow alg/typ.
 * @param {Record<string, unknown>} claims
 * @param {string | Buffer | import('crypto').KeyObject} key - HS256 secret or ES256 PEM private key
 * @param {{ algorithm: 'HS256' | 'ES256', header?: Record<string, unknown>, expiresIn?: number, audience?: string, issuer?: string }} options
 * @returns {string} compact JWS
 */
const signJwt = (claims, key, { algorithm, header = {}, expiresIn, audience, issuer } = {}) => {
  const sign = SIGNERS[algorithm];
  if (!sign) throw new Error(`Unsupported JWT algorithm: ${algorithm}`);
  if (!key) throw new Error('JWT signing key is required');
  if (!isClaimsObject(claims)) throw new Error('JWT claims must be an object');
  if (claims.iat !== undefined && typeof claims.iat !== 'number') throw new Error('iat must be a number of seconds');

  const payload = { ...claims };
  const iat = typeof payload.iat === 'number' ? payload.iat : nowSeconds();
  payload.iat = iat;
  if (expiresIn !== undefined) {
    if (payload.exp !== undefined) throw new Error('expiresIn conflicts with an exp claim');
    if (!Number.isInteger(expiresIn)) throw new Error('expiresIn must be an integer number of seconds');
    payload.exp = iat + expiresIn;
  }
  if (audience !== undefined) payload.aud = audience;
  if (issuer !== undefined) payload.iss = issuer;

  // The undefined kid slot keeps jsonwebtoken's header key order (alg, typ, kid, ...).
  const input = `${encode({ alg: algorithm, typ: 'JWT', kid: undefined, ...header })}.${encode(payload)}`;
  const signingKey = algorithm === 'ES256' ? toEs256Key(key) : key;
  return `${input}.${sign(input, signingKey).toString('base64url')}`;
};

const decodeClaims = (part) => {
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return isClaimsObject(value) ? value : null;
  } catch {
    return null;
  }
};

/**
 * Verify an HS256 token and return its claims, or null when it is malformed,
 * unsigned, signed with another algorithm or secret, expired, not yet valid, or
 * issued for another audience/issuer. Boundaries follow jsonwebtoken: valid
 * while nbf <= now < exp. `exp` is mandatory because every token this codebase
 * issues carries one; an unexpiring session is never legitimate here.
 * @param {unknown} token
 * @param {string | Buffer | import('crypto').KeyObject} secret
 * @param {{ audience?: string, issuer?: string, now?: number }} [options] - `now` in seconds, for tests
 * @returns {Record<string, any> | null}
 */
const verifyHs256Jwt = (token, secret, { audience, issuer, now = nowSeconds() } = {}) => {
  if (typeof token !== 'string' || !secret || typeof now !== 'number') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((part) => BASE64URL.test(part))) return null;
  const [encodedHeader, encodedPayload, signature] = parts;

  const header = decodeClaims(encodedHeader);
  if (!header || header.alg !== 'HS256') return null;

  // Compare canonical base64url text, as jws does, so only the exact signature
  // encoding is accepted; equal-length check keeps timingSafeEqual from throwing.
  const expected = SIGNERS.HS256(`${encodedHeader}.${encodedPayload}`, secret).toString('base64url');
  if (expected.length !== signature.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;

  const payload = decodeClaims(encodedPayload);
  if (!payload) return null;
  if (payload.nbf !== undefined && !(typeof payload.nbf === 'number' && payload.nbf <= now)) return null;
  if (!(typeof payload.exp === 'number' && now < payload.exp)) return null;
  if (audience !== undefined && !(Array.isArray(payload.aud) ? payload.aud : [payload.aud]).includes(audience)) return null;
  if (issuer !== undefined && payload.iss !== issuer) return null;
  return payload;
};

module.exports = { signJwt, verifyHs256Jwt };
