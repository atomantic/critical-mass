// @ts-check
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// issue #108 — state-tracker hardening:
//  - unguarded JSON.parse on state files (raw SyntaxError at boot / 500s)
//  - loadState writing from a read path (races the engine save)
//  - saveRegimeState stamping a lower _saveVersion than disk (version regression)

const stateTrackerPath = require.resolve('../src/state-tracker');
const migration = require('../src/migration');
const originalGetExchangeDataDir = migration.getExchangeDataDir;

/** @type {string|null} */
let tmpDir = null;

const freshModule = () => {
  delete require.cache[stateTrackerPath];
  return require('../src/state-tracker');
};

describe('state-tracker hardening (issue #108)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-tracker-test-'));
    migration.getExchangeDataDir = (exchange) => {
      const dir = path.join(tmpDir, exchange);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
  });

  afterEach(() => {
    migration.getExchangeDataDir = originalGetExchangeDataDir;
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
    delete require.cache[stateTrackerPath];
  });

  it('loadState throws a descriptive error on corrupt JSON instead of a raw SyntaxError', () => {
    const st = freshModule();
    const file = st.getStateFile('cb', 'BTC-USD');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ this is not json');

    assert.throws(
      () => st.loadState({ totalAllocation: 1000 }, 'cb', 'BTC-USD'),
      /corrupted or unreadable/,
      'corrupt state must throw a descriptive, file-named error',
    );
  });

  it('loadState throws when the file parses to a non-object', () => {
    const st = freshModule();
    const file = st.getStateFile('cb', 'BTC-USD');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '[1,2,3]');

    assert.throws(
      () => st.loadState({ totalAllocation: 1000 }, 'cb', 'BTC-USD'),
      /did not parse to an object/,
    );
  });

  it('loadState does NOT write to disk when applying a config allocation delta (no read-path write)', () => {
    const st = freshModule();
    const file = st.getStateFile('cb', 'BTC-USD');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // initialAllocation 1000 on disk; config now says 1500
    st.saveState({ ...st.createInitialState({ totalAllocation: 1000 }) }, 'cb', 'BTC-USD');
    const mtimeBefore = fs.statSync(file).mtimeMs;

    const loaded = st.loadState({ totalAllocation: 1500 }, 'cb', 'BTC-USD');
    // Adjustment applied in memory
    assert.equal(loaded.initialAllocation, 1500);
    assert.equal(loaded.usdcFundSize, 1500, 'delta applied to fund size in memory');
    // But the file is untouched (no race with the engine save)
    assert.equal(fs.statSync(file).mtimeMs, mtimeBefore, 'loadState must not persist from a read path');
  });

  it('loadRegimeState throws a descriptive error on corrupt JSON', () => {
    const st = freshModule();
    const file = st.getRegimeStateFile('cb', 'BTC-USD');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json at all');

    assert.throws(
      () => st.loadRegimeState('cb', 'BTC-USD'),
      /corrupted or unreadable/,
    );
  });

  it('saveRegimeState stamps a version greater than a higher on-disk version (no regression)', () => {
    const st = freshModule();
    const file = st.getRegimeStateFile('cb', 'BTC-USD');
    fs.mkdirSync(path.dirname(file), { recursive: true });

    // First save establishes in-memory version 1.
    const position = { ...st.createInitialRegimePositionState(), realizedPnL: 10 };
    const regime = st.createInitialRegimeState();
    st.saveRegimeState(position, regime, 'cb', null, null, 'BTC-USD');

    // Simulate an external writer bumping the on-disk version far ahead with a
    // protected-field edit the operator made out-of-band.
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    disk.position._saveVersion = 99;
    disk.position.realizedPnL = 42;
    fs.writeFileSync(file, JSON.stringify(disk));

    // Next save must (a) merge the protected field and (b) stamp > 99.
    const position2 = { ...st.createInitialRegimePositionState(), realizedPnL: 11 };
    st.saveRegimeState(position2, regime, 'cb', null, null, 'BTC-USD');

    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(after.position._saveVersion > 99,
      `version must exceed the observed disk version 99, got ${after.position._saveVersion}`);
    assert.equal(after.position.realizedPnL, 42,
      'protected field from the higher-versioned disk write must be preserved');
  });
});
