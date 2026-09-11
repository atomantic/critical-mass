// @ts-check
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createCoinbaseAdapter } = require('../src/adapters/coinbase/api');
const { createGeminiAdapter } = require('../src/adapters/gemini/api');
const { createCryptocomAdapter } = require('../src/adapters/cryptocom/api');

describe('adapter keys file parsing guards', () => {
  let tempDir;
  let coinbaseKeysPath;
  let geminiKeysPath;
  let cryptocomKeysPath;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `adapter-keys-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tempDir, { recursive: true });
    coinbaseKeysPath = path.join(tempDir, 'coinbase-keys.json');
    geminiKeysPath = path.join(tempDir, 'gemini-keys.json');
    cryptocomKeysPath = path.join(tempDir, 'cryptocom-keys.json');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Coinbase adapter', () => {
    it('hasValidKeys() returns false on empty file', () => {
      fs.writeFileSync(coinbaseKeysPath, '');
      const adapter = createCoinbaseAdapter(coinbaseKeysPath);
      assert.equal(adapter.hasValidKeys(), false, 'should return false for empty file');
    });

    it('hasValidKeys() returns false on truncated/incomplete JSON', () => {
      fs.writeFileSync(coinbaseKeysPath, '{"apiKey": "test-');
      const adapter = createCoinbaseAdapter(coinbaseKeysPath);
      assert.equal(adapter.hasValidKeys(), false, 'should return false for truncated JSON');
    });

    it('hasValidKeys() returns false on invalid JSON', () => {
      fs.writeFileSync(coinbaseKeysPath, '{invalid json}');
      const adapter = createCoinbaseAdapter(coinbaseKeysPath);
      assert.equal(adapter.hasValidKeys(), false, 'should return false for invalid JSON');
    });

    it('loadCredentials() throws descriptive error on corrupt file', () => {
      fs.writeFileSync(coinbaseKeysPath, '{invalid}');
      const adapter = createCoinbaseAdapter(coinbaseKeysPath);
      assert.throws(
        () => adapter.loadCredentials(),
        /Failed to parse API keys file: corrupted or invalid JSON/,
        'should throw descriptive error'
      );
    });

    it('loadCredentials() throws descriptive error on empty file', () => {
      fs.writeFileSync(coinbaseKeysPath, '');
      const adapter = createCoinbaseAdapter(coinbaseKeysPath);
      assert.throws(
        () => adapter.loadCredentials(),
        /Failed to parse API keys file: corrupted or invalid JSON/,
        'should throw descriptive error'
      );
    });

    it('hasValidKeys() returns true on valid file', () => {
      fs.writeFileSync(coinbaseKeysPath, JSON.stringify({
        name: 'test-api-key-12345',
        privateKey: '-----BEGIN EC PRIVATE KEY-----\nMIGHMA0GCSqGSIb3DQEBAQUAA4GGAAD...',
      }));
      const adapter = createCoinbaseAdapter(coinbaseKeysPath);
      assert.equal(adapter.hasValidKeys(), true, 'should return true for valid file');
    });
  });

  describe('Gemini adapter', () => {
    it('hasValidKeys() returns false on empty file', () => {
      fs.writeFileSync(geminiKeysPath, '');
      const adapter = createGeminiAdapter(geminiKeysPath);
      assert.equal(adapter.hasValidKeys(), false, 'should return false for empty file');
    });

    it('hasValidKeys() returns false on truncated/incomplete JSON', () => {
      fs.writeFileSync(geminiKeysPath, '{"apiKey": "test-');
      const adapter = createGeminiAdapter(geminiKeysPath);
      assert.equal(adapter.hasValidKeys(), false, 'should return false for truncated JSON');
    });

    it('hasValidKeys() returns false on invalid JSON', () => {
      fs.writeFileSync(geminiKeysPath, '{invalid json}');
      const adapter = createGeminiAdapter(geminiKeysPath);
      assert.equal(adapter.hasValidKeys(), false, 'should return false for invalid JSON');
    });

    it('loadCredentials() throws descriptive error on corrupt file', () => {
      fs.writeFileSync(geminiKeysPath, '{invalid}');
      const adapter = createGeminiAdapter(geminiKeysPath);
      assert.throws(
        () => adapter.loadCredentials(),
        /Failed to parse API keys file: corrupted or invalid JSON/,
        'should throw descriptive error'
      );
    });

    it('loadCredentials() throws descriptive error on empty file', () => {
      fs.writeFileSync(geminiKeysPath, '');
      const adapter = createGeminiAdapter(geminiKeysPath);
      assert.throws(
        () => adapter.loadCredentials(),
        /Failed to parse API keys file: corrupted or invalid JSON/,
        'should throw descriptive error'
      );
    });

    it('hasValidKeys() returns true on valid file', () => {
      fs.writeFileSync(geminiKeysPath, JSON.stringify({
        apiKey: 'test-api-key-12345',
        apiSecret: 'test-api-secret-67890abcdef',
      }));
      const adapter = createGeminiAdapter(geminiKeysPath);
      assert.equal(adapter.hasValidKeys(), true, 'should return true for valid file');
    });
  });

  describe('Crypto.com adapter', () => {
    it('hasValidKeys() returns false on empty file', () => {
      fs.writeFileSync(cryptocomKeysPath, '');
      const adapter = createCryptocomAdapter(cryptocomKeysPath);
      assert.equal(adapter.hasValidKeys(), false, 'should return false for empty file');
    });

    it('hasValidKeys() returns false on truncated/incomplete JSON', () => {
      fs.writeFileSync(cryptocomKeysPath, '{"apiKey": "test-');
      const adapter = createCryptocomAdapter(cryptocomKeysPath);
      assert.equal(adapter.hasValidKeys(), false, 'should return false for truncated JSON');
    });

    it('hasValidKeys() returns false on invalid JSON', () => {
      fs.writeFileSync(cryptocomKeysPath, '{invalid json}');
      const adapter = createCryptocomAdapter(cryptocomKeysPath);
      assert.equal(adapter.hasValidKeys(), false, 'should return false for invalid JSON');
    });

    it('loadCredentials() throws descriptive error on corrupt file', () => {
      fs.writeFileSync(cryptocomKeysPath, '{invalid}');
      const adapter = createCryptocomAdapter(cryptocomKeysPath);
      assert.throws(
        () => adapter.loadCredentials(),
        /Failed to parse API keys file: corrupted or invalid JSON/,
        'should throw descriptive error'
      );
    });

    it('loadCredentials() throws descriptive error on empty file', () => {
      fs.writeFileSync(cryptocomKeysPath, '');
      const adapter = createCryptocomAdapter(cryptocomKeysPath);
      assert.throws(
        () => adapter.loadCredentials(),
        /Failed to parse API keys file: corrupted or invalid JSON/,
        'should throw descriptive error'
      );
    });

    it('hasValidKeys() returns true on valid file', () => {
      fs.writeFileSync(cryptocomKeysPath, JSON.stringify({
        apiKey: 'test-api-key-12345',
        apiSecret: 'test-api-secret-67890abcdef',
      }));
      const adapter = createCryptocomAdapter(cryptocomKeysPath);
      assert.equal(adapter.hasValidKeys(), true, 'should return true for valid file');
    });
  });
});
