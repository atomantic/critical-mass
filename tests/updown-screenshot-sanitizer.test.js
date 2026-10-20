// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const registerUpdownRoutes = require('../src/routes/updown-routes');

const { sanitizeExtractedFields } = registerUpdownRoutes;

const createApp = () => {
  const handlers = {};
  const register = method => (route, handler) => { handlers[`${method} ${route}`] = handler; };
  return { handlers, get: register('GET'), put: register('PUT'), post: register('POST'), delete: register('DELETE') };
};

const createResponse = content => ({
  ok: true,
  async json() { return { choices: [{ message: { content } }] }; },
});

const analyze = async content => {
  const app = createApp();
  registerUpdownRoutes(app, {
    updownService: {},
    candleCache: { getAllCandles: () => [] },
    DATA_DIR: '/synthetic-unused',
    readJSON: () => ({ providers: { fixture: {
      type: 'api', enabled: true, endpoint: 'https://vision.example.test/v1', defaultModel: 'fixture',
    } } }),
    validateEndpointUrl: async () => ({ valid: true }),
    safeFetch: async () => createResponse(content),
    allowedAiOrigins: new Set(['https://vision.example.test']),
  });
  const req = {
    query: { providerId: 'fixture' },
    headers: { 'content-type': 'image/png' },
    async *[Symbol.asyncIterator]() { yield Buffer.from('synthetic screenshot'); },
  };
  const res = { statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await app.handlers['POST /api/updown/screenshot'](req, res);
  return res;
};

describe('UpDown screenshot extracted-field sanitizer (issue #1203)', () => {
  it('rejects wrong value types, invalid enums, and overlong strings as null', () => {
    const result = sanitizeExtractedFields({
      expiresIn: 6,
      expiresOn: {},
      target: '67,000',
      contracts: [],
      entryPrice: { value: 500 },
      maxLoss: 'x'.repeat(65),
      screenType: 'account',
      direction: 'sideways',
      unknown: 'discard me',
    });

    assert.deepEqual(result, {
      expiresIn: null,
      expiresOn: null,
      target: null,
      contracts: null,
      entryPrice: null,
      maxLoss: null,
      screenType: null,
      direction: null,
    });
  });

  it('keeps correctly typed fields and negative unrealized P&L', () => {
    assert.deepEqual(sanitizeExtractedFields({
      screenType: 'position', direction: 'Down', currentPrice: '67000.5',
      unrealizedPnl: -12.5, expiresIn: '6d 18h 52m', maxProfit: '+$419.50',
    }), {
      screenType: 'position', direction: 'Down', currentPrice: 67000.5,
      unrealizedPnl: -12.5, expiresIn: '6d 18h 52m', maxProfit: '+$419.50',
    });
  });

  it('returns a successful response for non-string expiry and omits derived expiry fields', async () => {
    const result = await analyze('{"screenType":"select","direction":"Up","expiresIn":6,"expiresOn":{"year":2026}}');
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.success, true);
    assert.equal(result.body.extracted.expiresIn, null);
    assert.equal(result.body.extracted.expiresOn, null);
    assert.equal(Object.hasOwn(result.body.extracted, 'expiryMs'), false);
    assert.equal(Object.hasOwn(result.body.extracted, 'expiryISO'), false);
  });

  it('omits derived expiry fields when a bounded string encodes an out-of-range date', async () => {
    const result = await analyze('{"screenType":"select","expiresIn":"999999999999999999999999999999999999999999999999999999999999d"}');
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.success, true);
    assert.equal(result.body.extracted.expiresIn, '999999999999999999999999999999999999999999999999999999999999d');
    assert.equal(Object.hasOwn(result.body.extracted, 'expiryMs'), false);
    assert.equal(Object.hasOwn(result.body.extracted, 'expiryISO'), false);
  });

  it('preserves normal fields and derives both expiry forms as before', async () => {
    const before = Date.now();
    const result = await analyze('{"screenType":"order","direction":"Up","contractPrice":123.5,"contracts":2,"expiresIn":"1h 2m"}');
    const after = Date.now();
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.success, true);
    const extracted = result.body.extracted;
    assert.equal(extracted.screenType, 'order');
    assert.equal(extracted.direction, 'Up');
    assert.equal(extracted.contractPrice, 123.5);
    assert.equal(extracted.contracts, 2);
    assert.ok(extracted.expiryMs >= before + 3720000 && extracted.expiryMs <= after + 3720000);
    assert.equal(extracted.expiryISO, new Date(extracted.expiryMs).toISOString());
  });
});
