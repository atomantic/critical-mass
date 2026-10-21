const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { REDACTED, createAllowlistedFetch, redactSecrets, restoreRedactedValues, validateProvider } = require('../src/ai-security');

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
});
