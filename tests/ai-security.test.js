const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const http = require('http');

const { REDACTED, createAiSecurity, redactSecrets, resolveWorkspace, restoreRedactedValues } = require('../src/ai-security');

const callMiddleware = (middleware, req) => new Promise((resolve, reject) => {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; resolve({ next: false, res: this }); return this; },
  };
  middleware(req, res, (error) => error ? reject(error) : resolve({ next: true, res }));
});

describe('AI toolkit security boundary', () => {
  const providers = {
    api: { id: 'api', type: 'api', endpoint: 'https://api.example.com/v1', apiKey: 'secret', envVars: { SERVICE_CREDENTIAL: 'real' } },
    cli: { id: 'cli', type: 'cli', command: 'codex' },
  };
  const providerService = { getProviderById: async (id) => providers[id] || null };
  const security = createAiSecurity({
    providerService,
    workspaceRoots: [process.cwd()],
    allowedOrigins: new Set(['https://api.example.com']),
  });

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

  it('preserves redacted credentials through provider update middleware', async () => {
    const req = {
      method: 'PUT',
      path: '/api',
      body: { type: 'api', endpoint: 'https://api.example.com/v1', apiKey: REDACTED, envVars: { SERVICE_CREDENTIAL: REDACTED } },
    };
    const result = await callMiddleware(security.guardProviderMutation, req);
    assert.equal(result.next, true);
    assert.equal(req.body.apiKey, 'secret');
    assert.equal(req.body.envVars.SERVICE_CREDENTIAL, 'real');
  });

  it('rejects CLI execution and unapproved outbound origins', async () => {
    const cli = await callMiddleware(security.guardRun, {
      method: 'POST', path: '/', body: { providerId: 'cli', workspacePath: process.cwd() },
    });
    assert.equal(cli.res.statusCode, 400);
    assert.match(cli.res.body.error, /CLI providers are disabled/);

    providers.unknown = { id: 'unknown', type: 'api', endpoint: 'https://metadata.invalid/v1' };
    const endpoint = await callMiddleware(security.guardRun, {
      method: 'POST', path: '/', body: { providerId: 'unknown', workspacePath: process.cwd() },
    });
    assert.equal(endpoint.res.statusCode, 400);
    assert.match(endpoint.res.body.error, /not allowlisted/);
  });

  it('filters blocked providers out of the sample response', async () => {
    const req = { method: 'GET', path: '/samples' };
    const response = await new Promise((resolve) => {
      const res = { json(body) { resolve(body); } };
      security.filterProviderSamples(req, res, () => res.json({ providers: [providers.api, providers.cli] }));
    });
    assert.deepEqual(response.providers.map((provider) => provider.id), ['api']);
  });

  it('blocks a redirect from an allowed provider to an unapproved origin', async () => {
    const target = http.createServer((req, res) => res.end('should not be reached'));
    await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
    let targetReached = false;
    target.removeAllListeners('request');
    target.on('request', (req, res) => { targetReached = true; res.end('unexpected'); });
    const targetUrl = `http://127.0.0.1:${target.address().port}`;

    const redirector = http.createServer((req, res) => {
      res.writeHead(307, { Location: targetUrl });
      res.end();
    });
    await new Promise((resolve) => redirector.listen(0, '127.0.0.1', resolve));
    const redirectUrl = `http://127.0.0.1:${redirector.address().port}`;
    const scopedSecurity = createAiSecurity({
      providerService,
      workspaceRoots: [process.cwd()],
      allowedOrigins: new Set([redirectUrl]),
    });

    const error = await new Promise((resolve) => {
      scopedSecurity.constrainOutboundRequests({}, {}, () => {
        fetch(`${redirectUrl}/start`).then(() => resolve(null)).catch(resolve);
      });
    });
    assert.match(error.message, /redirect origin is not allowlisted/);
    assert.equal(targetReached, false);
    await Promise.all([
      new Promise((resolve) => redirector.close(resolve)),
      new Promise((resolve) => target.close(resolve)),
    ]);
  });

  it('normalizes allowed workspaces and blocks escapes', async () => {
    assert.equal(resolveWorkspace('.', [process.cwd()]), process.cwd());
    const outside = resolveWorkspace(os.tmpdir(), [path.join(process.cwd(), 'data')]);
    assert.equal(outside, null);

    const result = await callMiddleware(security.guardRun, {
      method: 'POST', path: '/', body: { providerId: 'api', workspacePath: process.cwd() },
    });
    assert.equal(result.next, true);
    assert.equal(result.res.statusCode, 200);
  });
});
