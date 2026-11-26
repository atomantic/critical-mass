// @ts-check
const TEST_DIR = require('node:path').resolve(__dirname, '../..');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const registerUpdownRoutes = require('../../../src/routes/updown-routes');
const aiSecurity = require('../../../src/ai-security');

const providerOrigin = 'http://localhost:11434';
const otherOrigin = 'https://unlisted.example';
const finalResponse = { choices: [{ message: { content: '{"screenType":"select","category":"market_event","severity":"warning","summary":"fixture"}' } }] };

const installTransport = (t, redirect) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ origin: url.origin, method: options.method, body: options.body });
    return calls.length === 1 && redirect ? Response.redirect(redirect, 307) : Response.json(finalResponse);
  });
  return calls;
};

const analyzeScreenshot = async (provider) => {
  const app = { handlers: {} };
  for (const method of ['get', 'post', 'put', 'delete']) {
    app[method] = (route, handler) => { app.handlers[`${method} ${route}`] = handler; };
  }
  registerUpdownRoutes(app, {
    updownService: {}, candleCache: {}, DATA_DIR: '/synthetic-unused',
    readJSON: () => ({ providers: { fixture: provider } }),
  });
  const req = {
    query: { providerId: 'fixture' }, headers: { 'content-type': 'image/png' },
    async *[Symbol.asyncIterator]() { yield Buffer.from('synthetic private screenshot'); },
  };
  const res = { statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await app.handlers['post /api/updown/screenshot'](req, res);
  return res;
};

const createClassifier = (provider) => {
  const filename = path.join(TEST_DIR, '../src/sentinel/classifier.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, TEST_DIR: path.dirname(filename), URL, AbortSignal, AbortController, setTimeout, clearTimeout,
    require: (name) => {
      if (name === 'path') return path;
      if (name === 'fs/promises') return { readFile: async () => JSON.stringify({ providers: { fixture: provider } }) };
      if (name === '../logger') return { createContextLogger: () => ({ warn: () => {} }) };
      if (name === '../config-utils') return { SENTINEL_DEFAULTS: {} };
      if (name === '../ai-security') return aiSecurity;
      if (name === '../paths') return { DATA_DIR: '/synthetic-data' };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  }, { filename });
  return () => module.exports.classifyByAI({ title: 'Synthetic news', description: 'fixture', source: 'fixture' }, { enabled: true, maxPerHour: 10 });
};

describe('auxiliary AI calls respect the same operator origin grant as toolkit runs', () => {
  for (const caller of ['screenshot', 'sentinel']) {
    for (const scenario of ['ungranted provider', 'ungranted redirect', 'allowed redirect']) {
      it(`${caller}: ${scenario}`, async (t) => {
        const previous = process.env.AI_ALLOWED_ENDPOINTS;
        process.env.AI_ALLOWED_ENDPOINTS = scenario === 'ungranted provider' ? '' : providerOrigin;
        t.after(() => {
          if (previous === undefined) delete process.env.AI_ALLOWED_ENDPOINTS;
          else process.env.AI_ALLOWED_ENDPOINTS = previous;
        });
        const redirect = scenario === 'ungranted redirect' ? `${otherOrigin}/collect` : `${providerOrigin}/final`;
        const calls = installTransport(t, redirect);
        const provider = { type: 'api', enabled: true, endpoint: `${providerOrigin}/v1`, defaultModel: 'fixture' };
        const result = await (caller === 'screenshot' ? analyzeScreenshot(provider) : createClassifier(provider)());
        if (scenario === 'allowed redirect') {
          assert.equal(caller === 'screenshot' ? result.body.success : result.severity, caller === 'screenshot' ? true : 'warning');
          assert.equal(calls.length, 2);
          assert.equal(calls[1].method, 'POST');
          assert.equal(calls[1].body, calls[0].body, 'an authorized redirect retains its request');
        } else {
          assert.equal(caller === 'screenshot' ? result.statusCode : result, caller === 'screenshot' ? (scenario === 'ungranted provider' ? 400 : 502) : null);
          assert.equal(calls.length, scenario === 'ungranted provider' ? 0 : 1);
          assert.ok(calls.every((call) => call.origin === providerOrigin), 'no data may reach an ungranted origin');
        }
      });
    }
  }
});

it('Sentinel and UpDown Vision reach an allowlisted local OpenAI-compatible server', async (t) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url });
    req.resume();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(finalResponse));
  });
  await new Promise((resolve) => server.listen(0, 'localhost', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const origin = `http://localhost:${server.address().port}`;
  const previous = process.env.AI_ALLOWED_ENDPOINTS;
  process.env.AI_ALLOWED_ENDPOINTS = origin;
  t.after(() => {
    if (previous === undefined) delete process.env.AI_ALLOWED_ENDPOINTS;
    else process.env.AI_ALLOWED_ENDPOINTS = previous;
  });

  const provider = { type: 'api', enabled: true, endpoint: `${origin}/v1`, defaultModel: 'fixture' };
  assert.equal((await analyzeScreenshot(provider)).body.success, true);
  assert.equal((await createClassifier(provider)()).severity, 'warning');
  assert.deepEqual(requests, [
    { method: 'POST', path: '/v1/chat/completions' },
    { method: 'POST', path: '/v1/chat/completions' },
  ]);
});
