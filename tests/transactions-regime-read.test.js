const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const response = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
const flush = () => new Promise(resolve => setImmediate(resolve));
const options = (pair, page = 0, revision) => ({ exchange: 'coinbase', pairQuery: `?pair=${pair}`, query: new URLSearchParams({ paged: 'true', page: String(page), pair, ...(revision ? { revision } : {}) }) });
const harness = async () => {
  const { createTransactionsReader } = await import('../admin/src/utils/transactionsRead.mjs');
  const calls = [];
  const reader = createTransactionsReader((url, { signal }) => { const call = { url, signal, ...deferred() }; calls.push(call); return call.promise; });
  return { reader, calls };
};

describe('Transactions page read ownership', () => {
  it('rejects a delayed old-fund snapshot after the new fund finishes', async () => {
    const { reader, calls } = await harness();
    const old = reader.read(options('BTC-USD'));
    const fresh = reader.read(options('ETH-USD'));
    assert.equal(calls[0].signal.aborted, true);
    calls.slice(3).forEach(call => call.resolve(response({ fund: 'ETH-USD' })));
    const current = await fresh;
    assert.equal(current.owned, true);
    calls.slice(0, 3).forEach(call => call.resolve(response({ fund: 'BTC-USD' })));
    assert.equal((await old).owned, false);
  });
  it('fences page changes while an old body is decoding', async () => {
    const { reader, calls } = await harness();
    const old = reader.read(options('BTC-USD', 0));
    const body = deferred();
    calls[0].resolve({ ok: true, status: 200, json: () => body.promise });
    calls[1].resolve(response({})); calls[2].resolve(response({}));
    await flush();
    const fresh = reader.read(options('BTC-USD', 1));
    calls.slice(3).forEach(call => call.resolve(response({ page: 1 })));
    assert.equal((await fresh).owned, true);
    body.resolve({ page: 0 });
    assert.equal((await old).owned, false);
  });
  it('reloads stale revision at page zero without issuing any unpaged request', async () => {
    const { reader, calls } = await harness();
    const read = reader.read(options('BTC-USD', 25, 'old'));
    calls[0].resolve(response({ code: 'STALE_FILL_REVISION' }, 409));
    calls[1].resolve(response({ status: {} })); calls[2].resolve(response({ orders: [] }));
    await flush();
    assert.equal(calls.length, 4);
    const query = new URL(calls[3].url, 'http://localhost').searchParams;
    assert.equal(query.get('page'), '0');
    assert.equal(query.get('paged'), 'true');
    assert.equal(query.get('revision'), null);
    calls[3].resolve(response({ revision: 'new', fills: [], pageInfo: { page: 0 } }));
    const result = await read;
    assert.equal(result.owned, true);
    assert.equal(result.data.fillsData.revision, 'new');
    assert.ok(calls.filter(call => call.url.includes('/fills')).every(call => call.url.includes('paged=true')));
  });
  it('drops a revision reload after unmount/fund invalidation', async () => {
    const { reader, calls } = await harness();
    const read = reader.read(options('BTC-USD', 2, 'old'));
    calls[0].resolve(response({}, 409));
    calls[1].resolve(response({})); calls[2].resolve(response({}));
    await flush();
    reader.invalidate();
    assert.equal(calls[3].signal.aborted, true);
    calls[3].resolve(response({ fills: ['late'] }));
    assert.equal((await read).owned, false);
  });
});
