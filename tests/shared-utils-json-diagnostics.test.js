// @ts-check
const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { readJSON } = require('../src/shared-utils');

describe('readJSON credential diagnostics', () => {
  afterEach(() => mock.restoreAll());
  for (const file of ['providers.json', 'operator-auth.json']) {
    for (const malformed of ['SECRET820', '{"token":"SECRET820","bad":SECRET820}']) {
      it(`returns the existing default without exposing malformed ${file} (${malformed.length})`, () => {
        mock.method(fs, 'existsSync', () => true);
        mock.method(fs, 'readFileSync', () => malformed);
        const output = [];
        for (const channel of ['log', 'warn', 'error']) mock.method(console, channel, (...args) => output.push(args.join(' ')));
        const fallback = { defaults: true };
        assert.equal(readJSON(`/synthetic/${file}`, fallback), fallback);
        assert.equal(output.length, 1);
        assert.ok(!output.join('\n').includes('SECRET820'));
        assert.ok(output[0].includes(file));
        assert.ok(output[0].includes('ERR_INVALID_JSON'));
      });
    }
  }
  it('preserves valid, missing and empty reads', () => {
    mock.method(fs, 'existsSync', () => true);
    mock.method(fs, 'readFileSync', () => '{"valid":true}');
    assert.deepEqual(readJSON('/synthetic/providers.json'), { valid: true });
    mock.method(fs, 'readFileSync', () => '  ');
    assert.deepEqual(readJSON('/synthetic/providers.json'), {});
    mock.method(fs, 'existsSync', () => false);
    assert.deepEqual(readJSON('/synthetic/providers.json'), {});
  });
});
