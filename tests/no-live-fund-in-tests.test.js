// @ts-check
//
// No test may point a recursive cleanup at a REAL fund's data directory.
//
// Constructing an executor or engine for a pair creates
// `data/<exchange>/<pair>/`, and these suites clean up with
// `fs.rmSync(JUNK_DIR, { recursive: true, force: true })`. Anchor that path at
// the repo's own `data/` and name a live pair, and every `npm test` recursively
// deletes that fund's real fill-ledger.json, regime-state.json and
// closed-trades.json — silently, with nothing in the app logs, and the engine
// recreates the surviving files on its next write so the directory looks merely
// "empty" rather than looted.
//
// tests/executor-contract.test.js used `BTC-USDC`, the production Coinbase
// fund, and destroyed 26,268 fills and $40,987 of realized P&L repeatedly
// before the cause was found. Recovery needed an APFS snapshot; the app's own
// daily backup was 24 hours stale.
//
// Suites that build a path under a TEMP root are fine and must not be flagged —
// only a path rooted at this repo (`__dirname, '..', 'data'`) touches live data.
// The convention for the pair name is a sentinel that cannot collide with any
// exchange's pair naming: `__test201__`, `__testpartial__`, `__testexec__`.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { getConfiguredFunds } = require('../src/config-utils');

const TESTS_DIR = __dirname;

/** Every pair this install would actually run. */
const livePairs = () => new Set(getConfiguredFunds().map(f => f.pair));

/**
 * Pair names a source file builds a path to under the REPO's own data dir —
 * `path.join(__dirname, '..', 'data', <exchange>, <pair>)`. The pair may be a
 * literal or an identifier assigned a literal elsewhere in the file.
 * @param {string} source
 * @returns {string[]} resolved pair names
 */
const repoDataPairs = (source) => {
  const consts = new Map();
  const constRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"]([^'"]+)['"]/g;
  let assignment;
  while ((assignment = constRe.exec(source)) !== null) consts.set(assignment[1], assignment[2]);

  const pairs = [];
  // __dirname, '..', 'data', <exchange>, <pair>  — the repo-rooted data path.
  const repoDataRe = /__dirname\s*,\s*['"]\.\.['"]\s*,\s*['"]data['"]\s*,\s*['"][^'"]+['"]\s*,\s*(?:['"]([^'"]+)['"]|([A-Za-z_$][\w$]*))/g;
  let match;
  while ((match = repoDataRe.exec(source)) !== null) {
    const literal = match[1];
    const identifier = match[2];
    const value = literal !== undefined ? literal : consts.get(identifier);
    if (value !== undefined) pairs.push(value);
  }
  return pairs;
};

/**
 * Does this source recursively delete anything? Two separate patterns on
 * purpose: a paren-bounded window cannot span a NESTED call, so
 * `fs.rmSync(path.join(...), { recursive: true })` — the inline form of the very
 * bug this file guards — slips past a single combined regex.
 * @param {string} source
 * @returns {boolean}
 */
const doesRecursiveDelete = (source) =>
  /\brm(?:Sync|dirSync)?\s*\(/.test(source) && /recursive\s*:\s*true/.test(source);

describe('tests never target a live fund directory', () => {
  it('detects the pattern that destroyed coinbase/BTC-USDC', () => {
    // The exact shape tests/executor-contract.test.js shipped with, so this
    // guard cannot silently stop working.
    const offending = `
      const TEST_PAIR = 'BTC-USDC';
      const JUNK_DIR = path.join(__dirname, '..', 'data', 'coinbase', TEST_PAIR);
      after(() => { fs.rmSync(JUNK_DIR, { recursive: true, force: true }); });
    `;
    assert.deepEqual(repoDataPairs(offending), ['BTC-USDC']);

    // A temp-rooted path is not live data and must not be flagged.
    const safe = "const dir = path.join(os.tmpdir(), 'cm-x', 'data', 'coinbase', 'BTC-USDC');";
    assert.deepEqual(repoDataPairs(safe), []);

    // The inline form: the path is built inside the rmSync call itself.
    const inline = "fs.rmSync(path.join(__dirname, '..', 'data', 'coinbase', 'BTC-USDC'), { recursive: true });";
    assert.deepEqual(repoDataPairs(inline), ['BTC-USDC']);
    // The pre-filter is the half that actually changed — assert it directly, or
    // reverting it to a single paren-bounded pattern leaves the suite green.
    assert.equal(doesRecursiveDelete(inline), true, 'the pre-filter must span a nested rmSync call');
    assert.equal(doesRecursiveDelete(offending), true);
    assert.equal(doesRecursiveDelete("fs.rmSync(tmp, { force: true });"), false, 'a non-recursive delete is not a hazard');

    // A sentinel pair under the repo data dir is the approved pattern.
    const sentinel = `
      const TEST_PAIR = '__testexec__';
      const JUNK_DIR = path.join(__dirname, '..', 'data', 'coinbase', TEST_PAIR);
    `;
    assert.deepEqual(repoDataPairs(sentinel), ['__testexec__']);
  });

  it('no test file recursively deletes a configured fund directory', () => {
    const live = livePairs();
    // Nothing configured (fresh checkout / CI without data) — the guard has
    // nothing to protect, and asserting here would fail for the wrong reason.
    if (live.size === 0) return;

    const offenders = [];
    for (const name of fs.readdirSync(TESTS_DIR)) {
      if (!name.endsWith('.test.js') || name === path.basename(__filename)) continue;
      const source = fs.readFileSync(path.join(TESTS_DIR, name), 'utf8');
      if (!doesRecursiveDelete(source)) continue;
      for (const pair of repoDataPairs(source)) {
        if (live.has(pair)) offenders.push(`${name} → ${pair}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      'these tests recursively delete a LIVE fund\'s data directory; '
      + `use a sentinel pair like __testexec__ instead:\n  ${offenders.join('\n  ')}`,
    );
  });
});
