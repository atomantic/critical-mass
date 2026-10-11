const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { instrument, auditOutcome, main } = require('../scripts/perf-browser-audit');
const { aggregate } = require('../scripts/lib/perf-metrics');

function driver() {
  const browser = new EventEmitter();
  browser.call = async () => ({ body: JSON.stringify({ fills: Array.from({ length: 100 }, () => ({ side: 'buy' })), pageInfo: { total: 30000 } }) });
  return browser;
}
describe('browser audit evidence', () => {
  it('measures real overlapping requests with encoded and decoded bytes, without retaining bodies or values', async () => {
    const browser = driver();
    const metrics = instrument(browser, 'http://127.0.0.1:1234');
    metrics.phase = 'transactions';
    for (const [id, start, end] of [['a', 1, 3], ['b', 2, 4]]) {
      browser.emit('Network.requestWillBeSent', { requestId: id, type: 'Fetch', timestamp: start, request: { method: 'GET', url: 'http://127.0.0.1:1234/api/coinbase/regime/fills?pair=synthetic-private-value&paged=true' } });
      browser.emit('Network.responseReceived', { requestId: id, response: { status: 200 } });
      browser.emit('Network.dataReceived', { requestId: id, dataLength: 1000 });
      browser.emit('Network.loadingFinished', { requestId: id, timestamp: end, encodedDataLength: 450 });
    }
    await metrics.flush();
    const report = aggregate(metrics.collector, 'transactions', 60000);
    const row = Object.values(report.http)[0];
    assert.equal(row.wireBytes, 900);
    assert.equal(row.decodedBytes, 2000);
    assert.equal(row.maxOverlap, 2);
    assert.ok(metrics.pages.every(page => page.compact && page.rows === 100 && page.total === 30000));
    assert.ok(!JSON.stringify(metrics.collector).includes('synthetic-private-value'));
    assert.ok(!JSON.stringify(metrics.pages).includes('side'));
  });
  it('counts websocket payload bytes by direction and safe event name, including protocol overhead separately', () => {
    const browser = driver();
    const metrics = instrument(browser, 'http://127.0.0.1:1234');
    metrics.phase = 'idle';
    const payload = '42["regime:status",{"secret":"never-store-this"}]';
    browser.emit('Network.webSocketFrameReceived', { timestamp: 1, response: { opcode: 1, payloadData: payload } });
    browser.emit('Network.webSocketFrameSent', { timestamp: 2, response: { opcode: 1, payloadData: '3' } });
    browser.emit('Network.webSocketFrameReceived', { timestamp: 3, response: { opcode: 1, payloadData: '42["private-event-name",{}]' } });
    const report = aggregate(metrics.collector, 'idle', 60000);
    assert.equal(report.ws['in regime:status'].bytes, Buffer.byteLength(payload));
    assert.equal(report.ws['out protocol'].count, 1);
    assert.equal(report.ws['in other'].count, 1);
    assert.ok(!JSON.stringify(report).includes('never-store-this'));
    assert.ok(!JSON.stringify(report).includes('private-event-name'));
  });
  it('distinguishes navigation cancellation from missing evidence and records browser errors', () => {
    const browser = driver();
    const metrics = instrument(browser, 'http://127.0.0.1:1234');
    const start = id => browser.emit('Network.requestWillBeSent', { requestId: id, type: 'XHR', timestamp: 1, request: { method: 'GET', url: 'http://127.0.0.1:1234/api/coinbase/config' } });
    start('canceled');
    browser.emit('Network.loadingFailed', { requestId: 'canceled', canceled: true });
    assert.equal(metrics.incomplete, 0);
    start('failed');
    browser.emit('Network.loadingFailed', { requestId: 'failed', canceled: false });
    browser.emit('Runtime.exceptionThrown', {});
    assert.equal(metrics.incomplete, 1);
    assert.equal(metrics.runtimeErrors, 1);
  });
  it('bounds outstanding reads and reports incomplete evidence as UNVERIFIED', async () => {
    const browser = driver();
    const metrics = instrument(browser, 'http://127.0.0.1:1234');
    browser.emit('Network.requestWillBeSent', { requestId: 'stalled', type: 'Fetch', timestamp: 1, request: { method: 'GET', url: 'http://127.0.0.1:1234/api/coinbase/config?pair=synthetic' } });
    await metrics.flush(20);
    assert.equal(metrics.incomplete, 1);
    assert.equal(metrics.collector.http.length, 1);
    assert.equal(metrics.collector.http[0].wireBytes, null);
    assert.equal(auditOutcome([{ ok: true }], metrics.incomplete, 60000).verdict, 'UNVERIFIED');
    assert.equal(auditOutcome([{ ok: false }], metrics.incomplete, 60000).verdict, 'UNVERIFIED');
    assert.equal(auditOutcome([{ ok: true }], 0, 1000).verdict, 'UNVERIFIED');
    assert.equal(auditOutcome([{ ok: true }], 0, 60000).verdict, 'PASS');
    assert.equal(auditOutcome([{ ok: false }], 0, 60000).verdict, 'FAIL');
  });
  it('reports missing browser as UNVERIFIED, without starting a gateway', async () => {
    const old = process.env.CM_PERF_CHROME;
    const log = console.log;
    process.env.CM_PERF_CHROME = '/nonexistent/synthetic-chrome';
    let result;
    console.log = value => { result = JSON.parse(value); };
    try {
      assert.equal(await main([]), 2);
      assert.equal(result.verdict, 'UNVERIFIED');
      assert.equal(result.stage, 'browser');
    } finally {
      console.log = log;
      if (old === undefined) delete process.env.CM_PERF_CHROME;
      else process.env.CM_PERF_CHROME = old;
    }
  });
});
