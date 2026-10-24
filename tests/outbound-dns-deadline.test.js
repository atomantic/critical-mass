// @ts-check
const { it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter, getEventListeners } = require('node:events');
const { setImmediate: nextTurn } = require('node:timers/promises');

const publicAddresses = [{ address: '1.1.1.1', family: 4 }];
const quietLogger = { warn() {}, info() {}, error() {} };

// Load unchanged production source with deterministic DNS/network and shortened
// production deadlines. No live provider files, credentials or sockets are used.
function fixture(lookup = (_host, _opts, cb) => cb(null, publicAddresses)) {
  const timers = new Set();
  const requests = [];
  const held = [];
  const clock = {
    setTimeout(fn, ms) {
      const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms === 15000 || ms === 30000 ? 20 : ms);
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
  };
  const load = (file, overrides = {}) => {
    const filename = path.join(__dirname, '..', file);
    const localRequire = createRequire(filename);
    const module = { exports: {} };
    vm.runInNewContext(readFileSync(filename, 'utf8'), {
      module, __dirname: path.dirname(filename), URL, Buffer, AbortController,
      ...clock,
      require: name => Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name),
    }, { filename });
    return module.exports;
  };
  const transport = {
    request(url, options, receive) {
      requests.push({ url: url.toString(), options });
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => queueMicrotask(() => {
        const res = new EventEmitter();
        res.statusCode = url.pathname === '/redirect' ? 302 : 200;
        res.headers = res.statusCode === 302 ? { location: 'https://slow.example/feed' } : {};
        res.destroy = () => {};
        receive(res);
        res.emit('data', Buffer.from('<rss><channel><item><guid>healthy</guid><title>Trading halt</title></item></channel></rss>'));
        res.emit('end');
      });
      return req;
    },
  };
  const validator = load('src/url-validator.js', { dns: { lookup }, http: transport, https: transport });
  const logger = { createContextLogger: () => quietLogger };
  return { validator, load, clock, timers, requests, held, logger };
}

for (const lateFailure of [false, true]) {
  it('aborts pending DNS, cleans listeners/timers and ignores late ' + (lateFailure ? 'failure' : 'success'), async () => {
    let callback;
    const f = fixture((_host, _opts, cb) => { callback = cb; });
    const controller = new AbortController();
    const result = f.validator.safeFetch('https://slow.example/feed', { signal: controller.signal });
    controller.abort();
    await assert.rejects(result, { name: 'AbortError' });
    assert.equal(f.requests.length, 0);
    assert.equal(f.timers.size, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    callback(lateFailure ? new Error('late DNS failure') : null, publicAddresses);
    await nextTurn();
    assert.equal(f.requests.length, 0);
  });
}

it('rejects already-aborted operations before lookup, including IP literals', async () => {
  let lookups = 0;
  const f = fixture(() => { lookups++; });
  const signal = AbortSignal.abort();
  await assert.rejects(f.validator.validateEndpointUrl('https://slow.example', { signal }), { name: 'AbortError' });
  await assert.rejects(f.validator.safeFetch('https://1.1.1.1', { signal }), { name: 'AbortError' });
  assert.equal(lookups, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.timers.size, 0);
});

it('uses the same caller deadline while validating a redirect target', async () => {
  let callback;
  const f = fixture((host, _opts, cb) => {
    if (host === 'slow.example') callback = cb;
    else cb(null, publicAddresses);
  });
  const controller = new AbortController();
  const result = f.validator.safeFetch('https://fast.example/redirect', { signal: controller.signal });
  await nextTurn();
  assert.equal(typeof callback, 'function');
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
  callback(null, publicAddresses);
  await nextTurn();
  assert.equal(f.requests.length, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

it('cleans validation resources on normal DNS success and failure', async () => {
  for (const error of [null, new Error('resolver unavailable')]) {
    const f = fixture((_host, _opts, cb) => cb(error, publicAddresses));
    const controller = new AbortController();
    const result = await f.validator.validateEndpointUrl('https://example.com', { signal: controller.signal });
    assert.equal(result.valid, !error);
    assert.equal(f.timers.size, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

it('bounds standalone feed configuration validation and returns a useful failure without persisting', async () => {
  let callback;
  const f = fixture((_host, _opts, cb) => { callback = cb; });
  const registerRoutes = f.load('src/routes/sentinel-routes.js', { '../url-validator': f.validator });
  const handlers = {};
  const app = Object.fromEntries(['get', 'put', 'post', 'delete'].map(method => [method, (route, fn) => { handlers[method + route] = fn; }]));
  let persisted = false;
  registerRoutes(app, {
    sentinelService: {}, getSentinelConfig: () => ({}),
    updateSentinelConfig: () => { persisted = true; },
  });
  const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; } };
  await handlers['put/api/sentinel/config']({ body: { feeds: [{ name: 'slow', url: 'https://slow.example/feed' }] } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /DNS validation timed out/i);
  assert.equal(persisted, false);
  assert.equal(f.timers.size, 0);
  callback(new Error('late failure'));
  await nextTurn();
});

it('delivers healthy feed alerts after a DNS timeout and permits another force-poll and restart', async (t) => {
  const callbacks = [];
  const f = fixture((host, _opts, cb) => host === 'slow.example' ? callbacks.push(cb) : cb(null, publicAddresses));
  const poller = f.load('src/sentinel/feed-poller.js', { '../url-validator': f.validator, '../logger': f.logger });
  const { createSentinelService } = require('../src/sentinel/sentinel-service');
  const feeds = [{ name: 'slow', url: 'https://slow.example/feed' }, { name: 'healthy', url: 'https://fast.example/feed' }];
  const service = createSentinelService({ to: () => ({ emit() {} }) }, {
    readJSON: () => null, writeJSON() {}, DATA_DIR: '/synthetic-data',
    getSentinelConfig: () => ({
      enabled: true, pollIntervalMs: 60000, feeds,
      keywords: { critical: ['halt'], warning: [], info: [] }, aiClassification: { enabled: false },
    }),
    fetchAllFeeds: poller.fetchAllFeeds,
  });
  t.after(() => service.stop());
  await service.forcePoll();
  assert.equal(service.getStatus().pollCount, 1);
  assert.equal(service.getStatus().feedState, 'degraded');
  assert.equal(service.getAlerts().length, 1);
  // Test the per-feed abort path separately, before the default DNS budget.
  const timeout = await poller.fetchFeedOutcome(feeds[0], 5);
  assert.equal(timeout.failure, 'timeout');
  await service.forcePoll();
  assert.equal(service.getStatus().pollCount, 2);
  service.start();
  service.stop();
  service.start();
  await service.forcePoll();
  assert.ok(service.getStatus().pollCount >= 3);
  for (const cb of callbacks) cb(null, publicAddresses);
  await nextTurn();
  assert.equal(f.requests.every(r => r.url.includes('fast.example')), true);
  assert.equal(f.timers.size, 0);
});

it('includes preliminary DNS in the screenshot provider deadline without dispatching', async () => {
  let callback;
  const f = fixture((_host, _opts, cb) => { callback = cb; });
  const { createVisionClient } = f.load('src/updown/vision-client.js');
  const client = createVisionClient({ ...f.validator, allowedOrigins: new Set(['https://slow.example']) });
  const result = await client.analyzeScreenshot({
    provider: { endpoint: 'https://slow.example', timeout: 5 }, providerId: 'test',
    model: 'test', imageBuffer: Buffer.from('synthetic'), mediaType: 'image/png', logger: quietLogger,
  });
  assert.equal(result.status, 502);
  assert.match(result.error, /aborted/i);
  callback(null, publicAddresses);
  await nextTurn();
  assert.equal(f.requests.length, 0);
  assert.equal(f.timers.size, 0);
});

it('includes preliminary DNS in the classifier deadline and shares the signal with acquisition', async () => {
  let callback;
  let delay = true;
  const f = fixture((_host, _opts, cb) => delay ? (callback = cb) : cb(null, publicAddresses));
  let validationSignal;
  let acquisitionSignal;
  // Leave the validation default longer so this pins the classifier's own timer.
  const validator = {
    validateEndpointUrl: (url, options) => {
      validationSignal = options.signal;
      return f.validator.validateEndpointUrl(url, { ...options, dnsTimeoutMs: 1000 });
    },
    safeFetch: async (_url, options) => { acquisitionSignal = options.signal; return { ok: false }; },
  };
  const classifier = f.load('src/sentinel/classifier.js', {
    '../url-validator': validator, '../logger': f.logger,
    'fs/promises': { readFile: async () => JSON.stringify({ providers: { test: { enabled: true, type: 'api', endpoint: 'https://slow.example' } } }) },
    '../paths': { DATA_DIR: '/synthetic-data' },
    '../ai-security': { parseAllowedOrigins: () => new Set(['https://slow.example']) },
  });
  assert.equal(await classifier.classifyByAI({ title: 'halt' }, { enabled: true, maxPerHour: 1 }), null);
  assert.equal(validationSignal.aborted, true);
  assert.equal(acquisitionSignal, undefined);
  callback(new Error('late failure'));
  await nextTurn();
  delay = false;
  await classifier.classifyByAI({ title: 'halt' }, { enabled: true, maxPerHour: 1 });
  assert.equal(acquisitionSignal, validationSignal, 'preliminary timeout must not consume dispatch quota or get a fresh deadline');
  assert.equal(f.timers.size, 0);
});
