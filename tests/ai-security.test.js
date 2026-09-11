const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
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

  it('rejects path traversal in run ID sub-routes and allows normal IDs', async () => {
    const traversalPaths = ['/..%2Fcoinbase', '/../backups', '/..%2f..%2f.git'];
    for (const traversalPath of traversalPaths) {
      for (const method of ['GET', 'DELETE']) {
        // eslint-disable-next-line no-await-in-loop
        const result = await callMiddleware(security.guardRun, { method, path: decodeURIComponent(traversalPath) });
        assert.equal(result.res.statusCode, 400, `expected 400 for ${method} ${traversalPath}`);
        assert.match(result.res.body.error, /Invalid run ID/);
      }
    }

    const subRoutes = ['/run-123', '/run-123/output', '/run-123/prompt'];
    for (const subRoute of subRoutes) {
      // eslint-disable-next-line no-await-in-loop
      const result = await callMiddleware(security.guardRun, { method: 'GET', path: subRoute });
      assert.equal(result.next, true, `expected pass-through for GET ${subRoute}`);
    }

    const stop = await callMiddleware(security.guardRun, { method: 'POST', path: '/run-123/stop' });
    assert.equal(stop.next, true);

    const del = await callMiddleware(security.guardRun, { method: 'DELETE', path: '/run-123' });
    assert.equal(del.next, true);

    const badId = await callMiddleware(security.guardRun, { method: 'DELETE', path: '/../etc' });
    assert.equal(badId.res.statusCode, 400);
  });

  it('rejects prompt stage names with path traversal sequences', async () => {
    const traversal = '../../../README';

    const getTemplate = await callMiddleware(security.guardPrompts, { method: 'GET', path: `/stages/${traversal}/template` });
    assert.equal(getTemplate.res.statusCode, 400);
    assert.match(getTemplate.res.body.error, /Stage name must contain only/);

    const put = await callMiddleware(security.guardPrompts, { method: 'PUT', path: `/stages/${traversal}`, body: { template: 'x' } });
    assert.equal(put.res.statusCode, 400);

    const del = await callMiddleware(security.guardPrompts, { method: 'DELETE', path: `/stages/${traversal}` });
    assert.equal(del.res.statusCode, 400);

    const encoded = await callMiddleware(security.guardPrompts, { method: 'GET', path: '/stages/..%2F..%2F..%2FREADME/template' });
    assert.equal(encoded.res.statusCode, 400);

    const create = await callMiddleware(security.guardPrompts, { method: 'POST', path: '/stages', body: { name: traversal } });
    assert.equal(create.res.statusCode, 400);
  });

  it('allows normal prompt stage requests through unmodified', async () => {
    const list = await callMiddleware(security.guardPrompts, { method: 'GET', path: '/stages' });
    assert.equal(list.next, true);

    const get = await callMiddleware(security.guardPrompts, { method: 'GET', path: '/stages/summarize' });
    assert.equal(get.next, true);

    const create = await callMiddleware(security.guardPrompts, { method: 'POST', path: '/stages', body: { name: 'summarize' } });
    assert.equal(create.next, true);

    const variables = await callMiddleware(security.guardPrompts, { method: 'GET', path: '/variables' });
    assert.equal(variables.next, true);
  });

  it('confines HTTP run screenshots before any downstream file reads', async (t) => {
    const express = require('express');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-screenshots-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const screenshotsDir = path.join(temp, 'screenshots');
    fs.mkdirSync(screenshotsDir);
    fs.mkdirSync(path.join(screenshotsDir, 'nested'));
    fs.mkdirSync(path.join(screenshotsDir, 'directory.png'));
    fs.writeFileSync(path.join(screenshotsDir, 'nested', 'image.PNG'), 'image fixture');
    fs.writeFileSync(path.join(screenshotsDir, 'keys.json'), 'secret fixture');
    fs.writeFileSync(path.join(temp, 'outside.png'), 'outside fixture');
    fs.mkdirSync(path.join(temp, 'screenshots-sibling'));
    fs.writeFileSync(path.join(temp, 'screenshots-sibling', 'image.png'), 'outside fixture');
    fs.symlinkSync(path.join(temp, 'outside.png'), path.join(screenshotsDir, 'escape.png'));
    fs.symlinkSync(path.join(screenshotsDir, 'keys.json'), path.join(screenshotsDir, 'keys.png'));
    fs.symlinkSync(path.join(temp, 'missing.png'), path.join(screenshotsDir, 'broken.png'));
    fs.symlinkSync(path.join(temp, 'screenshots-sibling'), path.join(screenshotsDir, 'escape-dir'));
    fs.symlinkSync(path.join(screenshotsDir, 'nested', 'image.PNG'), path.join(screenshotsDir, 'safe.png'));
    const scopedSecurity = createAiSecurity({
      providerService, workspaceRoots: [temp], screenshotsDir,
      allowedOrigins: new Set(['https://api.example.com']),
    });
    let reads = 0;
    const app = express();
    app.use(express.json());
    app.use('/api/runs', scopedSecurity.guardRun);
    app.post('/api/runs', (req, res) => {
      for (const image of req.body.screenshots || []) {
        fs.readFileSync(image);
        reads += 1;
      }
      res.json({ screenshots: req.body.screenshots });
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const post = (screenshots) => fetch(`http://127.0.0.1:${server.address().port}/api/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'api', workspacePath: temp, screenshots }),
    });
    const invalid = [
      null, 'image.png', {}, [1], [''], Array(11).fill('safe.png'),
      ['../outside.png'], ['nested/../safe.png'], ['nested//image.PNG'],
      ['./safe.png'], ['safe.png/'], ['bad\0.png'], ['..\\outside.png'],
      [path.join(temp, 'outside.png')], [path.join(temp, 'screenshots-sibling', 'image.png')],
      ['keys.json'], ['keys.png'], ['escape.png'], ['escape-dir/image.png'],
      ['broken.png'], ['missing.png'], ['directory.png'], ['safe.png', 'escape.png'],
    ];
    for (const screenshots of invalid) {
      const response = await post(screenshots);
      assert.equal(response.status, 400, JSON.stringify(screenshots));
      await response.arrayBuffer();
      assert.equal(reads, 0);
    }
    for (const screenshots of [undefined, [], ['nested/image.PNG'], ['safe.png'], [path.join(screenshotsDir, 'safe.png')]]) {
      const response = await post(screenshots);
      assert.equal(response.status, 200);
      const body = await response.json();
      if (screenshots?.length) {
        assert.deepEqual(body.screenshots, [fs.realpathSync(path.join(screenshotsDir, 'safe.png'))]);
      }
    }
    assert.equal(reads, 3);
    fs.renameSync(screenshotsDir, path.join(temp, 'moved'));
    const missingRoot = await post(['safe.png']);
    assert.equal(missingRoot.status, 400);
    await missingRoot.arrayBuffer();
    assert.equal(reads, 3);
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
