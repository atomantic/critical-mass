const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createCoinbaseAdapter } = require('../src/adapters/coinbase/api');
const { createGeminiAdapter } = require('../src/adapters/gemini/api');
const { createCryptocomAdapter } = require('../src/adapters/cryptocom/api');

const contextFor = (line) => {
  const contextStart = line.lastIndexOf(' {');
  assert.notEqual(contextStart, -1, `missing structured context: ${line}`);
  return JSON.parse(line.slice(contextStart + 1));
};

describe('adapter API structured logging', () => {
  it('keeps exchange REST adapters off direct console calls', () => {
    for (const relativePath of [
      '../src/adapters/coinbase/api.js',
      '../src/adapters/gemini/api.js',
      '../src/adapters/cryptocom/api.js',
    ]) {
      const source = fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
      assert.doesNotMatch(source, /\bconsole\.(?:log|warn|error)\b/, relativePath);
      assert.match(source, /createContextLogger\(/, relativePath);
    }
  });

  it('preserves representative messages and appends useful exchange context', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-api-logging-'));
    const originalFetch = global.fetch;
    const originalLog = console.log;
    const lines = [];

    try {
      console.log = line => lines.push(line);

      const { privateKey } = crypto.generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      });
      const coinbaseKeys = path.join(tempDir, 'coinbase.json');
      fs.writeFileSync(coinbaseKeys, JSON.stringify({
        name: 'organizations/test/apiKeys/test-key',
        privateKey,
      }));
      const coinbase = createCoinbaseAdapter(coinbaseKeys);
      let attempts = 0;
      global.fetch = async () => {
        attempts++;
        if (attempts === 1) {
          throw Object.assign(new Error('socket disconnected'), { code: 'ECONNRESET' });
        }
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ price: '50000' }),
        };
      };
      assert.equal(await coinbase.getCurrentPrice('BTC-USDC'), 50000);

      const cryptocomKeys = path.join(tempDir, 'cryptocom.json');
      fs.writeFileSync(cryptocomKeys, JSON.stringify({
        apiKey: 'test-api-key-123',
        apiSecret: 'test-api-secret-456',
      }));
      const cryptocom = createCryptocomAdapter(cryptocomKeys);
      cryptocom.getProductDetails = async () => ({
        baseIncrement: '0.001',
        quoteIncrement: '0.01',
        baseMinSize: '0.01',
        price: 100,
      });
      await cryptocom.placeLimitSell('BTC-USD', 0.0099, 100);

      const geminiKeys = path.join(tempDir, 'gemini.json');
      fs.writeFileSync(geminiKeys, JSON.stringify({
        apiKey: 'test-api-key-123',
        apiSecret: 'test-api-secret-456',
      }));
      const gemini = createGeminiAdapter(geminiKeys);
      global.fetch = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ result: 'ok' }),
      });
      gemini.startHeartbeat('gemini/BTC-USD');
      gemini.stopHeartbeat('gemini/BTC-USD');
      await new Promise(resolve => setImmediate(resolve));
    } finally {
      global.fetch = originalFetch;
      console.log = originalLog;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    const coinbaseLine = lines.find(line => line.startsWith('⚠️ [coinbase] Network error on GET'));
    assert.ok(coinbaseLine);
    assert.deepEqual(contextFor(coinbaseLine), {
      exchange: 'coinbase',
      pair: 'BTC-USDC',
      method: 'GET',
      endpoint: '/api/v3/brokerage/products/BTC-USDC',
      delayMs: 1000,
      attempt: 1,
      retries: 3,
      error: 'socket disconnected',
    });

    const cryptocomLine = lines.find(line => line.startsWith('⚠️ Crypto.com order qty'));
    assert.ok(cryptocomLine);
    const cryptocomContext = contextFor(cryptocomLine);
    assert.deepEqual(cryptocomContext, {
      exchange: 'cryptocom',
      pair: 'BTC-USD',
      side: 'SELL',
      requestedAmount: 0.0099,
      roundedAmount: 0.009000000000000001,
      minimumAmount: 0.01,
      baseIncrement: 0.001,
    });

    const heartbeatLine = lines.find(line => line.startsWith('💓 [gemini] Heartbeat started'));
    assert.ok(heartbeatLine);
    assert.deepEqual(contextFor(heartbeatLine), {
      exchange: 'gemini',
      pair: 'BTC-USD',
      owner: 'gemini/BTC-USD',
      consumers: 1,
      intervalMs: 60000,
    });
  });
});
