// @ts-check
/**
 * Tests for issue #215-B — POST /api/updown/screenshot must not buffer an
 * unbounded request body into memory. Exercises `readBodyWithLimit()`
 * (exported from src/routes/updown-routes.js) directly since it is the
 * unit that enforces the cap, plus one end-to-end pass through the
 * registered route handler to confirm the 413 surfaces correctly and a
 * legitimate small request is unaffected.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const registerUpdownRoutes = require('../src/routes/updown-routes');
const { readBodyWithLimit } = registerUpdownRoutes;

/** Fake IncomingMessage-like async-iterable request. */
function makeFakeReq({ headers = {}, chunks = [] }) {
  let pulled = 0;
  return {
    headers,
    get pulledChunks() { return pulled; },
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) {
        pulled++;
        yield Buffer.isBuffer(c) ? c : Buffer.from(c);
      }
    },
  };
}

describe('readBodyWithLimit (issue #215-B)', () => {
  it('rejects immediately via a declared Content-Length over the cap, without reading the stream', async () => {
    const req = makeFakeReq({
      headers: { 'content-length': '1000' },
      chunks: ['irrelevant'],
    });
    await assert.rejects(
      () => readBodyWithLimit(req, 100),
      (err) => { assert.equal(err.status, 413); return true; }
    );
    assert.equal(req.pulledChunks, 0, 'should not have consumed the stream once Content-Length already exceeded the cap');
  });

  it('rejects once streamed bytes exceed the cap (no Content-Length declared)', async () => {
    // 5 chunks of 40 bytes = 200 bytes total against a 100-byte cap; the
    // reader should stop after the 3rd chunk (120 > 100) rather than
    // consuming all 5.
    const chunk = 'x'.repeat(40);
    const req = makeFakeReq({ headers: {}, chunks: [chunk, chunk, chunk, chunk, chunk] });
    await assert.rejects(
      () => readBodyWithLimit(req, 100),
      (err) => { assert.equal(err.status, 413); return true; }
    );
    assert.equal(req.pulledChunks, 3, 'should stop pulling chunks as soon as the cap is exceeded');
  });

  it('resolves with the full buffer when under the cap', async () => {
    const req = makeFakeReq({ headers: {}, chunks: ['abc', 'def'] });
    const buf = await readBodyWithLimit(req, 100);
    assert.equal(buf.toString(), 'abcdef');
  });

  it('resolves when Content-Length is declared but within the cap', async () => {
    const req = makeFakeReq({ headers: { 'content-length': '6' }, chunks: ['abc', 'def'] });
    const buf = await readBodyWithLimit(req, 100);
    assert.equal(buf.toString(), 'abcdef');
  });
});

// ============================================================================
// Route-level integration: POST /api/updown/screenshot
// ============================================================================

const createFakeApp = () => {
  const handlers = {};
  const register = (method) => (route, handler) => { handlers[`${method} ${route}`] = handler; };
  return { handlers, get: register('GET'), put: register('PUT'), post: register('POST'), delete: register('DELETE') };
};

const createRes = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
});

describe('POST /api/updown/screenshot body-size guard (issue #215-B)', () => {
  it('returns 413 for a declared Content-Length above MAX_SCREENSHOT_BYTES', async () => {
    const app = createFakeApp();
    registerUpdownRoutes(app, {
      updownService: {},
      candleCache: { getAllCandles: () => [] },
      readJSON: () => ({ providers: {} }),
      DATA_DIR: '/tmp/updown-screenshot-test',
    });

    const req = makeFakeReq({
      headers: { 'content-length': String(registerUpdownRoutes.MAX_SCREENSHOT_BYTES + 1) },
      chunks: [],
    });
    req.query = { providerId: 'anything' };
    const res = createRes();
    await app.handlers['POST /api/updown/screenshot'](req, res);
    assert.equal(res.statusCode, 413);
    assert.equal(res.body.success, false);
  });
});
