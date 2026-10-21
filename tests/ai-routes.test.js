// @ts-check
/**
 * HTTP contract of the owned /api/providers and /api/runs routes the admin AI
 * Providers page (Providers.jsx, runLifecycle.mjs) depends on, exercised over
 * real requests against a fake OpenAI-compatible provider on loopback.
 */
const { after, before, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const mountAiRoutes = require('../src/routes/ai-routes');
const { errorMiddleware } = require('../src/error-middleware');
const { REDACTED } = require('../src/ai-security');

/** @param {http.RequestListener} handler */
const listen = async (handler) => {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('net').AddressInfo} */ (server.address());
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }),
  };
};

const waitFor = async (predicate, label) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
};

describe('owned AI provider and run routes', () => {
  /** @type {Record<string, (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void>} */
  let providerBehavior = {};
  /** @type {{ url?: string, auth?: string, body?: any }[]} */
  let providerRequests = [];
  let provider, blocked, gateway, dataDir, base;

  const api = async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* text/plain or empty */ }
    return { status: response.status, json, text };
  };
  const readProvidersFile = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'providers.json'), 'utf8'));
  const writeProvidersFile = (data) => fs.writeFileSync(path.join(dataDir, 'providers.json'), JSON.stringify(data));
  const apiProvider = (overrides = {}) => ({
    name: 'Fixture', type: 'api', endpoint: `${provider.origin}/v1`, apiKey: 'sk-fixture', models: ['m1'], defaultModel: 'm1', ...overrides,
  });

  before(async () => {
    provider = await listen((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        providerRequests.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined });
        const behavior = providerBehavior[req.url || ''];
        if (behavior) return behavior(req, res, body);
        res.writeHead(404).end('{}');
      });
    });
    blocked = await listen((req, res) => res.end('{"data":[{"id":"leaked"}]}'));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-routes-'));
    const app = express();
    app.use(express.json());
    mountAiRoutes(/** @type {any} */ (app), { DATA_DIR: dataDir }, { allowedOrigins: new Set([provider.origin]), maxConcurrentRuns: 1 });
    app.use(errorMiddleware);
    gateway = await listen(app);
    base = gateway.origin;
  });

  after(async () => {
    await Promise.all([provider.close(), blocked.close(), gateway.close()]);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    providerBehavior = {};
    providerRequests = [];
    fs.rmSync(path.join(dataDir, 'providers.json'), { force: true });
    fs.rmSync(path.join(dataDir, 'runs'), { recursive: true, force: true });
  });

  it('starts empty without writing a providers file', async () => {
    const res = await api('/api/providers');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { activeProvider: null, providers: [] });
    assert.equal(fs.existsSync(path.join(dataDir, 'providers.json')), false);
    assert.equal((await api('/api/providers/active')).json, null);
  });

  it('creates, redacts, updates, activates and deletes API providers', async () => {
    const created = await api('/api/providers', { method: 'POST', body: apiProvider({ extra: 'dropped' }) });
    assert.equal(created.status, 201);
    assert.equal(created.json.id, 'fixture');
    assert.equal(created.json.apiKey, REDACTED);
    assert.equal(created.json.extra, undefined);
    assert.equal(readProvidersFile().providers.fixture.apiKey, 'sk-fixture');
    assert.equal(readProvidersFile().activeProvider, 'fixture', 'first provider becomes active');
    assert.equal((await api('/api/providers', { method: 'POST', body: apiProvider() })).status, 409);

    // The admin enable toggle echoes the whole redacted record back.
    const listed = (await api('/api/providers')).json.providers[0];
    assert.equal(listed.apiKey, REDACTED);
    const toggled = await api('/api/providers/fixture', { method: 'PUT', body: { ...listed, enabled: false } });
    assert.equal(toggled.status, 200);
    assert.equal(toggled.json.enabled, false);
    assert.equal(readProvidersFile().providers.fixture.apiKey, 'sk-fixture', 'redaction marker never overwrites the key');

    assert.equal((await api('/api/providers', { method: 'POST', body: apiProvider({ id: 'second', name: 'Second' }) })).status, 201);
    const activated = await api('/api/providers/AcTiVe/', { method: 'PUT', body: { id: 'second' } });
    assert.equal(activated.status, 200);
    assert.equal(activated.json.apiKey, REDACTED);
    assert.equal(readProvidersFile().activeProvider, 'second');
    assert.equal((await api('/api/providers/active', { method: 'PUT', body: {} })).status, 400);
    assert.equal((await api('/api/providers/active', { method: 'PUT', body: { id: 'missing' } })).status, 404);

    assert.equal((await api('/api/providers/second', { method: 'DELETE' })).status, 204);
    assert.equal(readProvidersFile().activeProvider, 'fixture', 'deleting the active provider promotes another');
    assert.equal((await api('/api/providers/second', { method: 'DELETE' })).status, 404);
    assert.equal((await api('/api/providers/second')).status, 404);
  });

  it('rejects CLI, non-allowlisted, credentialed and malformed providers', async () => {
    const cases = [
      [{ ...apiProvider(), type: 'cli', command: 'sh' }, /CLI providers are not supported/],
      [apiProvider({ endpoint: `${blocked.origin}/v1` }), /not allowlisted/],
      [apiProvider({ endpoint: provider.origin.replace('http://', 'http://u:p@') }), /credentials/],
      [apiProvider({ name: '' }), /Name must be/],
      [apiProvider({ timeout: 5 }), /Timeout/],
      [apiProvider({ models: 'm1' }), /Models/],
      [apiProvider({ id: '../escape' }), /Provider ID/],
      [apiProvider({ id: '__proto__' }), /Provider ID/],
    ];
    for (const [body, error] of cases) {
      const res = await api('/api/providers', { method: 'POST', body });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.json.error, error);
    }
    assert.equal(fs.existsSync(path.join(dataDir, 'providers.json')), false);
  });

  it('lists legacy CLI records for deletion but never contacts or runs them', async () => {
    writeProvidersFile({ activeProvider: 'claude-code', providers: { 'claude-code': { id: 'claude-code', type: 'cli', command: 'claude', enabled: true } } });
    assert.equal((await api('/api/providers')).json.providers[0].id, 'claude-code');
    for (const suffix of ['test', 'TeSt', 'refresh-models', 'ReFrEsH-MoDeLs/']) {
      const res = await api(`/api/providers/claude-code/${suffix}`, { method: 'POST' });
      assert.equal(res.status, 400, suffix);
    }
    assert.equal((await api('/api/runs', { method: 'POST', body: { providerId: 'claude-code', prompt: 'hi' } })).status, 400);
    assert.equal((await api('/api/providers/claude-code', { method: 'PUT', body: { enabled: false } })).status, 400);
    assert.equal((await api('/api/providers/claude-code', { method: 'DELETE' })).status, 204);
  });

  it('refuses to treat a corrupt providers file as empty', async () => {
    fs.writeFileSync(path.join(dataDir, 'providers.json'), '{ not json');
    assert.equal((await api('/api/providers')).status, 500);
    assert.equal((await api('/api/providers', { method: 'POST', body: apiProvider() })).status, 500);
    assert.equal(fs.readFileSync(path.join(dataDir, 'providers.json'), 'utf8'), '{ not json');
  });

  it('offers only allowlisted API samples and keeps a sample key through the redacted echo', async () => {
    const samplesFile = path.join(__dirname, '../src/ai/providers.sample.json');
    const samples = JSON.parse(fs.readFileSync(samplesFile, 'utf8')).providers;
    assert.ok(Object.values(samples).every((sample) => sample.type === 'api'));
    // No sample endpoint is allowlisted in this fixture, so none are offered.
    assert.deepEqual((await api('/api/providers/samples')).json, { providers: [] });

    const localApp = express();
    localApp.use(express.json());
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-samples-'));
    mountAiRoutes(/** @type {any} */ (localApp), { DATA_DIR: localDir }, { allowedOrigins: new Set(['http://localhost:1234']) });
    localApp.use(errorMiddleware);
    const local = await listen(localApp);
    try {
      const offered = await (await fetch(`${local.origin}/api/providers/SaMpLeS/`)).json();
      assert.deepEqual(offered.providers.map((sample) => sample.id), ['lmstudio']);
      assert.equal(offered.providers[0].apiKey, REDACTED);
      const created = await fetch(`${local.origin}/api/providers`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(offered.providers[0]),
      });
      assert.equal(created.status, 201);
      const stored = JSON.parse(fs.readFileSync(path.join(localDir, 'providers.json'), 'utf8'));
      assert.equal(stored.providers.lmstudio.apiKey, 'lm-studio');
      assert.deepEqual((await (await fetch(`${local.origin}/api/providers/samples`)).json()).providers, []);
    } finally {
      await local.close();
      fs.rmSync(localDir, { recursive: true, force: true });
    }
  });

  it('tests connectivity and refreshes models through the allowlist', async () => {
    providerBehavior['/v1/models'] = (req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }));
    await api('/api/providers', { method: 'POST', body: apiProvider({ id: 'MiXeD' }) });

    const tested = await api('/api/providers/MiXeD/TeSt', { method: 'POST' });
    assert.equal(tested.status, 200);
    assert.deepEqual(tested.json, { success: true, endpoint: `${provider.origin}/v1`, models: ['a', 'b'] });
    assert.equal(providerRequests[0].auth, 'Bearer sk-fixture');

    const refreshed = await api('/api/providers/MiXeD/refresh-models/', { method: 'POST' });
    assert.equal(refreshed.status, 200);
    assert.deepEqual(refreshed.json.models, ['a', 'b']);
    assert.equal(refreshed.json.apiKey, REDACTED);
    assert.deepEqual(readProvidersFile().providers.MiXeD.models, ['a', 'b']);

    providerBehavior['/v1/models'] = (req, res) => res.writeHead(503).end('down');
    const failedTest = await api('/api/providers/MiXeD/test', { method: 'POST' });
    assert.deepEqual(failedTest.json, { success: false, error: 'API not reachable: HTTP 503' });
    const failedRefresh = await api('/api/providers/MiXeD/refresh-models', { method: 'POST' });
    assert.equal(failedRefresh.status, 502);
    assert.match(failedRefresh.json.error, /Model refresh failed: API not reachable: HTTP 503/);
    assert.deepEqual(readProvidersFile().providers.MiXeD.models, ['a', 'b'], 'a failed refresh keeps the stored list');

    providerBehavior['/v1/models'] = (req, res) => res.writeHead(302, { Location: `${blocked.origin}/v1/models` }).end();
    assert.match((await api('/api/providers/MiXeD/test', { method: 'POST' })).json.error, /redirect origin is not allowlisted/);
    assert.equal((await api('/api/providers/missing/test', { method: 'POST' })).status, 404);
  });

  it('streams a run to disk and serves the run lifecycle contract', async () => {
    // SSE events split mid-line across writes, with reasoning and keep-alive noise.
    providerBehavior['/v1/chat/completions'] = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"reasoning":"think "}}]}\n\n: keep-alive\n\ndata: {"choices":[{"del');
      setTimeout(() => {
        res.write('ta":{"content":"Hello"}}]}\n\ndata: not-json\n\ndata: {"choices":[{"delta":{"content":", world"}}]}\n\n');
        res.end('data: [DONE]\n\n');
      }, 20);
    };
    await api('/api/providers', { method: 'POST', body: apiProvider() });

    const started = await api('/api/runs', { method: 'POST', body: { providerId: 'fixture', prompt: 'Say hello' } });
    assert.equal(started.status, 202);
    assert.equal(started.json.status, 'started');
    const { runId } = started.json;
    assert.match(runId, /^[0-9a-f-]{36}$/);

    await waitFor(async () => (await api(`/api/runs/${runId}`)).json.endTime, 'run completion');
    const meta = (await api(`/api/runs/${runId}`)).json;
    assert.equal(meta.success, true);
    assert.equal(meta.isActive, false);
    assert.equal(meta.providerName, 'Fixture');
    assert.equal(meta.model, 'm1');
    assert.equal(meta.hadReasoning, true);
    assert.equal((await api(`/api/runs/${runId}/output`)).text, 'Hello, world');
    assert.equal((await api(`/api/runs/${runId}/prompt`)).text, 'Say hello');
    assert.deepEqual(providerRequests[0].body, { model: 'm1', messages: [{ role: 'user', content: 'Say hello' }], stream: true });

    const listed = (await api('/api/runs?limit=20')).json;
    assert.equal(listed.total, 1);
    assert.equal(listed.runs[0].id, runId);

    for (const route of [`/api/runs/..%2Fproviders.json`, '/api/runs/bad.id/output', '/api/runs/x%00/prompt']) {
      assert.equal((await api(route)).status, 400, route);
    }
    assert.equal((await api('/api/runs/unknown-run')).status, 404);
    assert.equal((await api('/api/runs/unknown-run/output')).status, 404);
    assert.equal((await api('/api/runs/unknown-run/stop', { method: 'POST' })).status, 404);

    assert.equal((await api(`/api/runs/${runId}`, { method: 'DELETE' })).status, 204);
    assert.equal((await api(`/api/runs/${runId}`)).status, 404);
  });

  it('uses reasoning as output for reasoning-only models and reads non-streamed bodies', async () => {
    providerBehavior['/v1/chat/completions'] = (req, res) => res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ choices: [{ message: { content: '', reasoning_content: 'only thoughts' } }] }));
    await api('/api/providers', { method: 'POST', body: apiProvider() });
    const { runId } = (await api('/api/runs', { method: 'POST', body: { providerId: 'fixture', prompt: 'p', model: 'm2' } })).json;
    await waitFor(async () => (await api(`/api/runs/${runId}`)).json.endTime, 'run completion');
    const meta = (await api(`/api/runs/${runId}`)).json;
    assert.equal(meta.usedReasoningAsFallback, true);
    assert.equal(meta.model, 'm2');
    assert.equal((await api(`/api/runs/${runId}/output`)).text, 'only thoughts');
  });

  it('records provider errors and redirects as failed runs, and bulk-deletes them', async () => {
    providerBehavior['/v1/chat/completions'] = (req, res) => res.writeHead(429).end('{"error":"rate limited"}');
    await api('/api/providers', { method: 'POST', body: apiProvider() });
    const first = (await api('/api/runs', { method: 'POST', body: { providerId: 'fixture', prompt: 'p' } })).json.runId;
    await waitFor(async () => (await api(`/api/runs/${first}`)).json.endTime, 'failed run');
    const failed = (await api(`/api/runs/${first}`)).json;
    assert.equal(failed.success, false);
    assert.match(failed.error, /API error: HTTP 429 — \{"error":"rate limited"\}/);

    providerBehavior['/v1/chat/completions'] = (req, res) => res.writeHead(307, { Location: `${blocked.origin}/v1/chat/completions` }).end();
    const second = (await api('/api/runs', { method: 'POST', body: { providerId: 'fixture', prompt: 'p' } })).json.runId;
    await waitFor(async () => (await api(`/api/runs/${second}`)).json.endTime, 'redirected run');
    assert.match((await api(`/api/runs/${second}`)).json.error, /redirect origin is not allowlisted/);

    assert.equal((await api('/api/runs', { method: 'DELETE' })).status, 400);
    assert.deepEqual((await api('/api/runs?filter=failed', { method: 'DELETE' })).json, { deletedCount: 2 });
    assert.equal((await api('/api/runs')).json.total, 0);
  });

  it('validates run requests, enforces the concurrency limit and stops a live run', async () => {
    let release;
    providerBehavior['/v1/chat/completions'] = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      release = () => res.end();
    };
    await api('/api/providers', { method: 'POST', body: apiProvider() });
    await api('/api/providers', { method: 'POST', body: apiProvider({ id: 'off', name: 'Off', enabled: false }) });

    assert.match((await api('/api/runs', { method: 'POST', body: { prompt: 'p' } })).json.error, /providerId is required/);
    assert.match((await api('/api/runs', { method: 'POST', body: { providerId: 'fixture', prompt: '  ' } })).json.error, /prompt is required/);
    assert.equal((await api('/api/runs', { method: 'POST', body: { providerId: 'missing', prompt: 'p' } })).status, 404);
    assert.match((await api('/api/runs', { method: 'POST', body: { providerId: 'off', prompt: 'p' } })).json.error, /disabled/);

    const { runId } = (await api('/api/runs', { method: 'POST', body: { providerId: 'fixture', prompt: 'p' } })).json;
    await waitFor(() => providerRequests.length === 1, 'provider request');
    assert.equal((await api(`/api/runs/${runId}`)).json.isActive, true);
    assert.equal((await api('/api/runs', { method: 'POST', body: { providerId: 'fixture', prompt: 'again' } })).status, 429);
    assert.equal((await api(`/api/runs/${runId}`, { method: 'DELETE' })).status, 409);

    const stopped = await api(`/api/runs/${runId}/stop`, { method: 'POST' });
    assert.deepEqual(stopped.json, { success: true });
    // The terminal record is written before the stop is acknowledged.
    const meta = (await api(`/api/runs/${runId}`)).json;
    assert.equal(meta.isActive, false);
    assert.equal(meta.success, false);
    assert.equal(meta.error, 'Run stopped by operator');
    assert.equal((await api(`/api/runs/${runId}/stop`, { method: 'POST' })).status, 404);
    release?.();
  });

  it('times a run out at the provider timeout', async () => {
    providerBehavior['/v1/chat/completions'] = (req, res) => res.writeHead(200, { 'Content-Type': 'text/event-stream' }).write(': waiting\n\n');
    await api('/api/providers', { method: 'POST', body: apiProvider() });
    const { runId } = (await api('/api/runs', { method: 'POST', body: { providerId: 'fixture', prompt: 'p', timeout: 1000 } })).json;
    await waitFor(async () => (await api(`/api/runs/${runId}`)).json.endTime, 'timeout');
    assert.equal((await api(`/api/runs/${runId}`)).json.error, 'Run timed out after 1s');
    assert.equal((await api('/api/runs', { method: 'POST', body: { providerId: 'fixture', prompt: 'p', timeout: 10 } })).status, 400);
  });
});
