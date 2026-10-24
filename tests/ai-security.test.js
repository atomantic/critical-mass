const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { MAX_RESPONSE_BYTES, REDACTED, createAllowlistedFetch, redactSecrets, restoreRedactedValues, validateProvider } = require('../src/ai-security');

const listen = async (handler) => {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
};

describe('AI provider security policy', () => {
  const allowed = new Set(['https://api.example.com']);

  it('redacts provider secrets recursively', () => {
    assert.deepEqual(redactSecrets({ provider: { apiKey: 'secret', secretEnvVars: ['SERVICE_CREDENTIAL'], envVars: { OPENAI_API_KEY: 'nested', SERVICE_CREDENTIAL: 'declared', SAFE_MODE: '1' }, name: 'safe' }, token: 'other' }), {
      provider: { apiKey: REDACTED, secretEnvVars: ['SERVICE_CREDENTIAL'], envVars: { OPENAI_API_KEY: REDACTED, SERVICE_CREDENTIAL: REDACTED, SAFE_MODE: '1' }, name: 'safe' },
      token: REDACTED,
    });
  });

  it('restores redacted nested values before provider updates', () => {
    const existing = { apiKey: 'real-key', envVars: { SERVICE_CREDENTIAL: 'real-credential', SAFE_MODE: '1' } };
    const incoming = { apiKey: REDACTED, envVars: { SERVICE_CREDENTIAL: REDACTED, SAFE_MODE: '0' } };
    assert.deepEqual(restoreRedactedValues(incoming, existing), {
      apiKey: 'real-key',
      envVars: { SERVICE_CREDENTIAL: 'real-credential', SAFE_MODE: '0' },
    });
  });

  it('accepts only allowlisted http(s) API providers without endpoint credentials', () => {
    assert.equal(validateProvider({ type: 'api', endpoint: 'https://api.example.com/v1' }, allowed), null);
    assert.match(validateProvider({ type: 'cli', command: 'codex' }, allowed), /CLI providers are not supported/);
    assert.match(validateProvider({ type: 'other' }, allowed), /type must be api/);
    assert.match(validateProvider(null, allowed), /type must be api/);
    assert.match(validateProvider({ type: 'api', endpoint: 'not a url' }, allowed), /valid URL/);
    assert.match(validateProvider({ type: 'api', endpoint: 'https://user:pw@api.example.com/v1' }, allowed), /credentials/);
    assert.match(validateProvider({ type: 'api', endpoint: 'https://metadata.invalid/v1' }, allowed), /not allowlisted/);
    assert.match(validateProvider({ type: 'api', endpoint: 'file:///etc/passwd' }, new Set(['null'])), /http or https/);
  });

  it('refuses a non-allowlisted origin before contacting it', async () => {
    let calls = 0;
    const guarded = createAllowlistedFetch(allowed, async () => { calls += 1; return new Response('unexpected'); });
    await assert.rejects(guarded('https://metadata.invalid/v1/models'), /origin is not allowlisted/);
    assert.equal(calls, 0);
  });

  it('blocks a redirect from an allowed provider to an unapproved origin', async (t) => {
    let targetReached = false;
    const target = await listen((req, res) => { targetReached = true; res.end('unexpected'); });
    t.after(target.close);
    const redirector = await listen((req, res) => {
      res.writeHead(307, { Location: `${target.origin}/models` });
      res.end();
    });
    t.after(redirector.close);

    const guarded = createAllowlistedFetch(new Set([redirector.origin]));
    await assert.rejects(guarded(`${redirector.origin}/start`), /redirect origin is not allowlisted/);
    assert.equal(targetReached, false);
  });

  it('follows allowlisted redirects and drops Authorization across origins', async (t) => {
    const seen = [];
    const target = await listen((req, res) => { seen.push({ method: req.method, auth: req.headers.authorization }); res.end('ok'); });
    t.after(target.close);
    const redirector = await listen((req, res) => {
      seen.push({ method: req.method, auth: req.headers.authorization });
      res.writeHead(303, { Location: `${target.origin}/done` });
      res.end();
    });
    t.after(redirector.close);

    const guarded = createAllowlistedFetch(new Set([redirector.origin, target.origin]));
    const response = await guarded(`${redirector.origin}/start`, { method: 'POST', body: 'x', headers: { Authorization: 'Bearer secret' } });
    assert.equal(await response.text(), 'ok');
    assert.deepEqual(seen, [{ method: 'POST', auth: 'Bearer secret' }, { method: 'GET', auth: undefined }]);
  });

  for (const contentLength of [undefined, '1', String(MAX_RESPONSE_BYTES + 1000000)]) {
    it(`bounds streamed bytes despite Content-Length=${contentLength}`, async () => {
      let emitted = 0;
      let cancelled = 0;
      let cancellationReason;
      const chunk = Buffer.from('é'.repeat(32 * 1024));
      const guarded = createAllowlistedFetch(allowed, async () => new Response(new ReadableStream({
        pull(controller) { emitted += chunk.byteLength; controller.enqueue(chunk); },
        cancel(reason) { cancelled += 1; cancellationReason = reason; },
      }, { highWaterMark: 0 }), { headers: contentLength ? { 'Content-Length': contentLength } : {} }));
      const response = await guarded('https://api.example.com/models');
      assert.equal(emitted, 0, 'wrapper does not eagerly accumulate a body');
      await assert.rejects(response.text(), /response exceeded 20971520 bytes \(20 MiB\)/);
      assert.equal(emitted, MAX_RESPONSE_BYTES + chunk.byteLength);
      assert.equal(cancelled, 1);
      assert.match(cancellationReason.message, /response exceeded/);
    });
  }

  it('accepts exactly 20 MiB and preserves response metadata and empty bodies', async () => {
    let emitted = 0;
    let cancelled = false;
    const chunk = new Uint8Array(64 * 1024).fill(120);
    const source = new Response(new ReadableStream({
      pull(controller) {
        if (emitted === MAX_RESPONSE_BYTES) return controller.close();
        emitted += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() { cancelled = true; },
    }), { status: 201, statusText: 'Created', headers: { 'Content-Type': 'text/plain' } });
    Object.defineProperty(source, 'url', { value: 'https://api.example.com/final' });
    const guarded = createAllowlistedFetch(allowed, async () => source);
    const response = await guarded('https://api.example.com/models');
    assert.equal(response.status, 201);
    assert.equal(response.statusText, 'Created');
    assert.equal(response.headers.get('content-type'), 'text/plain');
    assert.equal(response.url, source.url);
    assert.equal((await response.arrayBuffer()).byteLength, MAX_RESPONSE_BYTES);
    assert.equal(cancelled, false);
    const empty = createAllowlistedFetch(allowed, async () => new Response(null, { status: 204 }));
    assert.equal((await empty('https://api.example.com/models')).body, null);
  });

  it('propagates caller body cancellation to the upstream reader', async () => {
    let reason;
    const guarded = createAllowlistedFetch(allowed, async () => new Response(new ReadableStream({
      cancel(value) { reason = value; },
    })));
    const response = await guarded('https://api.example.com/models');
    await response.body.cancel('consumer stopped');
    assert.equal(reason, 'consumer stopped');
  });

  it('aborts a pending read even when the upstream ignores the request signal', async () => {
    let cancelled = false;
    const controller = new AbortController();
    const guarded = createAllowlistedFetch(allowed, async () => new Response(new ReadableStream({
      pull() { /* stalled peer */ },
      cancel() { cancelled = true; },
    })));
    const response = await guarded('https://api.example.com/models', { signal: controller.signal });
    const pending = response.text();
    controller.abort(new Error('caller aborted'));
    await assert.rejects(pending, /caller aborted/);
    assert.equal(cancelled, true);
  });

  it('reports overflow without waiting for a stalled upstream cancellation', async () => {
    let cancelled = false;
    const guarded = createAllowlistedFetch(allowed, async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES + 1)); },
      cancel() { cancelled = true; return new Promise(() => {}); },
    }, { highWaterMark: 0 })));
    const response = await guarded('https://api.example.com/models');
    await assert.rejects(response.json(), /response exceeded/);
    assert.equal(cancelled, true);
  });

});
