const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');

const setup = ({ appQuotes, io, upDipCandles } = {}) => {
  const handlers = {};
  const reg = (m) => (route, h) => { handlers[`${m} ${route}`] = h; };
  const emitted = [];
  require('../src/routes/updown-routes')({ get: reg('GET'), put: reg('PUT'), patch: reg('PATCH'), post: reg('POST'), delete: reg('DELETE') }, {
    updownService: { getTradeContext: () => ({}) }, candleCache: { getAllCandles: () => [] },
    readJSON: () => ({ trades: [], nextId: 1 }), writeJSON: () => {}, DATA_DIR: os.tmpdir(),
    upDipPaper: { getStatus: () => ({ latest: null }) }, appQuotes, upDipCandles,
    io: io === undefined ? { to: (room) => ({ emit: (event) => emitted.push(`${room}:${event}`) }) } : io,
  });
  const call = (key, body) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    handlers[key]({ query: {}, params: {}, body }, res);
    return res;
  };
  return { call, emitted };
};
const fake = () => {
  const calls = [];
  const answer = (input) => (input.range === 2000 ? { quote: { halfSpread: 49 } } : { error: 'range must be 2000 or 500' });
  return { calls, check: (i) => { calls.push(['check', i]); return answer(i); }, record: (i) => { calls.push(['record', i]); return answer(i); }, getStatus: () => ({ listingSeen: true }) };
};

describe('POST /api/updown/app-quotes', () => {
  it('previews without recording', () => {
    const appQuotes = fake();
    const { call, emitted } = setup({ appQuotes });
    const res = call('POST /api/updown/app-quotes', { preview: true, range: 2000 });
    assert.deepEqual(res.body, { success: true, quote: { halfSpread: 49 } });
    assert.deepEqual(appQuotes.calls, [['check', { range: 2000 }]]);
    assert.deepEqual(emitted, []);
  });

  it('records and tells the panel', () => {
    const appQuotes = fake();
    const { call, emitted } = setup({ appQuotes });
    assert.equal(call('POST /api/updown/app-quotes', { range: 2000 }).statusCode, 200);
    assert.deepEqual(appQuotes.calls, [['record', { range: 2000 }]]);
    assert.deepEqual(emitted, ['updown:updown:up-dip']);
  });

  it('answers 400 with the reason, and tells nobody', () => {
    const { call, emitted } = setup({ appQuotes: fake() });
    const res = call('POST /api/updown/app-quotes', { range: 7 });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { success: false, error: 'range must be 2000 or 500' });
    assert.deepEqual(emitted, []);
  });

  it('survives a missing body', () => {
    assert.equal(setup({ appQuotes: fake() }).call('POST /api/updown/app-quotes', undefined).statusCode, 400);
  });

  it('treats only a true preview flag as a preview', () => {
    const appQuotes = fake();
    setup({ appQuotes }).call('POST /api/updown/app-quotes', { preview: 'false', range: 2000 });
    assert.equal(appQuotes.calls[0][0], 'record');
  });

  it('answers 503 when not running', () => {
    assert.equal(setup().call('POST /api/updown/app-quotes', { range: 2000 }).statusCode, 503);
  });
});

describe('DELETE /api/updown/app-quotes/:recordedAt', () => {
  const del = (appQuotes, recordedAt) => {
    const handlers = {};
    const emitted = [];
    const reg = (m) => (route, h) => { handlers[`${m} ${route}`] = h; };
    require('../src/routes/updown-routes')({ get: reg('GET'), put: reg('PUT'), patch: reg('PATCH'), post: reg('POST'), delete: reg('DELETE') }, {
      updownService: {}, candleCache: {}, readJSON: () => ({}), writeJSON: () => {}, DATA_DIR: os.tmpdir(), appQuotes,
      io: { to: () => ({ emit: (e) => emitted.push(e) }) },
    });
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    handlers['DELETE /api/updown/app-quotes/:recordedAt']({ params: { recordedAt }, query: {} }, res);
    return { res, emitted };
  };
  it('removes the quote it names and tells the panel', () => {
    const { res, emitted } = del({ remove: (at) => (at === 123 ? {} : { error: 'not the last quote' }) }, '123');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(emitted, ['updown:up-dip']);
  });
  it('answers 409 when it is not the last one, and 503 when not running', () => {
    const { res, emitted } = del({ remove: () => ({ error: 'not the last quote' }) }, '5');
    assert.equal(res.statusCode, 409);
    assert.deepEqual(emitted, []);
    assert.equal(del(null, '5').res.statusCode, 503);
  });
});

describe('GET /api/updown/up-dip', () => {
  it('reports quotes when running and omits them otherwise', () => {
    assert.deepEqual(setup({ appQuotes: fake() }).call('GET /api/updown/up-dip').body.quotes, { listingSeen: true });
    assert.equal('quotes' in setup().call('GET /api/updown/up-dip').body, false);
  });

  it('reports candle status when running and omits it otherwise', () => {
    const status = { ready: true, waitingFor: null };
    assert.deepEqual(setup({ upDipCandles: { getStatus: () => status } }).call('GET /api/updown/up-dip').body.candles, status);
    assert.equal('candles' in setup().call('GET /api/updown/up-dip').body, false);
  });
});
