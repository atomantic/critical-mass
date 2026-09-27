// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '../src/sentinel/classifier.js');
const source = readFileSync(sourcePath, 'utf8');
const item = { title: 'Trading halt', description: 'Market halt announced', source: 'test' };
const aiConfig = { enabled: true, maxPerHour: 10 };
const keywords = { critical: ['halt'], warning: [], info: [] };
const successfulResponse = () => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: '{"severity":"critical","category":"market_event"}' } }] }),
});

// Load the actual classifier with isolated clock, provider-file and transport
// dependencies. No live provider config, credentials, DNS or network is accessed.
const loadClassifier = (options = {}) => {
  let now = 1_000_000;
  let dispatches = 0;
  let providers = { test: { enabled: true, type: 'api', endpoint: 'https://provider.example', defaultModel: 'test' } };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    __dirname: path.dirname(sourcePath),
    Date: { now: () => now },
    AbortSignal: { timeout: () => undefined },
    require: (name) => {
      if (name === 'path') return path;
      if (name === 'fs/promises') return { readFile: async () => JSON.stringify({ providers }) };
      if (name === '../logger') return { createContextLogger: () => ({ warn: () => {} }) };
      if (name === '../config-utils') return { SENTINEL_DEFAULTS: { keywords } };
      if (name === '../url-validator') return {
        validateEndpointUrl: options.validate || (async () => ({ valid: true })),
        safeFetch: async () => {
          dispatches++;
          return (options.fetch || successfulResponse)();
        },
      };
      throw new Error('Unexpected dependency: ' + name);
    },
  }, { filename: sourcePath });
  return {
    classifier: module.exports,
    dispatchCount: () => dispatches,
    advance: (ms) => { now += ms; },
    setProviders: (value) => { providers = value; },
  };
};

describe('Sentinel process-local hourly AI attempt budget', () => {
  for (const [outcome, fetch] of [
    ['success', successfulResponse],
    ['timeout', () => { throw new Error('mock timeout'); }],
    ['non-OK HTTP response', () => ({ ok: false })],
    ['malformed response JSON', () => ({ ok: true, json: async () => { throw new SyntaxError('mock invalid JSON'); } })],
    ['malformed model JSON', () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{invalid}' } }] }) })],
  ]) {
    it('caps 25 sequential calls at 10 attempts for ' + outcome, async () => {
      const fixture = loadClassifier({ fetch });
      for (let i = 0; i < 25; i++) {
        await fixture.classifier.classifyByAI({ ...item, guid: String(i) }, aiConfig);
      }
      assert.equal(fixture.dispatchCount(), 10);
      assert.equal(await fixture.classifier.classifyByAI(item, aiConfig), null);
      assert.equal(fixture.dispatchCount(), 10, 'exhaustion must not retry');
    });
  }

  it('does not charge absent or disabled providers or disabled classification', async () => {
    const fixture = loadClassifier();
    assert.equal(await fixture.classifier.classifyByAI(item, { ...aiConfig, enabled: false }), null);
    fixture.setProviders({});
    for (let i = 0; i < 25; i++) await fixture.classifier.classifyByAI(item, aiConfig);
    fixture.setProviders({ test: { enabled: false, type: 'api' } });
    for (let i = 0; i < 25; i++) await fixture.classifier.classifyByAI(item, aiConfig);
    assert.equal(fixture.dispatchCount(), 0);
    fixture.setProviders({ test: { enabled: true, type: 'api', endpoint: 'https://provider.example' } });
    for (let i = 0; i < 25; i++) await fixture.classifier.classifyByAI(item, aiConfig);
    assert.equal(fixture.dispatchCount(), 10, 'local provider failures must leave the budget intact');
  });

  it('does not charge endpoints rejected before dispatch', async () => {
    let valid = false;
    const fixture = loadClassifier({ validate: async () => ({ valid, error: 'mock rejection' }) });
    for (let i = 0; i < 25; i++) await fixture.classifier.classifyByAI(item, aiConfig);
    assert.equal(fixture.dispatchCount(), 0);
    valid = true;
    for (let i = 0; i < 25; i++) await fixture.classifier.classifyByAI(item, aiConfig);
    assert.equal(fixture.dispatchCount(), 10);
  });

  it('cannot oversubscribe when concurrent asynchronous validations finish together', async () => {
    const pending = [];
    let allValidating;
    const ready = new Promise((resolve) => { allValidating = resolve; });
    const fixture = loadClassifier({
      validate: () => new Promise((resolve) => {
        pending.push(resolve);
        if (pending.length === 25) allValidating();
      }),
      fetch: () => ({ ok: false }),
    });
    const calls = Array.from({ length: 25 }, () => fixture.classifier.classifyByAI(item, aiConfig));
    await ready;
    assert.equal(pending.length, 25);
    for (const resolve of pending) resolve({ valid: true });
    await Promise.all(calls);
    assert.equal(fixture.dispatchCount(), 10);
  });

  it('opens a fresh budget at the exact hourly boundary', async () => {
    const fixture = loadClassifier({ fetch: () => { throw new Error('mock timeout'); } });
    for (let i = 0; i < 10; i++) await fixture.classifier.classifyByAI(item, aiConfig);
    fixture.advance(3_599_999);
    assert.equal(await fixture.classifier.classifyByAI(item, aiConfig), null);
    assert.equal(fixture.dispatchCount(), 10);
    fixture.advance(1);
    for (let i = 0; i < 25; i++) await fixture.classifier.classifyByAI(item, aiConfig);
    assert.equal(fixture.dispatchCount(), 20);
  });

  it('resets at reservation time when validation crosses the hourly boundary', async () => {
    const pending = [];
    let allValidating;
    const ready = new Promise((resolve) => { allValidating = resolve; });
    let delay = false;
    const fixture = loadClassifier({
      validate: () => delay ? new Promise((resolve) => {
        pending.push(resolve);
        if (pending.length === 25) allValidating();
      }) : Promise.resolve({ valid: true }),
    });
    for (let i = 0; i < 9; i++) await fixture.classifier.classifyByAI(item, aiConfig);
    delay = true;
    const calls = Array.from({ length: 25 }, () => fixture.classifier.classifyByAI(item, aiConfig));
    await ready;
    assert.equal(pending.length, 25);
    fixture.advance(3_600_000);
    for (const resolve of pending) resolve({ valid: true });
    await Promise.all(calls);
    assert.equal(fixture.dispatchCount(), 19, 'new window permits exactly ten delayed dispatches');
  });

  it('preserves the service keyword fallback after the AI budget is exhausted', async () => {
    const fixture = loadClassifier();
    for (let i = 0; i < 10; i++) await fixture.classifier.classifyByAI(item, aiConfig);
    const keywordResult = fixture.classifier.classifyByKeywords(item, keywords);
    const aiResult = await fixture.classifier.classifyByAI(item, aiConfig);
    assert.equal(aiResult, null);
    assert.equal(keywordResult.severity, 'critical');
    assert.equal(fixture.classifier.resolveSeverity(keywordResult.severity, aiResult?.severity), 'critical');
    assert.equal(fixture.dispatchCount(), 10);
  });
});
