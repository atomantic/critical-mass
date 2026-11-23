// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const registerBtcFeedRoutes = require('../src/routes/btc-feed-routes');

const request = (query) => {
  let handler;
  const asked = [];
  registerBtcFeedRoutes({ get: (path, fn) => { assert.equal(path, '/api/btc-feed/seconds'); handler = fn; } }, {
    btcFeedService: { getWindow: (n) => { asked.push(n); return { bars: ['b'], index: ['i'], status: { now: 1 } }; } },
  });
  const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  handler({ query }, res);
  return { res, asked };
};

describe('GET /api/btc-feed/seconds', () => {
  for (const [seconds, expected] of /** @type {Array<[any, number]>} */ ([[undefined, 300], ['1', 1], ['3600', 3600]])) {
    it(`serves ${seconds ?? 'the default window'}`, () => {
      const { res, asked } = request(seconds === undefined ? {} : { seconds });
      assert.deepEqual(asked, [expected]);
      assert.deepEqual(res.body, { success: true, bars: ['b'], index: ['i'], status: { now: 1 } });
    });
  }

  for (const seconds of ['0', '3601', '-1', '1.5', 'abc', '', ['5', '6']]) {
    it(`refuses ${JSON.stringify(seconds)}`, () => {
      const { res, asked } = request({ seconds });
      assert.equal(res.statusCode, 400);
      assert.deepEqual(res.body, { success: false, error: 'seconds must be a whole number from 1 to 3600' });
      assert.deepEqual(asked, []);
    });
  }

  it('is registered behind operator authentication', () => {
    const source = fs.readFileSync(require.resolve('../server'), 'utf8');
    const auth = source.indexOf("app.use('/api', gatewayShutdown.handler(operatorAuth.requireAuth))");
    const route = source.indexOf("require('./src/routes/btc-feed-routes')(routes,");
    assert.ok(auth > 0 && route > auth);
  });
});
