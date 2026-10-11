#!/usr/bin/env node
'use strict';
const { startBrowserFixture } = require('./lib/perf-browser-fixture');
const { startChrome } = require('./lib/perf-cdp');
const { createCollector, verdict } = require('./lib/perf-metrics');
const { runBrowserScenario } = require('../tests/perf-browser-scenario');

function auditOutcome(checks, incomplete, idleMs) {
  const reasons = [];
  if (incomplete) reasons.push('incomplete transport evidence');
  if (idleMs < 60000) reasons.push('idle window shorter than 60 seconds; smoke coverage only');
  return { verdict: incomplete ? 'UNVERIFIED' : verdict(checks, reasons), reasons };
}

function instrument(browser, baseUrl) {
  const collector = createCollector();
  const requests = new Map();
  const tasks = new Set();
  const metrics = { collector, pages: [], phase: 'auth', runtimeErrors: 0, incomplete: 0,
    flush: async (timeoutMs = 10000) => {
      const deadline = performance.now() + timeoutMs;
      while ((requests.size || tasks.size) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      for (const row of requests.values()) {
        if (row.recorded) continue;
        row.recorded = true;
        metrics.incomplete++;
        collector.recordHttp({ ...row, status: row.status || 0, end: row.start + performance.now() - row.observedAt, wireBytes: null });
      }
      if (tasks.size) metrics.incomplete++;
    },
  };
  browser.on('Runtime.exceptionThrown', () => metrics.runtimeErrors++);
  browser.on('Network.requestWillBeSent', msg => {
    if (!msg.request.url.startsWith(baseUrl + '/') || !['Fetch', 'XHR'].includes(msg.type)) return;
    requests.set(msg.requestId, { url: msg.request.url, method: msg.request.method, start: msg.timestamp * 1000, observedAt: performance.now(), phase: metrics.phase, decodedBytes: 0 });
  });
  browser.on('Network.responseReceived', msg => { const row = requests.get(msg.requestId); if (row) row.status = msg.response.status; });
  browser.on('Network.dataReceived', msg => { const row = requests.get(msg.requestId); if (row) row.decodedBytes += msg.dataLength; });
  browser.on('Network.loadingFailed', msg => { if (requests.delete(msg.requestId) && !msg.canceled) metrics.incomplete++; });
  browser.on('Network.loadingFinished', msg => {
    const row = requests.get(msg.requestId);
    if (!row) return;
    requests.delete(msg.requestId);
    const task = (async () => {
      if (!row.recorded) collector.recordHttp({ ...row, end: msg.timestamp * 1000, wireBytes: msg.encodedDataLength });
      if (new URL(row.url).pathname.endsWith('/regime/fills') && new URL(row.url).searchParams.get('paged') === 'true') {
        const body = await browser.call('Network.getResponseBody', { requestId: msg.requestId });
        const parsed = JSON.parse(body.base64Encoded ? Buffer.from(body.body, 'base64').toString() : body.body);
        metrics.pages.push({ rows: parsed.fills?.length, total: parsed.pageInfo?.total, compact: parsed.fills?.every(fill => !('rawExchangeResponse' in fill)), bytes: row.decodedBytes });
      } else if (new URL(row.url).pathname.endsWith('/config') && row.method === 'GET' && row.phase === 'validation') {
        const body = await browser.call('Network.getResponseBody', { requestId: msg.requestId });
        metrics.changedConfigRead = JSON.parse(body.body).totalAllocation === 12345;
      }
    })().catch(() => metrics.incomplete++);
    tasks.add(task);
    task.finally(() => tasks.delete(task));
  });
  const frame = (msg, direction) => {
    const payload = msg.response.payloadData;
    const bytes = msg.response.opcode === 2 ? Buffer.from(payload, 'base64').length : Buffer.byteLength(payload);
    // Socket.IO text events use the 42 prefix. All other frames are counted as
    // protocol traffic, without retaining handshake IDs, values or raw bodies.
    let event = 'protocol';
    if (payload.startsWith('42')) {
      try {
        const name = JSON.parse(payload.slice(2))[0];
        event = ['regime:status', 'regime:change', 'regime:health', 'regime:position', 'trade:event'].includes(name) ? name : 'other';
      } catch { event = 'unparsed'; }
    }
    collector.recordWs({ event, at: msg.timestamp * 1000, bytes, direction, phase: metrics.phase });
  };
  browser.on('Network.webSocketFrameReceived', msg => frame(msg, 'in'));
  browser.on('Network.webSocketFrameSent', msg => frame(msg, 'out'));
  return metrics;
}
async function main(argv = process.argv.slice(2)) {
  let fixture;
  let browser;
  let output;
  try {
    const index = argv.indexOf('--idle-seconds');
    const idleMs = index < 0 ? 60000 : Number(argv[index + 1]) * 1000;
    if (!Number.isFinite(idleMs) || idleMs < 0) throw new Error('invalid idle duration');
    // External sessions are deliberately unsupported: this runner may enroll,
    // mutate fixture configuration and force reconnects only in its own copy.
    if (argv.some(arg => !['--idle-seconds', '--json', ...(index >= 0 ? [argv[index + 1]] : [])].includes(arg))) throw new Error('unsupported argument');
    browser = await startChrome();
    fixture = await startBrowserFixture();
    const metrics = instrument(browser, fixture.baseUrl);
    const result = await runBrowserScenario({ browser, fixture, metrics, idleMs });
    output = { ...auditOutcome(result.checks, metrics.incomplete, idleMs), ...result,
      measurement: { httpWire: 'CDP encodedDataLength includes response headers', httpDecoded: 'CDP dataLength response body', websocket: 'CDP frame payload bytes; framing/compression wire overhead unavailable', fixture: 'real gateway, operator auth, IPC transport and UI; synthetic engine reads/feed; public market/prediction startup disabled' } };
  } catch (error) {
    // Only fixed harness messages are surfaced; gateway/browser exceptions may
    // contain identifiers or response data, and are deliberately not serialized.
    output = { verdict: 'UNVERIFIED', reasons: ['isolated browser scenario unavailable or incomplete'], stage: fixture ? 'scenario' : browser ? 'fixture' : 'browser' };
    const safeReasons = ['fixture UI build failed', 'isolated gateway exited', 'isolated gateway startup timed out', 'fixture enrollment failed', 'invalid idle duration', 'unsupported argument', 'browser content did not become useful before the deadline'];
    if (safeReasons.includes(error.message) || error.message.startsWith('Chrome unavailable;')) output.reasons = [error.message];
  } finally {
    const cleanup = await Promise.allSettled([browser?.stop(), fixture?.stop()]);
    if (cleanup.some(result => result.status === 'rejected')) output = { verdict: 'UNVERIFIED', reasons: ['fixture cleanup incomplete'] };
  }
  console.log(JSON.stringify(output, null, 2));
  return output.verdict === 'PASS' ? 0 : output.verdict === 'FAIL' ? 1 : 2;
}
if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { instrument, auditOutcome, main };
