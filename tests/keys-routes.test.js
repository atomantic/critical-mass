// @ts-check
/**
 * Tests for API key routes in src/routes/keys-routes.js (issue #405):
 *
 *  - GET  /api/:exchange/keys/status      — reports if keys exist on disk
 *  - GET  /api/:exchange/keys             — returns boolean field flags (NEVER raw secrets)
 *  - POST /api/:exchange/keys             — validates schemas, writes keys to disk
 *  - PUT  /api/:exchange/keys             — validates schemas, writes keys to disk
 *  - POST /api/:exchange/test-connection  — tests connection using adapter
 *  - DELETE /api/:exchange/keys           — removes keys file
 *
 * Critical: Credentials are NEVER leaked in GET responses, schema validation prevents
 * malformed keys from persisting, and adapter errors are caught gracefully.
 */
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const migration = require('../src/migration');
const paths = require('../src/paths');
// Note: keys-routes is loaded dynamically in each test after mocking

// Real fs, captured before any mock.method() calls
const realFs = {
  existsSync: fs.existsSync.bind(fs),
  readFileSync: fs.readFileSync.bind(fs),
  writeFileSync: fs.writeFileSync.bind(fs),
  unlinkSync: fs.unlinkSync.bind(fs),
  mkdirSync: fs.mkdirSync.bind(fs),
  rmSync: fs.rmSync.bind(fs),
};

// Create a minimal fake Express app
const createFakeApp = () => {
  const handlers = {};
  const register = (method) => (route, handler) => { handlers[`${method} ${route}`] = handler; };
  return {
    handlers,
    get: register('GET'),
    post: register('POST'),
    put: register('PUT'),
    delete: register('DELETE'),
  };
};

// Create a fake response object
const createRes = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
});

// Invoke a handler by its route key
const invoke = async (app, key, req = {}) => {
  const res = createRes();
  await app.handlers[key]({ body: {}, params: {}, query: {}, ...req }, res);
  return res;
};

describe('API key routes', () => {
  let tempKeysDir;
  let registerKeysRoutes;
  const originalGetExchangeKeysPath = migration.getExchangeKeysPath;
  const keysRoutesPath = require.resolve('../src/routes/keys-routes');

  const getRegisterKeysRoutes = () => {
    // Clear the require cache for keys-routes so it reloads
    delete require.cache[keysRoutesPath];
    // Do NOT clear migration cache — we need to keep our mock
    return require(keysRoutesPath);
  };

  beforeEach(() => {
    // Create a real temp directory for this test
    tempKeysDir = realFs.mkdirSync(path.join(os.tmpdir(), 'keys-routes-test-'), { recursive: true });

    // Replace migration.getExchangeKeysPath to use temp directory BEFORE reloading keys-routes
    migration.getExchangeKeysPath = (exchange) => {
      return path.join(tempKeysDir, `${exchange}-keys.json`);
    };

    // Reload keys-routes with the mocked getExchangeKeysPath (now it will destructure the mocked version)
    registerKeysRoutes = getRegisterKeysRoutes();
  });

  afterEach(() => {
    mock.restoreAll();
    // Restore original function
    migration.getExchangeKeysPath = originalGetExchangeKeysPath;
    // Clean up the temp directory
    if (tempKeysDir && realFs.rmSync) {
      realFs.rmSync(tempKeysDir, { recursive: true, force: true });
    }
  });

  describe('GET /api/:exchange/keys/status', () => {
    it('returns configured: true when keys file exists', async () => {
      const app = createFakeApp();
      const writeJSON = (filePath, data) => fs.writeFileSync(filePath, JSON.stringify(data));
      registerKeysRoutes(app, { writeJSON });

      // Write keys file
      const keysFilePath = path.join(tempKeysDir, 'coinbase-keys.json');
      writeJSON(keysFilePath, { name: 'mykey', privateKey: 'secret' });

      const res = await invoke(app, 'GET /api/:exchange/keys/status', {
        params: { exchange: 'coinbase' },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.configured, true);
      assert.equal(res.body.exchange, 'coinbase');
    });

    it('returns configured: false when keys file does not exist', async () => {
      const app = createFakeApp();
      registerKeysRoutes(app, { writeJSON: () => {} });

      const res = await invoke(app, 'GET /api/:exchange/keys/status', {
        params: { exchange: 'gemini' },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.configured, false);
      assert.equal(res.body.exchange, 'gemini');
    });
  });

  describe('GET /api/:exchange/keys', () => {
    it('returns configured: false when keys file does not exist', async () => {
      const app = createFakeApp();
      registerKeysRoutes(app, { writeJSON: () => {} });

      const res = await invoke(app, 'GET /api/:exchange/keys', {
        params: { exchange: 'coinbase' },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.configured, false);
      assert.equal(res.body.keys, null);
    });

    it('returns boolean field flags (NOT raw secret values) when keys exist', async () => {
      const app = createFakeApp();
      const writeJSON = (filePath, data) => fs.writeFileSync(filePath, JSON.stringify(data));
      registerKeysRoutes(app, { writeJSON });

      // Write Coinbase keys
      const keysFilePath = path.join(tempKeysDir, 'coinbase-keys.json');
      writeJSON(keysFilePath, {
        name: 'my-key-name',
        privateKey: 'super-secret-private-key-abc123xyz',
        createdAt: '2024-01-01T00:00:00Z',
      });

      const res = await invoke(app, 'GET /api/:exchange/keys', {
        params: { exchange: 'coinbase' },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.configured, true);
      assert.deepEqual(res.body.fields, { name: true, privateKey: true });
      assert.equal(res.body.createdAt, '2024-01-01T00:00:00Z');

      // Crucially: assert that NO raw secrets appear anywhere in the response
      const responseStr = JSON.stringify(res.body);
      assert.ok(!responseStr.includes('super-secret-private-key-abc123xyz'), 'response must not contain raw private key');
      assert.ok(!responseStr.includes('my-key-name'), 'response must not contain raw key name');
    });

    it('returns boolean flags for Crypto.com/Gemini keys (apiKey and apiSecret)', async () => {
      const app = createFakeApp();
      const writeJSON = (filePath, data) => fs.writeFileSync(filePath, JSON.stringify(data));
      registerKeysRoutes(app, { writeJSON });

      // Write Crypto.com keys
      const keysFilePath = path.join(tempKeysDir, 'crypto.com-keys.json');
      writeJSON(keysFilePath, {
        apiKey: 'super-secret-api-key',
        apiSecret: 'super-secret-api-secret',
        createdAt: '2024-01-01T00:00:00Z',
      });

      const res = await invoke(app, 'GET /api/:exchange/keys', {
        params: { exchange: 'crypto.com' },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.configured, true);
      assert.deepEqual(res.body.fields, { apiKey: true, apiSecret: true });

      // Crucially: NO raw secrets in response
      const responseStr = JSON.stringify(res.body);
      assert.ok(!responseStr.includes('super-secret-api-key'), 'response must not contain raw apiKey');
      assert.ok(!responseStr.includes('super-secret-api-secret'), 'response must not contain raw apiSecret');
    });

    it('handles malformed keys file gracefully (returns configured: false)', async () => {
      const app = createFakeApp();
      registerKeysRoutes(app, { writeJSON: () => {} });

      // Write invalid JSON
      const keysFilePath = path.join(tempKeysDir, 'coinbase-keys.json');
      fs.writeFileSync(keysFilePath, 'not valid json {{{');

      const res = await invoke(app, 'GET /api/:exchange/keys', {
        params: { exchange: 'coinbase' },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.configured, false, 'malformed keys must be treated as not configured');
      assert.equal(res.body.keys, null);
    });

    it('excludes createdAt from fields but includes it at top level', async () => {
      const app = createFakeApp();
      const writeJSON = (filePath, data) => fs.writeFileSync(filePath, JSON.stringify(data));
      registerKeysRoutes(app, { writeJSON });

      const keysFilePath = path.join(tempKeysDir, 'gemini-keys.json');
      writeJSON(keysFilePath, {
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        createdAt: '2024-06-15T12:30:45Z',
      });

      const res = await invoke(app, 'GET /api/:exchange/keys', {
        params: { exchange: 'gemini' },
      });

      assert.equal(res.body.configured, true);
      assert.ok(!res.body.fields.createdAt, 'createdAt must NOT be in fields object');
      assert.equal(res.body.createdAt, '2024-06-15T12:30:45Z', 'createdAt must be at top level');
    });

    it('handles missing createdAt gracefully (treats as null)', async () => {
      const app = createFakeApp();
      const writeJSON = (filePath, data) => fs.writeFileSync(filePath, JSON.stringify(data));
      registerKeysRoutes(app, { writeJSON });

      const keysFilePath = path.join(tempKeysDir, 'coinbase-keys.json');
      writeJSON(keysFilePath, {
        name: 'my-key',
        privateKey: 'secret',
        // createdAt intentionally omitted
      });

      const res = await invoke(app, 'GET /api/:exchange/keys', {
        params: { exchange: 'coinbase' },
      });

      assert.equal(res.body.configured, true);
      assert.equal(res.body.createdAt, null);
    });
  });

  describe('POST /api/:exchange/keys', () => {
    it('rejects Coinbase keys when name is missing (400)', async () => {
      const app = createFakeApp();
      const writeJSON = () => { throw new Error('should not write'); };
      registerKeysRoutes(app, { writeJSON });

      const res = await invoke(app, 'POST /api/:exchange/keys', {
        params: { exchange: 'coinbase' },
        body: { privateKey: 'secret' }, // name is missing
      });

      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /name and privateKey are required/i);
    });

    it('rejects Coinbase keys when privateKey is missing (400)', async () => {
      const app = createFakeApp();
      const writeJSON = () => { throw new Error('should not write'); };
      registerKeysRoutes(app, { writeJSON });

      const res = await invoke(app, 'POST /api/:exchange/keys', {
        params: { exchange: 'coinbase' },
        body: { name: 'my-key' }, // privateKey is missing
      });

      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /name and privateKey are required/i);
    });

    it('rejects Crypto.com keys when apiKey is missing (400)', async () => {
      const app = createFakeApp();
      const writeJSON = () => { throw new Error('should not write'); };
      registerKeysRoutes(app, { writeJSON });

      const res = await invoke(app, 'POST /api/:exchange/keys', {
        params: { exchange: 'crypto.com' },
        body: { apiSecret: 'secret' }, // apiKey is missing
      });

      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /apiKey and apiSecret are required/i);
    });

    it('rejects Gemini keys when apiSecret is missing (400)', async () => {
      const app = createFakeApp();
      const writeJSON = () => { throw new Error('should not write'); };
      registerKeysRoutes(app, { writeJSON });

      const res = await invoke(app, 'POST /api/:exchange/keys', {
        params: { exchange: 'gemini' },
        body: { apiKey: 'key' }, // apiSecret is missing
      });

      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /apiKey and apiSecret are required/i);
    });

    it('successfully saves valid Coinbase keys and returns 200', async () => {
      const app = createFakeApp();
      const writeJSON = (filePath, data) => fs.writeFileSync(filePath, JSON.stringify(data));
      registerKeysRoutes(app, { writeJSON });

      const res = await invoke(app, 'POST /api/:exchange/keys', {
        params: { exchange: 'coinbase' },
        body: { name: 'my-key', privateKey: 'secret-key' },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.exchange, 'coinbase');
      assert.equal(res.body.configured, true);

      // Verify file was written
      const keysFilePath = path.join(tempKeysDir, 'coinbase-keys.json');
      const written = JSON.parse(fs.readFileSync(keysFilePath, 'utf8'));
      assert.equal(written.name, 'my-key');
      assert.equal(written.privateKey, 'secret-key');
      assert.ok(written.createdAt, 'createdAt must be set');
    });

    it('successfully saves valid Crypto.com keys and returns 200', async () => {
      const app = createFakeApp();
      const writeJSON = (filePath, data) => fs.writeFileSync(filePath, JSON.stringify(data));
      registerKeysRoutes(app, { writeJSON });

      const res = await invoke(app, 'POST /api/:exchange/keys', {
        params: { exchange: 'crypto.com' },
        body: { apiKey: 'my-api-key', apiSecret: 'my-api-secret' },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.exchange, 'crypto.com');

      // Verify file was written
      const keysFilePath = path.join(tempKeysDir, 'crypto.com-keys.json');
      const written = JSON.parse(fs.readFileSync(keysFilePath, 'utf8'));
      assert.equal(written.apiKey, 'my-api-key');
      assert.equal(written.apiSecret, 'my-api-secret');
    });

    it('includes createdAt timestamp when saving keys', async () => {
      const app = createFakeApp();
      const writeJSON = (filePath, data) => fs.writeFileSync(filePath, JSON.stringify(data));
      registerKeysRoutes(app, { writeJSON });

      const before = new Date();
      const res = await invoke(app, 'POST /api/:exchange/keys', {
        params: { exchange: 'gemini' },
        body: { apiKey: 'key', apiSecret: 'secret' },
      });
      const after = new Date();

      assert.equal(res.statusCode, 200);

      const keysFilePath = path.join(tempKeysDir, 'gemini-keys.json');
      const written = JSON.parse(fs.readFileSync(keysFilePath, 'utf8'));
      const createdAt = new Date(written.createdAt);
      assert.ok(createdAt >= before && createdAt <= after, 'createdAt must be current time');
    });
  });

  describe('PUT /api/:exchange/keys', () => {
    it('works identically to POST for valid keys', async () => {
      const app = createFakeApp();
      const writeJSON = (filePath, data) => fs.writeFileSync(filePath, JSON.stringify(data));
      registerKeysRoutes(app, { writeJSON });

      const res = await invoke(app, 'PUT /api/:exchange/keys', {
        params: { exchange: 'coinbase' },
        body: { name: 'updated-key', privateKey: 'updated-secret' },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);

      const keysFilePath = path.join(tempKeysDir, 'coinbase-keys.json');
      const written = JSON.parse(fs.readFileSync(keysFilePath, 'utf8'));
      assert.equal(written.name, 'updated-key');
    });

    it('rejects invalid payload on PUT (same validation as POST)', async () => {
      const app = createFakeApp();
      const writeJSON = () => { throw new Error('should not write'); };
      registerKeysRoutes(app, { writeJSON });

      const res = await invoke(app, 'PUT /api/:exchange/keys', {
        params: { exchange: 'coinbase' },
        body: { name: 'key-only' }, // missing privateKey
      });

      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /name and privateKey are required/i);
    });
  });

  describe('POST /api/:exchange/test-connection', () => {
    it('returns error when keys are not configured', async () => {
      const app = createFakeApp();
      registerKeysRoutes(app, { writeJSON: () => {} });

      // Mock adapters to return no valid keys
      const adapters = require('../src/adapters');
      mock.method(adapters, 'getAdapter', () => ({
        hasValidKeys: () => false,
      }));

      const res = await invoke(app, 'POST /api/:exchange/test-connection', {
        params: { exchange: 'coinbase' },
      });

      assert.equal(res.statusCode, 200); // HTTP 200 but success: false
      assert.equal(res.body.success, false);
      assert.match(res.body.error, /API keys not configured/i);
    });

    it('returns balance when adapter succeeds', async () => {
      const app = createFakeApp();
      registerKeysRoutes(app, { writeJSON: () => {} });

      const adapters = require('../src/adapters');
      mock.method(adapters, 'getAdapter', () => ({
        hasValidKeys: () => true,
        getAccountBalance: async (currency) => ({
          currency: currency,
          amount: 12345.67,
        }),
      }));

      const dca = require('../src/dca-engine');
      mock.method(dca, 'loadConfig', () => ({
        productId: 'BTC-USDC',
      }));

      const res = await invoke(app, 'POST /api/:exchange/test-connection', {
        params: { exchange: 'coinbase' },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.balance.amount, 12345.67);
      assert.equal(res.body.quoteCurrency, 'USDC');
    });

    it('catches adapter rejection and returns formatted error', async () => {
      const app = createFakeApp();
      registerKeysRoutes(app, { writeJSON: () => {} });

      const adapters = require('../src/adapters');
      mock.method(adapters, 'getAdapter', () => ({
        hasValidKeys: () => true,
        getAccountBalance: async () => {
          throw new Error('Connection timeout: took too long to reach exchange API');
        },
      }));

      const dca = require('../src/dca-engine');
      mock.method(dca, 'loadConfig', () => ({
        productId: 'ETH-USDC',
      }));

      const res = await invoke(app, 'POST /api/:exchange/test-connection', {
        params: { exchange: 'gemini' },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, false);
      assert.match(res.body.error, /Connection timeout/);
    });

    it('returns generic error message when adapter throws without message', async () => {
      const app = createFakeApp();
      registerKeysRoutes(app, { writeJSON: () => {} });

      const adapters = require('../src/adapters');
      mock.method(adapters, 'getAdapter', () => ({
        hasValidKeys: () => true,
        getAccountBalance: async () => {
          throw new Error(); // Error with no message
        },
      }));

      const dca = require('../src/dca-engine');
      mock.method(dca, 'loadConfig', () => ({
        productId: 'BTC-USDC',
      }));

      const res = await invoke(app, 'POST /api/:exchange/test-connection', {
        params: { exchange: 'coinbase' },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, false);
      assert.match(res.body.error, /Connection failed/);
    });

    it('includes exchange and quoteCurrency in success response', async () => {
      const app = createFakeApp();
      registerKeysRoutes(app, { writeJSON: () => {} });

      const adapters = require('../src/adapters');
      mock.method(adapters, 'getAdapter', () => ({
        hasValidKeys: () => true,
        getAccountBalance: async () => ({ amount: 100 }),
      }));

      const dca = require('../src/dca-engine');
      mock.method(dca, 'loadConfig', () => ({
        productId: 'SOL-USDC',
      }));

      const res = await invoke(app, 'POST /api/:exchange/test-connection', {
        params: { exchange: 'crypto.com' },
      });

      assert.equal(res.body.exchange, 'crypto.com');
      assert.equal(res.body.quoteCurrency, 'USDC');
    });
  });

  describe('DELETE /api/:exchange/keys', () => {
    it('removes the keys file and returns success', async () => {
      const app = createFakeApp();
      const writeJSON = (filePath, data) => fs.writeFileSync(filePath, JSON.stringify(data));
      registerKeysRoutes(app, { writeJSON });

      // First, create keys
      await invoke(app, 'POST /api/:exchange/keys', {
        params: { exchange: 'coinbase' },
        body: { name: 'key', privateKey: 'secret' },
      });

      const keysFilePath = path.join(tempKeysDir, 'coinbase-keys.json');
      assert.ok(fs.existsSync(keysFilePath), 'keys file must exist before deletion');

      // Delete them
      const res = await invoke(app, 'DELETE /api/:exchange/keys', {
        params: { exchange: 'coinbase' },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.exchange, 'coinbase');
      assert.equal(res.body.configured, false);

      // Verify file was deleted
      assert.ok(!fs.existsSync(keysFilePath), 'keys file must be deleted');
    });

    it('succeeds gracefully even if keys file does not exist', async () => {
      const app = createFakeApp();
      registerKeysRoutes(app, { writeJSON: () => {} });

      const res = await invoke(app, 'DELETE /api/:exchange/keys', {
        params: { exchange: 'gemini' },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.configured, false);
    });

    it('returns configured: false after deletion', async () => {
      const app = createFakeApp();
      const writeJSON = (filePath, data) => fs.writeFileSync(filePath, JSON.stringify(data));
      registerKeysRoutes(app, { writeJSON });

      // Create keys
      await invoke(app, 'POST /api/:exchange/keys', {
        params: { exchange: 'crypto.com' },
        body: { apiKey: 'key', apiSecret: 'secret' },
      });

      // Delete
      await invoke(app, 'DELETE /api/:exchange/keys', {
        params: { exchange: 'crypto.com' },
      });

      // Verify status reflects deletion
      const statusRes = await invoke(app, 'GET /api/:exchange/keys/status', {
        params: { exchange: 'crypto.com' },
      });

      assert.equal(statusRes.body.configured, false);
    });
  });

  describe('integration: credential safety', () => {
    it('never leaks credentials across GET requests (full integration)', async () => {
      const app = createFakeApp();
      const writeJSON = (filePath, data) => fs.writeFileSync(filePath, JSON.stringify(data));
      registerKeysRoutes(app, { writeJSON });

      // Save keys with sensitive values
      await invoke(app, 'POST /api/:exchange/keys', {
        params: { exchange: 'coinbase' },
        body: {
          name: 'prod-account-secret-name',
          privateKey: '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIBn3K...',
        },
      });

      // GET the keys 5 times to ensure consistency
      for (let i = 0; i < 5; i++) {
        const res = await invoke(app, 'GET /api/:exchange/keys', {
          params: { exchange: 'coinbase' },
        });

        assert.equal(res.body.configured, true);
        assert.deepEqual(res.body.fields, { name: true, privateKey: true });

        // Exhaustive check: NO raw credentials anywhere
        const fullResponse = JSON.stringify(res.body);
        assert.ok(!fullResponse.includes('prod-account-secret-name'));
        assert.ok(!fullResponse.includes('-----BEGIN EC PRIVATE KEY-----'));
        assert.ok(!fullResponse.includes('MHcCAQEEIBn3K'));
      }
    });

    it('validates all exchanges reject incomplete payloads', async () => {
      const app = createFakeApp();
      const writeJSON = () => { throw new Error('should not write'); };
      registerKeysRoutes(app, { writeJSON });

      const exchanges = [
        { exchange: 'coinbase', body: { name: 'key' }, missing: 'privateKey' },
        { exchange: 'crypto.com', body: { apiKey: 'key' }, missing: 'apiSecret' },
        { exchange: 'gemini', body: { apiSecret: 'secret' }, missing: 'apiKey' },
      ];

      for (const { exchange, body } of exchanges) {
        const res = await invoke(app, 'POST /api/:exchange/keys', {
          params: { exchange },
          body,
        });
        assert.equal(res.statusCode, 400, `${exchange} must reject incomplete payload`);
      }
    });
  });
});
