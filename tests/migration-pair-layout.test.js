// @ts-check
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// issue #425 — legacy-to-multi-pair data migration coverage:
//  - migrateExchangeToPairs relocates live ledger/state files with fs.renameSync
//  - the per-fund allow-list (isPerFundFile) determines what survives the upgrade
//  - the collision branch must surface skipped files instead of silently
//    claiming success (split-brain state)
//  - resolveFundPath is the traversal guard for non-gateway callers
//
// All fixtures live under fs.mkdtempSync — nothing here ever touches the
// repository's real data/ directory.

const migrationPath = require.resolve('../src/migration');
const pathsModule = require('../src/paths');
const configUtils = require('../src/config-utils');

const originalDataDir = pathsModule.DATA_DIR;
const originalGetDefaultPair = configUtils.getDefaultPair;

const EXCHANGE = 'coinbase';
const PAIR = 'BTC-USDC';

// Snapshot of the production allow-list, kept independent of `migration.PER_FUND_FILES`
// / `migration.PER_FUND_FILE_PREFIXES` on purpose: the fixture below is seeded from
// this snapshot, then cross-checked for parity against the live arrays. If someone
// shrinks (or extends) the production allow-list without updating this file, the
// parity assertion fails loudly instead of the fixture silently shrinking with it.
const KNOWN_PER_FUND_FILES = [
  'state.json',
  'regime-state.json',
  'fill-ledger.json',
  'transactions.tsv',
  'chart-data-buffer.json',
  'optimizer-cache.json',
  'pending-corrective-buys.json',
  'regime-engine-running.json',
  'dry-run-state.json',
];
const KNOWN_PER_FUND_FILE_PREFIXES = [
  'btc-price-cache',
  'btcusd-price-cache',
  'btc-usdc-price-cache',
  'cro-usd-price-cache',
  'long-term-candles',
  'price-cache-',
];

/** @type {string|null} */
let tmpDir = null;
/** @type {any} */
let migration = null;

// Force migration.js to re-run its top-level `const { DATA_DIR } = require('./paths')`
// against a freshly-mutated paths module, the same delete-cache/re-require idiom
// tests/state-tracker-hardening.test.js already uses for getExchangeDataDir.
const freshMigration = (dataDir) => {
  pathsModule.DATA_DIR = dataDir;
  delete require.cache[migrationPath];
  return require('../src/migration');
};

const writeLegacyFile = (exchangeDir, name, content) => {
  fs.mkdirSync(exchangeDir, { recursive: true });
  fs.writeFileSync(path.join(exchangeDir, name), content);
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-pair-layout-test-'));
  migration = freshMigration(tmpDir);
  configUtils.getDefaultPair = () => PAIR;
});

afterEach(() => {
  configUtils.getDefaultPair = originalGetDefaultPair;
  pathsModule.DATA_DIR = originalDataDir;
  delete require.cache[migrationPath];
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
  migration = null;
});

describe('migrateExchangeToPairs — completeness and idempotency (issue #425)', () => {
  it('moves every allow-listed per-fund file (and its backup/prefix variants), leaving none at the exchange level', () => {
    const exchangeDir = path.join(tmpDir, EXCHANGE);
    const fundDir = path.join(exchangeDir, PAIR);

    // Guard the guard: if production PER_FUND_FILES/PER_FUND_FILE_PREFIXES drift
    // from this snapshot (an entry added or removed), fail here rather than
    // silently reseeding the fixture from whatever the array now contains.
    assert.deepEqual(
      migration.PER_FUND_FILES,
      KNOWN_PER_FUND_FILES,
      'PER_FUND_FILES changed — update KNOWN_PER_FUND_FILES in this test to match',
    );
    assert.deepEqual(
      migration.PER_FUND_FILE_PREFIXES,
      KNOWN_PER_FUND_FILE_PREFIXES,
      'PER_FUND_FILE_PREFIXES changed — update KNOWN_PER_FUND_FILE_PREFIXES in this test to match',
    );

    const seeded = {};
    for (const name of KNOWN_PER_FUND_FILES) {
      seeded[name] = `content-${name}`;
    }
    // Backup/temp variants of a couple of representative per-fund files.
    seeded['state.json.bak'] = 'content-state-bak';
    seeded['regime-state.json.backup-1234'] = 'content-regime-backup';
    seeded['fill-ledger.json.tmp'] = 'content-ledger-tmp';
    // Prefix-based files (price caches, long-term candle stores).
    for (const prefix of KNOWN_PER_FUND_FILE_PREFIXES) {
      const name = `${prefix}-BTC-USDC.json`;
      seeded[name] = `content-${name}`;
    }

    for (const [name, content] of Object.entries(seeded)) {
      writeLegacyFile(exchangeDir, name, content);
    }

    const result = migration.migrateExchangeToPairs(EXCHANGE);

    assert.equal(result.migrated, true);
    assert.equal(result.defaultPair, PAIR);
    assert.equal(result.movedFiles, Object.keys(seeded).length);
    assert.deepEqual(result.skippedFiles, []);

    // No file remains at the exchange level (only the fund subdirectory).
    const remainingFiles = fs
      .readdirSync(exchangeDir, { withFileTypes: true })
      .filter((e) => e.isFile());
    assert.deepEqual(remainingFiles, [], 'a per-fund file was orphaned at the exchange level');

    // Every seeded file landed under the fund directory, byte-identical.
    for (const [name, content] of Object.entries(seeded)) {
      const dst = path.join(fundDir, name);
      assert.ok(fs.existsSync(dst), `${name} was not moved into the fund directory`);
      assert.equal(fs.readFileSync(dst, 'utf8'), content, `${name} content was not preserved`);
    }
  });

  it('is idempotent: a second call is a no-op and moves nothing', () => {
    const exchangeDir = path.join(tmpDir, EXCHANGE);
    writeLegacyFile(exchangeDir, 'state.json', 'legacy-state');
    writeLegacyFile(exchangeDir, 'regime-state.json', 'legacy-regime');

    const first = migration.migrateExchangeToPairs(EXCHANGE);
    assert.equal(first.migrated, true);

    const fundDirListingBefore = fs.readdirSync(path.join(exchangeDir, PAIR)).sort();

    const second = migration.migrateExchangeToPairs(EXCHANGE);
    assert.equal(second.migrated, false);
    assert.equal(second.movedFiles, 0);

    const fundDirListingAfter = fs.readdirSync(path.join(exchangeDir, PAIR)).sort();
    assert.deepEqual(fundDirListingAfter, fundDirListingBefore, 'second call must not move any files');
  });

  it('reports skippedFiles instead of silently succeeding when a target file already exists (partial-migration collision)', () => {
    const exchangeDir = path.join(tmpDir, EXCHANGE);
    const fundDir = path.join(exchangeDir, PAIR);

    writeLegacyFile(exchangeDir, 'state.json', 'legacy-state');
    writeLegacyFile(exchangeDir, 'regime-state.json', 'legacy-regime');
    writeLegacyFile(exchangeDir, 'fill-ledger.json', 'legacy-ledger');

    // Simulate a previous partial migration: the target already has its own
    // fill-ledger.json.
    fs.mkdirSync(fundDir, { recursive: true });
    fs.writeFileSync(path.join(fundDir, 'fill-ledger.json'), 'already-migrated-ledger');

    const result = migration.migrateExchangeToPairs(EXCHANGE);

    assert.equal(result.migrated, true);
    assert.equal(result.movedFiles, 2, 'state.json and regime-state.json should still move');
    assert.deepEqual(result.skippedFiles, ['fill-ledger.json']);

    // The collision must not destroy either copy — split-brain is surfaced,
    // not silently resolved by discarding data.
    assert.equal(fs.readFileSync(path.join(exchangeDir, 'fill-ledger.json'), 'utf8'), 'legacy-ledger');
    assert.equal(fs.readFileSync(path.join(fundDir, 'fill-ledger.json'), 'utf8'), 'already-migrated-ledger');
  });

  it('preserves a non-empty sibling pair subdirectory and removes an empty one during cleanup', () => {
    const exchangeDir = path.join(tmpDir, EXCHANGE);
    writeLegacyFile(exchangeDir, 'state.json', 'legacy-state');
    writeLegacyFile(exchangeDir, 'regime-state.json', 'legacy-regime');

    const nonEmptySibling = path.join(exchangeDir, 'ETH-USDC');
    fs.mkdirSync(nonEmptySibling, { recursive: true });
    fs.writeFileSync(path.join(nonEmptySibling, 'state.json'), 'other-fund-state');

    const emptySibling = path.join(exchangeDir, 'SOL-USDC');
    fs.mkdirSync(emptySibling, { recursive: true });

    migration.migrateExchangeToPairs(EXCHANGE);

    assert.ok(fs.existsSync(nonEmptySibling), 'non-empty sibling fund directory must survive cleanup');
    assert.equal(fs.readFileSync(path.join(nonEmptySibling, 'state.json'), 'utf8'), 'other-fund-state');
    assert.ok(!fs.existsSync(emptySibling), 'empty sibling pair directory should be removed by cleanup');
  });

  it('returns a productId-missing reason and touches no disk when getDefaultPair yields nothing', () => {
    const exchangeDir = path.join(tmpDir, EXCHANGE);
    writeLegacyFile(exchangeDir, 'state.json', 'legacy-state');
    configUtils.getDefaultPair = () => null;

    const before = fs.readdirSync(exchangeDir).sort();
    const result = migration.migrateExchangeToPairs(EXCHANGE);
    const after = fs.readdirSync(exchangeDir).sort();

    assert.equal(result.migrated, false);
    assert.equal(result.defaultPair, null);
    assert.match(result.reason, /productId missing/);
    assert.deepEqual(after, before, 'directory listing must be unchanged when the default pair cannot be resolved');
  });
});

describe('needsPairMigration (issue #425)', () => {
  it('is false when the exchange directory does not exist', () => {
    assert.equal(migration.needsPairMigration('no-such-exchange'), false);
  });

  it('is false for an already-migrated layout (no state files at the exchange level)', () => {
    const exchangeDir = path.join(tmpDir, EXCHANGE);
    const fundDir = path.join(exchangeDir, PAIR);
    fs.mkdirSync(fundDir, { recursive: true });
    fs.writeFileSync(path.join(fundDir, 'state.json'), '{}');
    assert.equal(migration.needsPairMigration(EXCHANGE), false);
  });

  it('is true when state.json sits at the exchange level', () => {
    writeLegacyFile(path.join(tmpDir, EXCHANGE), 'state.json', '{}');
    assert.equal(migration.needsPairMigration(EXCHANGE), true);
  });

  it('is true when regime-state.json sits at the exchange level', () => {
    writeLegacyFile(path.join(tmpDir, EXCHANGE), 'regime-state.json', '{}');
    assert.equal(migration.needsPairMigration(EXCHANGE), true);
  });
});

describe('resolveFundPath (issue #425)', () => {
  const baseDir = path.join(os.tmpdir(), 'resolve-fund-path-base');

  it('returns the joined path for a normal pair', () => {
    const result = migration.resolveFundPath(baseDir, 'BTC-USDC');
    assert.equal(result, path.resolve(baseDir, 'BTC-USDC'));
  });

  it('throws for a pair that escapes with ../', () => {
    assert.throws(() => migration.resolveFundPath(baseDir, '../escape'), /escapes exchange data directory/);
  });

  it('throws for a pair that escapes via a nested traversal', () => {
    assert.throws(() => migration.resolveFundPath(baseDir, 'a/../../escape'), /escapes exchange data directory/);
  });

  it('throws for an absolute path pair', () => {
    assert.throws(() => migration.resolveFundPath(baseDir, '/etc/passwd'), /escapes exchange data directory/);
  });

  it('throws for an empty string pair', () => {
    assert.throws(() => migration.resolveFundPath(baseDir, ''), /non-empty string/);
  });

  it('throws for a non-string pair', () => {
    // @ts-expect-error deliberately passing the wrong type
    assert.throws(() => migration.resolveFundPath(baseDir, 123), /non-empty string/);
  });
});
