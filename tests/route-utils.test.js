// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { getIPC } = require('../src/routes/route-utils');

describe('getIPC', () => {
  it('returns only the exact exchange client', () => {
    const coinbase = { request: () => Promise.resolve() };
    const gemini = { request: () => Promise.resolve() };
    assert.equal(getIPC({ coinbase, gemini }, 'gemini'), gemini);
  });

  it('fails closed instead of falling back to Coinbase', () => {
    const coinbase = { request: () => Promise.resolve() };
    assert.throws(() => getIPC({ coinbase }, 'gemini'), /No IPC client for exchange: gemini/);
  });

  it('rejects inherited and malformed clients', () => {
    const inherited = Object.create({ coinbase: { request: () => Promise.resolve() } });
    assert.throws(() => getIPC(inherited, 'coinbase'), /No IPC client/);
    assert.throws(() => getIPC({ gemini: {} }, 'gemini'), /No IPC client/);
  });
});
