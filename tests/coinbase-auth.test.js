// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { preparePrivateKey, generateJWT, getAuthHeaders } = require('../src/adapters/coinbase/auth');

// Coinbase CDP request tokens: every REST call signs one, so a malformed token
// means no trading. These pin the claim/header contract Coinbase documents and
// check the ES256 signature under the matching public key.

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const API_KEY = 'organizations/example-org/apiKeys/example-key';

const decode = (token) => {
  const [header, payload, signature] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    verified: crypto.verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')),
  };
};

describe('coinbase generateJWT', () => {
  it('signs the documented CDP claims for the method and query-less path', () => {
    const { header, payload, verified } = decode(generateJWT(API_KEY, privateKey, 'GET', '/api/v3/brokerage/orders/historical/batch?limit=5&cursor=abc'));
    assert.ok(verified, 'ES256 signature must verify under the key pair');
    assert.equal(header.alg, 'ES256');
    assert.equal(header.typ, 'JWT');
    assert.equal(header.kid, API_KEY);
    assert.match(header.nonce, /^[0-9a-f]{32}$/);
    assert.equal(payload.iss, 'cdp');
    assert.equal(payload.sub, API_KEY);
    assert.equal(payload.uri, 'GET api.coinbase.com/api/v3/brokerage/orders/historical/batch');
    assert.equal(payload.exp - payload.nbf, 120);
    assert.ok(payload.iat >= payload.nbf && payload.iat - payload.nbf <= 1, 'iat and nbf are both stamped from the clock');
  });

  it('uses a fresh nonce per token', () => {
    const nonces = new Set([1, 2, 3].map(() => decode(generateJWT(API_KEY, privateKey, 'POST', '/api/v3/brokerage/orders')).header.nonce));
    assert.equal(nonces.size, 3);
  });

  it('accepts a PEM whose line breaks were collapsed in storage', () => {
    const flattened = privateKey.replace(/\n/g, ' ');
    assert.notEqual(flattened, privateKey);
    assert.equal(preparePrivateKey(flattened), preparePrivateKey(privateKey));
    assert.ok(decode(generateJWT(API_KEY, flattened, 'GET', '/api/v3/brokerage/accounts')).verified);
  });

  it('fails loudly on a secret that is not an EC private key instead of sending a bad token', () => {
    assert.throws(() => generateJWT(API_KEY, 'not-a-pem-secret', 'GET', '/api/v3/brokerage/accounts'));
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    assert.throws(() => generateJWT(API_KEY, rsa.privateKey, 'GET', '/api/v3/brokerage/accounts'), /prime256v1/);
  });
});

describe('coinbase getAuthHeaders', () => {
  it('returns a Bearer token the key pair verifies plus the JSON content type', () => {
    const headers = getAuthHeaders(API_KEY, privateKey, 'GET', '/api/v3/brokerage/accounts');
    assert.equal(headers['Content-Type'], 'application/json');
    assert.match(headers.Authorization, /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.ok(decode(headers.Authorization.slice('Bearer '.length)).verified);
  });
});
