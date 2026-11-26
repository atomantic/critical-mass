// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const registerUpdownRoutes = require('../src/routes/updown-routes');

const createFakeApp = () => {
  const handlers = {};
  const register = method => (route, handler) => { handlers[`${method} ${route}`] = handler; };
  return { handlers, get: register('GET'), put: register('PUT'), post: register('POST'), delete: register('DELETE') };
};

const createRes = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
});

const createReq = (query = { providerId: 'vision' }) => ({
  query,
  headers: { 'content-type': 'image/png', 'content-length': '8' },
  async *[Symbol.asyncIterator]() { yield Buffer.from('fake-png'); },
});

const validProvider = {
  type: 'api',
  enabled: true,
  endpoint: 'https://vision.example.test/v1',
  defaultModel: 'vision-model',
  timeout: 10,
};

const responseWithContent = content => Response.json({ choices: [{ message: { content } }] });

const registerRoute = (dataDir, overrides = {}) => {
  const app = createFakeApp();
  registerUpdownRoutes(app, {
    updownService: {},
    candleCache: { getAllCandles: () => [] },
    readJSON: () => ({ providers: { vision: validProvider } }),
    DATA_DIR: dataDir,
    fetchImpl: async () => responseWithContent('{"screenType":"select","direction":"Up"}'),
    allowedAiOrigins: new Set(['https://vision.example.test']),
    ...overrides,
  });
  return app.handlers['POST /api/updown/screenshot'];
};

const assertNoRetainedScreenshots = dataDir => {
  const screenshotsDir = path.join(dataDir, 'screenshots');
  assert.equal(fs.existsSync(screenshotsDir), false, 'analysis must not retain a screenshots directory');
};

describe('POST /api/updown/screenshot transient storage (issue #286)', () => {
  it('does not accumulate screenshots across repeated successful analyses', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'critical-mass-updown-'));
    try {
      const handler = registerRoute(dataDir);
      for (let i = 0; i < 3; i++) {
        const res = createRes();
        await handler(createReq(), res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.success, true);
        assertNoRetainedScreenshots(dataDir);
      }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('does not persist a screenshot when provider configuration is invalid', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'critical-mass-updown-'));
    try {
      const handler = registerRoute(dataDir, { readJSON: () => ({ providers: {} }) });
      const res = createRes();
      await handler(createReq(), res);
      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /not found/);
      assertNoRetainedScreenshots(dataDir);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('does not persist a screenshot when the provider request fails or times out', async () => {
    const failures = [
      async () => { throw new Error('provider unavailable'); },
      async (_url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('request timed out')), { once: true });
      }),
    ];

    for (const fetchImpl of failures) {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'critical-mass-updown-'));
      try {
        const handler = registerRoute(dataDir, { fetchImpl });
        const res = createRes();
        await handler(createReq(), res);
        assert.equal(res.statusCode, 502);
        assertNoRetainedScreenshots(dataDir);
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    }
  });

  it('does not persist a screenshot when the provider response cannot be parsed', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'critical-mass-updown-'));
    try {
      const handler = registerRoute(dataDir, {
        fetchImpl: async () => responseWithContent('not json'),
      });
      const res = createRes();
      await handler(createReq(), res);
      assert.equal(res.statusCode, 422);
      assertNoRetainedScreenshots(dataDir);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('app quotes', () => {
  it('reading a screenshot never records a quote', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-shot-quote-'));
    const refuse = () => assert.fail('a quote is recorded only when the operator confirms it');
    const handler = registerRoute(dir, {
      appQuotes: { record: refuse, check: refuse },
      fetchImpl: async () => responseWithContent('{"screenType":"select","direction":"Up","range":2000,"currentPrice":61118.69,"upPrice":61172,"downPrice":61074,"target":62200,"stop":60200,"maxLoss":"-$486.00"}'),
    });
    const res = createRes();
    await handler(createReq(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.extracted.upPrice, 61172);
    assert.deepEqual(fs.readdirSync(dir), []);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
