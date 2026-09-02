const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readJSON } = require('../src/shared-utils');

const contextFor = (lines, prefix) => {
  const line = lines.find(candidate => candidate.startsWith(prefix));
  assert.ok(line, `missing log line starting with: ${prefix}`);
  const contextStart = line.lastIndexOf(' {');
  assert.notEqual(contextStart, -1, `missing structured context: ${line}`);
  return {
    context: JSON.parse(line.slice(contextStart + 1)),
    message: line.slice(0, contextStart),
  };
};

describe('core utility structured logging', () => {
  it('keeps configuration and shared utility modules off direct console calls', () => {
    for (const relativePath of [
      '../src/config-utils.js',
      '../src/shared-utils.js',
      '../src/async-mutex.js',
    ]) {
      const source = fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
      assert.doesNotMatch(source, /\bconsole\.(?:log|warn|error)\b/, relativePath);
      assert.match(source, /createContextLogger\(/, relativePath);
    }
  });

  it('preserves JSON parse failure text and appends file and error context', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'critical-mass-json-log-'));
    const filePath = path.join(tempDir, 'broken.json');
    fs.writeFileSync(filePath, 'not json{');

    const lines = [];
    const originalLog = console.log;
    console.log = line => lines.push(line);

    let result;
    try {
      result = readJSON(filePath, { fallback: true });
    } finally {
      console.log = originalLog;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    assert.deepStrictEqual(result, { fallback: true });
    const { context, message } = contextFor(lines, `Error parsing JSON from ${filePath}:`);
    assert.equal(message, `Error parsing JSON from ${filePath}: ${context.error}`);
    assert.equal(typeof context.error, 'string');
    assert.ok(context.error.length > 0, 'includes the parse failure');
    assert.deepStrictEqual(context, {
      module: 'shared-utils',
      filePath,
      error: context.error,
    });
  });
});
