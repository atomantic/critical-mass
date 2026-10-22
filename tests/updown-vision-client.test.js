// @ts-check
/**
 * Unit tests for src/updown/vision-client.js — the screenshot vision-provider
 * request builder/sender, exercised without Express (issue #1326).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  createVisionClient,
  parseExtractedResponse,
  applyExpiry,
  parseFiniteNumber,
  VISION_PROMPT,
} = require('../src/updown/vision-client');

const makeLogger = () => {
  const calls = { info: [], warn: [], error: [] };
  return {
    calls,
    info: (m, d) => calls.info.push([m, d]),
    warn: (m, d) => calls.warn.push([m, d]),
    error: (m, d) => calls.error.push([m, d]),
  };
};

const okResponse = (content) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content } }] }),
});

const makeClient = ({ validate, fetchImpl } = {}) => {
  const origins = new Set(['https://ai.example.com']);
  const fetchCalls = [];
  const client = createVisionClient({
    validateEndpointUrl: validate || (async () => ({ valid: true })),
    safeFetch: async (url, opts) => {
      fetchCalls.push({ url, opts });
      return fetchImpl ? fetchImpl(url, opts) : okResponse('{"screenType":"select"}');
    },
    allowedOrigins: origins,
  });
  return { client, fetchCalls, origins };
};

const baseArgs = (logger) => ({
  provider: { endpoint: 'https://ai.example.com/v1', apiKey: 'sk-test' },
  providerId: 'p1',
  model: 'vision-1',
  imageBuffer: Buffer.from('imgbytes'),
  mediaType: 'image/png',
  logger,
});

describe('parseFiniteNumber', () => {
  it('accepts finite numbers and numeric strings, rejects junk', () => {
    assert.equal(parseFiniteNumber(5), 5);
    assert.equal(parseFiniteNumber(' 12.5 '), 12.5);
    assert.ok(Number.isNaN(parseFiniteNumber('12abc')));
    assert.ok(Number.isNaN(parseFiniteNumber('')));
    assert.ok(Number.isNaN(parseFiniteNumber(true)));
    assert.ok(Number.isNaN(parseFiniteNumber([1])));
    assert.ok(Number.isNaN(parseFiniteNumber(Infinity)));
  });
});

describe('parseExtractedResponse', () => {
  it('strips think tags, fences and preamble, then sanitizes', () => {
    const reply = '<think>hmm {"x":1}</think>Here you go:\n```json\n{"screenType":"order","direction":"Up","contracts":"3","evil":"x"}\n```';
    assert.deepEqual(parseExtractedResponse(reply), { screenType: 'order', direction: 'Up', contracts: 3 });
  });

  it('throws when no JSON object is present', () => {
    assert.throws(() => parseExtractedResponse('no json here'), /No JSON object found/);
  });

  it('throws on malformed JSON', () => {
    assert.throws(() => parseExtractedResponse('{not json}'));
  });
});

describe('applyExpiry', () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);

  it('converts a relative expiresIn offset', () => {
    const out = applyExpiry({ expiresIn: '1d 2h 30m' }, now);
    assert.equal(out.expiryMs, now + 86400000 + 2 * 3600000 + 30 * 60000);
    assert.equal(out.expiryISO, new Date(out.expiryMs).toISOString());
  });

  it('falls back to an absolute expiresOn date', () => {
    const out = applyExpiry({ expiresOn: 'Feb 28, 2026 at 1:00:00 AM' }, now);
    assert.equal(out.expiryMs, new Date('Feb 28, 2026 1:00:00 AM').getTime());
  });

  it('does not override a relative expiry with expiresOn, and ignores unparseable input', () => {
    const rel = applyExpiry({ expiresIn: '5m', expiresOn: 'Feb 28, 2026 at 1:00:00 AM' }, now);
    assert.equal(rel.expiryMs, now + 5 * 60000);
    const none = applyExpiry({ expiresIn: 'soon', expiresOn: 'garbage' }, now);
    assert.equal(none.expiryMs, undefined);
  });
});

describe('createVisionClient.analyzeScreenshot', () => {
  it('builds an OpenAI-compatible request and returns sanitized extracted fields', async () => {
    const { client, fetchCalls, origins } = makeClient({
      fetchImpl: () => okResponse('{"screenType":"position","direction":"Down","entryPrice":"65000","expiresIn":"2h"}'),
    });
    const logger = makeLogger();
    const result = await client.analyzeScreenshot(baseArgs(logger));

    assert.equal(result.ok, true);
    assert.equal(result.extracted.screenType, 'position');
    assert.equal(result.extracted.entryPrice, 65000);
    assert.equal(typeof result.extracted.expiryMs, 'number');

    assert.equal(fetchCalls.length, 1);
    const { url, opts } = fetchCalls[0];
    assert.equal(url, 'https://ai.example.com/v1/chat/completions');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.allowedOrigins, origins);
    assert.equal(opts.headers.Authorization, 'Bearer sk-test');
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'vision-1');
    assert.equal(body.stream, false);
    assert.equal(body.messages[0].content[0].image_url.url, `data:image/png;base64,${Buffer.from('imgbytes').toString('base64')}`);
    assert.equal(body.messages[0].content[1].text, VISION_PROMPT);
  });

  it('omits Authorization when the provider has no apiKey', async () => {
    const { client, fetchCalls } = makeClient();
    const args = baseArgs(makeLogger());
    delete args.provider.apiKey;
    await client.analyzeScreenshot(args);
    assert.equal('Authorization' in fetchCalls[0].opts.headers, false);
  });

  it('returns a generic 400 when the endpoint fails SSRF validation, without fetching', async () => {
    const { client, fetchCalls } = makeClient({ validate: async () => ({ valid: false, error: 'private ip 10.0.0.1' }) });
    const logger = makeLogger();
    const result = await client.analyzeScreenshot(baseArgs(logger));
    assert.deepEqual(result, { ok: false, status: 400, error: 'Provider endpoint is misconfigured. Contact the administrator.' });
    assert.equal(fetchCalls.length, 0);
    assert.equal(logger.calls.warn.length, 1);
    assert.match(logger.calls.warn[0][0], /private ip 10\.0\.0\.1/);
  });

  it('maps a non-ok provider response to 502 with a truncated body', async () => {
    const { client } = makeClient({
      fetchImpl: () => ({ ok: false, status: 429, text: async () => 'x'.repeat(500) }),
    });
    const result = await client.analyzeScreenshot(baseArgs(makeLogger()));
    assert.equal(result.ok, false);
    assert.equal(result.status, 502);
    assert.equal(result.error, `AI provider returned 429: ${'x'.repeat(200)}`);
  });

  it('hides SSRF-blocked redirect details behind a generic 502', async () => {
    const { client } = makeClient({
      fetchImpl: () => { throw new Error('Blocked private/reserved address 127.0.0.1'); },
    });
    const logger = makeLogger();
    const result = await client.analyzeScreenshot(baseArgs(logger));
    assert.deepEqual(result, { ok: false, status: 502, error: 'AI provider endpoint is misconfigured. Contact the administrator.' });
    assert.equal(logger.calls.error[0][1].ssrfBlocked, true);
  });

  it('reports other fetch failures with the error message', async () => {
    const { client } = makeClient({ fetchImpl: () => { throw new Error('socket hang up'); } });
    const result = await client.analyzeScreenshot(baseArgs(makeLogger()));
    assert.deepEqual(result, { ok: false, status: 502, error: 'AI request failed: socket hang up' });
  });

  it('returns 422 with a truncated raw reply when the model output is unparseable', async () => {
    const { client } = makeClient({ fetchImpl: () => okResponse('nothing useful '.repeat(100)) });
    const result = await client.analyzeScreenshot(baseArgs(makeLogger()));
    assert.equal(result.ok, false);
    assert.equal(result.status, 422);
    assert.equal(result.error, 'AI returned unparseable response');
    assert.equal(result.raw.length, 500);
  });

  it('treats a missing message content as an unparseable empty reply', async () => {
    const { client } = makeClient({ fetchImpl: () => ({ ok: true, json: async () => ({}) }) });
    const result = await client.analyzeScreenshot(baseArgs(makeLogger()));
    assert.equal(result.status, 422);
    assert.equal(result.raw, '');
  });

  it('hides a "Blocked endpoint" redirect refusal behind the generic 502', async () => {
    const { client } = makeClient({ fetchImpl: () => { throw new Error('Blocked endpoint redirect to http://169.254.169.254'); } });
    const result = await client.analyzeScreenshot(baseArgs(makeLogger()));
    assert.deepEqual(result, { ok: false, status: 502, error: 'AI provider endpoint is misconfigured. Contact the administrator.' });
  });

  it('tolerates a non-ok response whose body cannot be read', async () => {
    const { client } = makeClient({
      fetchImpl: () => ({ ok: false, status: 500, text: async () => { throw new Error('stream closed'); } }),
    });
    const result = await client.analyzeScreenshot(baseArgs(makeLogger()));
    assert.deepEqual(result, { ok: false, status: 502, error: 'AI provider returned 500: ' });
  });

  it('aborts the request at provider.timeout', async () => {
    const { client } = makeClient({
      fetchImpl: (_url, opts) => new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('This operation was aborted')));
      }),
    });
    const args = baseArgs(makeLogger());
    args.provider.timeout = 20;
    const result = await client.analyzeScreenshot(args);
    assert.deepEqual(result, { ok: false, status: 502, error: 'AI request failed: This operation was aborted' });
  });
});
