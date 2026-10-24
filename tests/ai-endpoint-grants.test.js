// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const registerUpdownRoutes = require('../src/routes/updown-routes');
const { parseAllowedOrigins } = require('../src/ai-security');
const { safeFetch, validateEndpointUrl } = require('../src/url-validator');

// Public IP literals avoid DNS. The production safeFetch runs against a fake
// HTTP transport, so neither test endpoints nor live providers are contacted.
const providerOrigin = 'https://8.8.8.8';
const otherOrigin = 'https://1.1.1.1';
const provider = { type: 'api', enabled: true, endpoint: `${providerOrigin}/v1`, defaultModel: 'fixture' };
const finalResponse = JSON.stringify({ choices: [{ message: { content: '{"screenType":"select","category":"market_event","severity":"warning","summary":"fixture"}' } }] });

const installTransport = (t, redirect) => {
  const calls = [];
  t.mock.method(require('node:https'), 'request', (url, options, callback) => {
    const call = { origin: url.origin, method: options.method, body: '' };
    calls.push(call);
    const req = new EventEmitter();
    req.write = (body) => { call.body += body; };
    req.end = () => {
      const isRedirect = calls.length === 1 && redirect;
      const res = new EventEmitter();
      res.statusCode = isRedirect ? 307 : 200;
      res.headers = isRedirect ? { location: redirect } : {};
      res.destroy = () => {};
      queueMicrotask(() => {
        callback(res);
        res.emit('data', Buffer.from(isRedirect ? '' : finalResponse));
        res.emit('end');
      });
    };
    return req;
  });
  return calls;
};

const analyzeScreenshot = async () => {
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

const createClassifier = () => {
  const filename = path.join(__dirname, '../src/sentinel/classifier.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, __dirname: path.dirname(filename), URL, AbortSignal, AbortController, setTimeout, clearTimeout,
    require: (name) => {
      if (name === 'path') return path;
      if (name === 'fs/promises') return { readFile: async () => JSON.stringify({ providers: { fixture: provider } }) };
      if (name === '../logger') return { createContextLogger: () => ({ warn: () => {} }) };
      if (name === '../config-utils') return { SENTINEL_DEFAULTS: {} };
      if (name === '../ai-security') return { parseAllowedOrigins };
      if (name === '../paths') return { DATA_DIR: '/synthetic-data' };
      if (name === '../url-validator') return { safeFetch, validateEndpointUrl };
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
        const run = caller === 'screenshot' ? analyzeScreenshot : createClassifier();
        const result = await run();
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
