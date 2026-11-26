const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseDiagnostics, countRawDiagnostics, compare, nextBaseline } = require('../scripts/typecheck');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'typecheck.js');

describe('typecheck ratchet: pure helpers', () => {
  it('counts diagnostics per POSIX-relative file and ignores continuation lines and node_modules', () => {
    const base = path.resolve('/proj');
    const out = [
      "src/a.js(1,2): error TS2339: Property 'x' does not exist.",
      "src/a.js(5,1): error TS2322: Type 'a' is not assignable.",
      "  Type 'a' is not assignable to type 'b'.",
      "node_modules/express/lib/express.js(38,9): error TS2339: nope.",
      "error TS5083: Cannot read file.",
      "Found 3 errors.",
    ].join('\n');
    assert.deepEqual(parseDiagnostics(out, base), { 'src/a.js': 2, '<global>': 1 });
  });

  it('counts node_modules-only diagnostics as raw diagnostics so they are not mistaken for a tsc crash', () => {
    const out = "node_modules/express/lib/express.js(38,9): error TS2339: nope.\n";
    assert.deepEqual(parseDiagnostics(out, path.resolve('/proj')), {});
    assert.equal(countRawDiagnostics(out), 1);
    assert.equal(countRawDiagnostics('Segmentation fault\n'), 0);
  });

  it('flags a worse file and a new file, and reports improvements without failing', () => {
    const { regressions, improvements } = compare({ a: 3, b: 1, c: 1 }, { a: 2, c: 4, d: 1 });
    assert.deepEqual(regressions, [{ file: 'a', from: 2, to: 3 }, { file: 'b', from: 0, to: 1 }]);
    assert.deepEqual(improvements, [{ file: 'c', from: 4, to: 1 }, { file: 'd', from: 1, to: 0 }]);
  });

  it('--update only lowers counts and never adds files; --force takes current verbatim', () => {
    const current = { a: 3, b: 1, c: 1 };
    const baseline = { a: 2, c: 4, d: 1 };
    assert.deepEqual(nextBaseline(current, baseline, false), { a: 2, c: 1 });
    assert.deepEqual(nextBaseline(current, baseline, true), { a: 3, b: 1, c: 1 });
  });
});

describe('typecheck ratchet: script against a fixture project', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'typecheck-fixture-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'jsconfig.json'), JSON.stringify({
    compilerOptions: { checkJs: true, noEmit: true, target: 'ES2020', module: 'CommonJS', types: [] },
    include: ['*.js'],
  }));
  const baseline = path.join(dir, 'baseline.json');
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, '--project', path.join(dir, 'jsconfig.json'), '--baseline', baseline, ...args], { encoding: 'utf8' });

  it('passes on a clean file, fails when it gains an error, passes again once the baseline is regenerated', () => {
    fs.writeFileSync(path.join(dir, 'clean.js'), '// @ts-check\n/** @type {number} */\nconst n = 1;\nmodule.exports = n;\n');
    assert.equal(run('--update').status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(baseline, 'utf8')), {});
    assert.equal(run().status, 0);

    fs.writeFileSync(path.join(dir, 'clean.js'), '// @ts-check\n/** @type {number} */\nconst n = "x";\nmodule.exports = n;\n');
    const failed = run();
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /clean\.js: 1 errors \(baseline 0\)/);

    // A plain --update never absorbs a regression; --force does.
    run('--update');
    assert.equal(run().status, 1);
    run('--update', '--force');
    assert.deepEqual(JSON.parse(fs.readFileSync(baseline, 'utf8')), { 'clean.js': 1 });
    assert.equal(run().status, 0);
  });

  it('fails when a baselined file gets worse and passes (with a reminder) when it improves', () => {
    fs.writeFileSync(path.join(dir, 'clean.js'), '// @ts-check\n/** @type {number} */\nconst n = "x";\n/** @type {number} */\nconst m = "y";\nmodule.exports = [n, m];\n');
    assert.equal(run().status, 1);
    fs.writeFileSync(path.join(dir, 'clean.js'), '// @ts-check\nmodule.exports = 1;\n');
    const improved = run();
    assert.equal(improved.status, 0);
    assert.match(improved.stdout, /Lower the baseline/);
    const strict = run('--strict-ratchet');
    assert.equal(strict.status, 1);
    assert.match(strict.stdout, /clean\.js: 1 -> 0/);
    run('--update');
    assert.deepEqual(JSON.parse(fs.readFileSync(baseline, 'utf8')), {});
    assert.equal(run('--strict-ratchet').status, 0);
  });
});
