// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { signJwt, verifyHs256Jwt } = require('../src/jwt');

// ---------------------------------------------------------------------------
// Parity suite for the owned JWT module that replaced the jsonwebtoken package.
// The fixture below was minted by jsonwebtoken 9.0.3 from SESSION_CLAIMS +
// SESSION_OPTIONS. It pins header/claim layout byte-for-byte and proves that an
// operator session issued by a release still on the library verifies after the
// swap, so upgrading does not sign anyone out.
// ---------------------------------------------------------------------------

const SECRET = 'parity-test-secret-0123456789abcdef0123456789abcdef';
const IAT = 1700000000;
const TTL = 2592000;
const EXP = IAT + TTL;
const SESSION_CLAIMS = { sub: 'operator', role: 'operator', iat: IAT };
const SESSION_OPTIONS = { algorithm: 'HS256', audience: 'critical-mass', issuer: 'critical-mass', expiresIn: TTL };
const VERIFY_OPTIONS = { audience: 'critical-mass', issuer: 'critical-mass' };
const JSONWEBTOKEN_SESSION = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJvcGVyYXRvciIsInJvbGUiOiJvcGVyYXRvciIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxNzAyNTkyMDAwLCJhdWQiOiJjcml0aWNhbC1tYXNzIiwiaXNzIjoiY3JpdGljYWwtbWFzcyJ9.VTM1Kkp025pB3pJ-M2nahaIVejVdFg7vS_sBGS46_jE';
const SESSION_PAYLOAD = { sub: 'operator', role: 'operator', iat: IAT, exp: EXP, aud: 'critical-mass', iss: 'critical-mass' };

const mintSession = (claims = {}, options = {}) =>
  signJwt({ ...SESSION_CLAIMS, ...claims }, SECRET, { ...SESSION_OPTIONS, ...options });

const decodePart = (token, index) => JSON.parse(Buffer.from(token.split('.')[index], 'base64url').toString('utf8'));

/** Hand-assemble a token so tests can reach header/signature shapes signJwt refuses to produce. */
const craft = (header, payload, signer) => {
  const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${input}.${signer ? signer(input).toString('base64url') : ''}`;
};
const hmac = (algorithm) => (input) => crypto.createHmac(algorithm, SECRET).update(input).digest();

describe('signJwt HS256', () => {
  it('matches the token jsonwebtoken minted for the same claims byte-for-byte', () => {
    assert.equal(mintSession(), JSONWEBTOKEN_SESSION);
  });

  it('stamps iat from the clock and derives exp from expiresIn when the claims omit them', () => {
    const before = Math.floor(Date.now() / 1000);
    const token = signJwt({ sub: 'operator', role: 'operator' }, SECRET, SESSION_OPTIONS);
    const after = Math.floor(Date.now() / 1000);
    const payload = decodePart(token, 1);
    assert.ok(payload.iat >= before && payload.iat <= after, `iat ${payload.iat} outside [${before}, ${after}]`);
    assert.equal(payload.exp, payload.iat + TTL);
    assert.deepEqual(Object.keys(payload), ['sub', 'role', 'iat', 'exp', 'aud', 'iss']);
  });

  it('refuses the shapes jsonwebtoken refused: no key, unknown algorithm, exp collision', () => {
    assert.throws(() => signJwt(SESSION_CLAIMS, '', SESSION_OPTIONS), /key/);
    assert.throws(() => signJwt(SESSION_CLAIMS, SECRET, { ...SESSION_OPTIONS, algorithm: 'none' }), /algorithm/);
    assert.throws(() => signJwt(SESSION_CLAIMS, SECRET, { ...SESSION_OPTIONS, algorithm: 'HS512' }), /algorithm/);
    assert.throws(() => mintSession({ exp: EXP }), /exp/);
    assert.throws(() => mintSession({ iat: 'yesterday' }), /iat/);
  });
});

describe('verifyHs256Jwt', () => {
  it('accepts a session minted by jsonwebtoken before the swap', () => {
    assert.deepEqual(verifyHs256Jwt(JSONWEBTOKEN_SESSION, SECRET, { ...VERIFY_OPTIONS, now: IAT + 60 }), SESSION_PAYLOAD);
  });

  it('is valid through exp - 1 and expired at exp, like jsonwebtoken', () => {
    assert.deepEqual(verifyHs256Jwt(JSONWEBTOKEN_SESSION, SECRET, { ...VERIFY_OPTIONS, now: EXP - 1 }), SESSION_PAYLOAD);
    assert.equal(verifyHs256Jwt(JSONWEBTOKEN_SESSION, SECRET, { ...VERIFY_OPTIONS, now: EXP }), null);
  });

  it('treats nbf inclusively', () => {
    const token = mintSession({ nbf: IAT + 10 });
    assert.ok(verifyHs256Jwt(token, SECRET, { ...VERIFY_OPTIONS, now: IAT + 10 }));
    assert.equal(verifyHs256Jwt(token, SECRET, { ...VERIFY_OPTIONS, now: IAT + 9 }), null);
    assert.equal(verifyHs256Jwt(mintSession({ nbf: 'soon' }), SECRET, { ...VERIFY_OPTIONS, now: IAT + 10 }), null);
  });

  it('requires an exp claim', () => {
    assert.equal(verifyHs256Jwt(mintSession({}, { expiresIn: undefined }), SECRET, { ...VERIFY_OPTIONS, now: IAT }), null);
  });

  it('rejects another secret, audience or issuer', () => {
    const now = IAT + 60;
    assert.equal(verifyHs256Jwt(JSONWEBTOKEN_SESSION, `${SECRET}x`, { ...VERIFY_OPTIONS, now }), null);
    assert.equal(verifyHs256Jwt(JSONWEBTOKEN_SESSION, SECRET, { ...VERIFY_OPTIONS, audience: 'other-app', now }), null);
    assert.equal(verifyHs256Jwt(JSONWEBTOKEN_SESSION, SECRET, { ...VERIFY_OPTIONS, issuer: 'other-app', now }), null);
    assert.ok(verifyHs256Jwt(mintSession({}, { audience: undefined }), SECRET, { issuer: 'critical-mass', now }));
    assert.equal(verifyHs256Jwt(mintSession({}, { audience: undefined }), SECRET, { ...VERIFY_OPTIONS, now }), null);
  });

  it('rejects unsigned, differently-signed and tampered tokens', () => {
    const now = IAT + 60;
    assert.equal(verifyHs256Jwt(craft({ alg: 'none', typ: 'JWT' }, SESSION_PAYLOAD, null), SECRET, { ...VERIFY_OPTIONS, now }), null);
    assert.equal(verifyHs256Jwt(craft({ alg: 'HS512', typ: 'JWT' }, SESSION_PAYLOAD, hmac('sha512')), SECRET, { ...VERIFY_OPTIONS, now }), null);
    assert.deepEqual(verifyHs256Jwt(craft({ alg: 'HS256', typ: 'JWT' }, SESSION_PAYLOAD, hmac('sha256')), SECRET, { ...VERIFY_OPTIONS, now }), SESSION_PAYLOAD);
    const [header, , signature] = JSONWEBTOKEN_SESSION.split('.');
    const forged = Buffer.from(JSON.stringify({ ...SESSION_PAYLOAD, role: 'admin' })).toString('base64url');
    assert.equal(verifyHs256Jwt(`${header}.${forged}.${signature}`, SECRET, { ...VERIFY_OPTIONS, now }), null);
  });

  it('rejects a non-canonical encoding of a correct signature, like jws', () => {
    // The final base64url character carries two padding bits; flipping its low
    // bit decodes to the same 32 signature bytes but is not the canonical text.
    const noncanonical = `${JSONWEBTOKEN_SESSION.slice(0, -1)}F`;
    assert.equal(JSONWEBTOKEN_SESSION.at(-1), 'E');
    assert.deepEqual(Buffer.from(noncanonical.split('.')[2], 'base64url'), Buffer.from(JSONWEBTOKEN_SESSION.split('.')[2], 'base64url'));
    assert.equal(verifyHs256Jwt(noncanonical, SECRET, { ...VERIFY_OPTIONS, now: IAT + 60 }), null);
  });

  it('rejects malformed input without throwing', () => {
    const now = IAT + 60;
    const [header, payload, signature] = JSONWEBTOKEN_SESSION.split('.');
    for (const bad of [
      undefined, null, 42, '', 'a.b', `${JSONWEBTOKEN_SESSION}.extra`, `${header}.${payload}.${signature}+`,
      `${header}.${payload}.`, `${Buffer.from('not json').toString('base64url')}.${payload}.${signature}`,
      craft({ alg: 'HS256', typ: 'JWT' }, [SESSION_PAYLOAD], hmac('sha256')),
      craft({ alg: 'HS256', typ: 'JWT' }, { ...SESSION_PAYLOAD, exp: String(EXP) }, hmac('sha256')),
    ]) {
      assert.equal(verifyHs256Jwt(/** @type {any} */ (bad), SECRET, { ...VERIFY_OPTIONS, now }), null, `accepted ${JSON.stringify(bad)}`);
    }
    assert.equal(verifyHs256Jwt(JSONWEBTOKEN_SESSION, '', { ...VERIFY_OPTIONS, now }), null);
  });
});

describe('signJwt ES256', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const KID = 'organizations/example-org/apiKeys/example-key';
  const NONCE = '0f'.repeat(16);
  const CLAIMS = { iss: 'cdp', nbf: IAT, exp: IAT + 120, sub: KID, uri: 'GET api.coinbase.com/api/v3/brokerage/accounts' };

  it('lays out the Coinbase token like jsonwebtoken and signs it as a 64-byte P-1363 ECDSA signature', () => {
    const before = Math.floor(Date.now() / 1000);
    const token = signJwt(CLAIMS, privateKey, { algorithm: 'ES256', header: { kid: KID, nonce: NONCE } });
    const [header, payload, signature] = token.split('.');
    assert.deepEqual(decodePart(token, 0), { alg: 'ES256', typ: 'JWT', kid: KID, nonce: NONCE });
    assert.deepEqual(Object.keys(decodePart(token, 0)), ['alg', 'typ', 'kid', 'nonce']);
    const { iat, ...claims } = decodePart(token, 1);
    assert.deepEqual(claims, CLAIMS);
    assert.ok(iat >= before && iat <= Math.floor(Date.now() / 1000), 'iat is stamped from the clock, as jsonwebtoken did');
    assert.deepEqual(Object.keys(decodePart(token, 1)), ['iss', 'nbf', 'exp', 'sub', 'uri', 'iat']);
    const raw = Buffer.from(signature, 'base64url');
    assert.equal(raw.length, 64);
    assert.ok(crypto.verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw));
    assert.ok(!crypto.verify('sha256', Buffer.from(`${header}.${payload}x`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw));
  });

  it('stamps iat from the clock when the Coinbase claims omit it', () => {
    const before = Math.floor(Date.now() / 1000);
    const token = signJwt({ iss: 'cdp', sub: KID }, privateKey, { algorithm: 'ES256', header: { kid: KID, nonce: NONCE } });
    assert.ok(decodePart(token, 1).iat >= before);
  });

  it('refuses keys jsonwebtoken refused for ES256: wrong curve, RSA, non-PEM', () => {
    const p384 = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const options = { algorithm: 'ES256', header: { kid: KID, nonce: NONCE } };
    assert.throws(() => signJwt(CLAIMS, p384.privateKey, options), /prime256v1/);
    assert.throws(() => signJwt(CLAIMS, rsa.privateKey, options), /prime256v1/);
    assert.throws(() => signJwt(CLAIMS, 'bm90LWEta2V5', options), /EC private key/);
    assert.throws(() => signJwt(CLAIMS, publicKey, options), /EC private key/);
  });
});
