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
// Deliberately empty: every prefix that ever lived here named an exchange-level
// cache and was removed (long-term-candles in #535, price caches in #565). The
// parity assertion below is what keeps a future re-add from silently stranding
// another cache.
const KNOWN_PER_FUND_FILE_PREFIXES = [];

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

describe('long-term-candles cache is exchange-level, not per-fund (issue #535)', () => {
  it('isPerFundFile does not classify long-term-candles-*.json as per-fund', () => {
    assert.equal(migration.isPerFundFile('long-term-candles-btc-usdc.json'), false);
  });

  it('a legacy layout leaves long-term-candles-*.json at the exchange level after migration', () => {
    const exchangeDir = path.join(tmpDir, EXCHANGE);
    writeLegacyFile(exchangeDir, 'state.json', 'legacy-state');
    writeLegacyFile(exchangeDir, 'long-term-candles-btc-usdc.json', 'candle-history');

    const result = migration.migrateExchangeToPairs(EXCHANGE);

    assert.equal(result.migrated, true);
    assert.equal(
      fs.readFileSync(path.join(exchangeDir, 'long-term-candles-btc-usdc.json'), 'utf8'),
      'candle-history',
      'candle cache must stay at the exchange level, not move into the fund subdirectory',
    );
    assert.ok(
      !fs.existsSync(path.join(exchangeDir, PAIR, 'long-term-candles-btc-usdc.json')),
      'candle cache must not be duplicated into the fund subdirectory',
    );
  });

  it('un-strands a long-term-candles-*.json file left in the pair subdirectory by a prior buggy migration', () => {
    const exchangeDir = path.join(tmpDir, EXCHANGE);
    const fundDir = path.join(exchangeDir, PAIR);
    // Already-migrated layout: state lives in the fund dir, so needsPairMigration is false,
    // but the candle cache was stranded there by an earlier version of this migration.
    writeLegacyFile(fundDir, 'state.json', 'migrated-state');
    writeLegacyFile(fundDir, 'long-term-candles-btc-usdc.json', 'stranded-candle-history');

    assert.equal(migration.needsPairMigration(EXCHANGE), false);

    const result = migration.migrateExchangeToPairs(EXCHANGE);

    assert.equal(result.migrated, false, 'no legacy state files at the exchange level, so the rest of migration is a no-op');
    assert.equal(result.repairedFiles, 1);
    assert.deepEqual(result.skippedRepairFiles, []);
    assert.equal(
      fs.readFileSync(path.join(exchangeDir, 'long-term-candles-btc-usdc.json'), 'utf8'),
      'stranded-candle-history',
      'stranded candle cache must be moved back up to the exchange level',
    );
    assert.ok(!fs.existsSync(path.join(fundDir, 'long-term-candles-btc-usdc.json')), 'stranded copy must not remain in the fund subdirectory');
  });

  it('keeps the exchange-level candle cache untouched when both an exchange-level and a stranded copy exist', () => {
    const exchangeDir = path.join(tmpDir, EXCHANGE);
    const fundDir = path.join(exchangeDir, PAIR);
    writeLegacyFile(fundDir, 'state.json', 'migrated-state');
    writeLegacyFile(exchangeDir, 'long-term-candles-btc-usdc.json', 'rebuilt-candle-history');
    writeLegacyFile(fundDir, 'long-term-candles-btc-usdc.json', 'stranded-candle-history');

    const result = migration.migrateExchangeToPairs(EXCHANGE);

    assert.equal(result.repairedFiles, 0);
    assert.deepEqual(result.skippedRepairFiles, ['long-term-candles-btc-usdc.json']);
    assert.equal(
      fs.readFileSync(path.join(exchangeDir, 'long-term-candles-btc-usdc.json'), 'utf8'),
      'rebuilt-candle-history',
      'the exchange-level (rebuilt) copy must not be overwritten by the stranded copy',
    );
    assert.equal(
      fs.readFileSync(path.join(fundDir, 'long-term-candles-btc-usdc.json'), 'utf8'),
      'stranded-candle-history',
      'the stranded copy is left in place rather than discarded',
    );
  });

  it('is idempotent: a second call after un-stranding moves nothing further', () => {
    const exchangeDir = path.join(tmpDir, EXCHANGE);
    const fundDir = path.join(exchangeDir, PAIR);
    writeLegacyFile(fundDir, 'state.json', 'migrated-state');
    writeLegacyFile(fundDir, 'long-term-candles-btc-usdc.json', 'stranded-candle-history');

    const first = migration.migrateExchangeToPairs(EXCHANGE);
    assert.equal(first.repairedFiles, 1);

    const second = migration.migrateExchangeToPairs(EXCHANGE);
    assert.equal(second.repairedFiles, 0);
    assert.deepEqual(second.skippedRepairFiles, []);
    assert.equal(
      fs.readFileSync(path.join(exchangeDir, 'long-term-candles-btc-usdc.json'), 'utf8'),
      'stranded-candle-history',
    );
  });
});

describe('price caches are exchange-level, not per-fund (issue #565)', () => {
  const exchangeDir = () => path.join(tmpDir, EXCHANGE);
  const fundDir = () => path.join(exchangeDir(), PAIR);
  const CACHE = 'btc-usdc-price-cache-daily.json';

  /** @param {number[]} timestamps */
  const cacheEnvelope = (timestamps, marker = 'x') => JSON.stringify({
    lastFetch: '2026-01-01T00:00:00.000Z',
    intervalType: 'daily',
    exchange: EXCHANGE,
    productId: PAIR,
    intervals: timestamps.length,
    prices: timestamps.map((timestamp) => ({ timestamp, close: timestamp / 1000, marker })),
  });

  /** @param {string} file */
  const readPrices = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).prices;

  it('isPerFundFile does not classify a price cache as per-fund', () => {
    assert.equal(migration.isPerFundFile('btcusd-price-cache-5min.json'), false);
    assert.equal(migration.isPerFundFile('btc-price-cache-1hour.json'), false);
    assert.equal(migration.isPerFundFile('btc-usdc-price-cache-daily.json'), false);
    assert.equal(migration.isPerFundFile('cro-usd-price-cache-10min.json'), false);
    assert.equal(migration.isPerFundFile('price-cache-daily.json'), false);
  });

  it('a legacy layout leaves every *price-cache*.json at the exchange level after migration', () => {
    writeLegacyFile(exchangeDir(), 'state.json', 'legacy-state');
    const caches = ['btc-price-cache-5min.json', 'btcusd-price-cache-1hour.json', 'price-cache-daily.json'];
    for (const name of caches) writeLegacyFile(exchangeDir(), name, `content-${name}`);

    const result = migration.migrateExchangeToPairs(EXCHANGE);

    assert.equal(result.migrated, true);
    for (const name of caches) {
      assert.equal(
        fs.readFileSync(path.join(exchangeDir(), name), 'utf8'),
        `content-${name}`,
        `${name} must stay at the exchange level`,
      );
      assert.ok(!fs.existsSync(path.join(fundDir(), name)), `${name} must not be moved into the fund subdirectory`);
    }
  });

  it('un-strands a price cache left in the pair subdirectory with no exchange-level copy', () => {
    writeLegacyFile(fundDir(), 'state.json', 'migrated-state');
    writeLegacyFile(fundDir(), CACHE, cacheEnvelope([1, 2, 3]));

    assert.equal(migration.needsPairMigration(EXCHANGE), false);

    const result = migration.migrateExchangeToPairs(EXCHANGE);

    assert.equal(result.migrated, false);
    assert.deepEqual(result.priceCacheRepair, { repairedFiles: 1, mergedFiles: 0, skippedFiles: [] });
    assert.deepEqual(readPrices(path.join(exchangeDir(), CACHE)).map((c) => c.timestamp), [1, 2, 3]);
    assert.ok(!fs.existsSync(path.join(fundDir(), CACHE)), 'the stranded copy must be gone');
  });

  it('merges both copies into the timestamp-union without dropping a candle from either side', () => {
    writeLegacyFile(fundDir(), 'state.json', 'migrated-state');
    // Stranded copy is the DEEPER one (the live-install shape): older history.
    writeLegacyFile(fundDir(), CACHE, cacheEnvelope([10, 20, 30, 40], 'stranded'));
    // Exchange-level copy was rebuilt from what the exchange still serves.
    writeLegacyFile(exchangeDir(), CACHE, cacheEnvelope([30, 40, 50], 'rebuilt'));

    const result = migration.migrateExchangeToPairs(EXCHANGE);

    assert.deepEqual(result.priceCacheRepair, { repairedFiles: 0, mergedFiles: 1, skippedFiles: [] });
    const merged = readPrices(path.join(exchangeDir(), CACHE));
    assert.deepEqual(merged.map((c) => c.timestamp), [10, 20, 30, 40, 50], 'union, ascending, no duplicates');
    // The rebuilt (fresher) generation wins a timestamp collision.
    assert.deepEqual(merged.map((c) => c.marker), ['stranded', 'stranded', 'rebuilt', 'rebuilt', 'rebuilt']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(exchangeDir(), CACHE), 'utf8')).intervals, 5);
    assert.ok(!fs.existsSync(path.join(fundDir(), CACHE)), 'the stranded copy must be deleted only after the merge landed');
  });

  it('is idempotent: re-running after a merge changes nothing and re-creates no pair-level file', () => {
    writeLegacyFile(fundDir(), 'state.json', 'migrated-state');
    writeLegacyFile(fundDir(), CACHE, cacheEnvelope([10, 20], 'stranded'));
    writeLegacyFile(exchangeDir(), CACHE, cacheEnvelope([20, 30], 'rebuilt'));

    migration.migrateExchangeToPairs(EXCHANGE);
    const afterMerge = fs.readFileSync(path.join(exchangeDir(), CACHE), 'utf8');

    const second = migration.migrateExchangeToPairs(EXCHANGE);

    assert.deepEqual(second.priceCacheRepair, { repairedFiles: 0, mergedFiles: 0, skippedFiles: [] });
    assert.equal(fs.readFileSync(path.join(exchangeDir(), CACHE), 'utf8'), afterMerge, 'a second run must not rewrite the merged cache');
    assert.ok(!fs.existsSync(path.join(fundDir(), CACHE)));
  });

  it('recovers from a crash between the merged write and the stranded delete without duplicating candles', () => {
    writeLegacyFile(fundDir(), 'state.json', 'migrated-state');
    writeLegacyFile(fundDir(), CACHE, cacheEnvelope([10, 20], 'stranded'));
    writeLegacyFile(exchangeDir(), CACHE, cacheEnvelope([20, 30], 'rebuilt'));

    // Simulate the crash: the atomic write lands, then the process dies before
    // fs.rmSync removes the stranded copy.
    const originalRmSync = fs.rmSync;
    // @ts-expect-error deliberately replacing the real implementation
    fs.rmSync = () => { throw new Error('simulated crash before delete'); };
    assert.throws(() => migration.migrateExchangeToPairs(EXCHANGE), /simulated crash/);
    fs.rmSync = originalRmSync;

    // Post-crash state: the merged cache is parseable and complete, and the
    // stranded copy is still there.
    const postCrash = readPrices(path.join(exchangeDir(), CACHE));
    assert.deepEqual(postCrash.map((c) => c.timestamp), [10, 20, 30]);
    assert.ok(fs.existsSync(path.join(fundDir(), CACHE)), 'the crash left the stranded copy behind');

    const resumed = migration.migrateExchangeToPairs(EXCHANGE);

    assert.deepEqual(resumed.priceCacheRepair, { repairedFiles: 0, mergedFiles: 1, skippedFiles: [] });
    assert.deepEqual(readPrices(path.join(exchangeDir(), CACHE)).map((c) => c.timestamp), [10, 20, 30], 'no duplicated candles on re-merge');
    assert.ok(!fs.existsSync(path.join(fundDir(), CACHE)), 'the resumed run finished the delete');
  });

  it('leaves an unparseable or prices-less cache untouched instead of merging it', () => {
    writeLegacyFile(fundDir(), 'state.json', 'migrated-state');
    const BROKEN = 'btc-price-cache-5min.json';
    const NO_PRICES = 'price-cache-1hour.json';
    writeLegacyFile(fundDir(), BROKEN, '{not json');
    writeLegacyFile(exchangeDir(), BROKEN, cacheEnvelope([1]));
    writeLegacyFile(fundDir(), NO_PRICES, cacheEnvelope([2]));
    writeLegacyFile(exchangeDir(), NO_PRICES, JSON.stringify({ lastFetch: 'x' }));

    const result = migration.migrateExchangeToPairs(EXCHANGE);

    assert.equal(result.priceCacheRepair.mergedFiles, 0);
    assert.deepEqual(result.priceCacheRepair.skippedFiles.sort(), [BROKEN, NO_PRICES].sort());
    assert.equal(fs.readFileSync(path.join(fundDir(), BROKEN), 'utf8'), '{not json', 'the corrupt stranded copy is left in place');
    assert.deepEqual(readPrices(path.join(exchangeDir(), BROKEN)).map((c) => c.timestamp), [1], 'the good exchange-level copy is untouched');
    assert.deepEqual(readPrices(path.join(fundDir(), NO_PRICES)).map((c) => c.timestamp), [2], 'the stranded copy is never deleted when the target has no prices array');
    assert.equal(fs.readFileSync(path.join(exchangeDir(), NO_PRICES), 'utf8'), JSON.stringify({ lastFetch: 'x' }));
  });

  it('leaves backup/temp variants of a price cache alone', () => {
    writeLegacyFile(fundDir(), 'state.json', 'migrated-state');
    writeLegacyFile(fundDir(), 'btc-price-cache-5min.json.backup-1234', 'old-bytes');

    const result = migration.migrateExchangeToPairs(EXCHANGE);

    assert.deepEqual(result.priceCacheRepair, { repairedFiles: 0, mergedFiles: 0, skippedFiles: [] });
    assert.equal(fs.readFileSync(path.join(fundDir(), 'btc-price-cache-5min.json.backup-1234'), 'utf8'), 'old-bytes');
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

describe('repairStrandedTransactionLog — reconciling a per-fund-classified file the accessor wrote at the exchange level (issue #543)', () => {
  const HEADER = 'Timestamp\tDate\tType\tPrice\tBTC Amount\tUSDC Amount\tFees\tRebates\tNet Fees\tOrder ID\tFund Size\tBTC Reserves\tOutstanding USDC\tOutstanding BTC\tTotal Fees\tTotal Rebates';
  const row = (orderId) => `2026-01-0${orderId}T00:00:00.000Z\t2026-01-0${orderId}\tBUY\t100.00\t1.00000000\t100.00\t0.1000\t0.0000\t0.1000\torder-${orderId}\t1000.00\t1.00000000\t0.00\t0.00\t0.1000\t0.0000`;

  const exchangeDir = () => path.join(tmpDir, EXCHANGE);
  const fundDir = () => path.join(exchangeDir(), PAIR);

  it('is a no-op when neither the exchange-level nor per-fund file exists', () => {
    const result = migration.repairStrandedTransactionLog(EXCHANGE, PAIR);
    assert.deepEqual(result, { repaired: false, action: 'none', rowsAppended: 0 });
  });

  it('moves a lone exchange-level file into the fund directory', () => {
    const content = [HEADER, row(1), row(2)].join('\n') + '\n';
    writeLegacyFile(exchangeDir(), 'transactions.tsv', content);

    const result = migration.repairStrandedTransactionLog(EXCHANGE, PAIR);

    assert.equal(result.repaired, true);
    assert.equal(result.action, 'moved');
    assert.ok(!fs.existsSync(path.join(exchangeDir(), 'transactions.tsv')), 'exchange-level copy must be gone');
    assert.equal(fs.readFileSync(path.join(fundDir(), 'transactions.tsv'), 'utf8'), content, 'moved content must be byte-identical');
  });

  it('is a no-op when only the per-fund file exists (already reconciled)', () => {
    const content = [HEADER, row(1)].join('\n') + '\n';
    writeLegacyFile(fundDir(), 'transactions.tsv', content);

    const result = migration.repairStrandedTransactionLog(EXCHANGE, PAIR);

    assert.deepEqual(result, { repaired: false, action: 'none', rowsAppended: 0 });
    assert.equal(fs.readFileSync(path.join(fundDir(), 'transactions.tsv'), 'utf8'), content, 'per-fund file must be untouched');
  });

  it('appends the exchange-level data rows (never its header) and removes the stranded copy, with no duplicated rows and exactly one header', () => {
    const perFundContent = [HEADER, row(1), row(2)].join('\n') + '\n';
    const exchangeLevelContent = [HEADER, row(3), row(4)].join('\n') + '\n';
    writeLegacyFile(fundDir(), 'transactions.tsv', perFundContent);
    writeLegacyFile(exchangeDir(), 'transactions.tsv', exchangeLevelContent);

    const result = migration.repairStrandedTransactionLog(EXCHANGE, PAIR);

    assert.equal(result.repaired, true);
    assert.equal(result.action, 'merged');
    assert.equal(result.rowsAppended, 2);
    assert.ok(!fs.existsSync(path.join(exchangeDir(), 'transactions.tsv')), 'exchange-level copy must be removed');

    const merged = fs.readFileSync(path.join(fundDir(), 'transactions.tsv'), 'utf8');
    const lines = merged.split('\n').filter(Boolean);
    assert.equal(lines.filter(l => l === HEADER).length, 1, 'exactly one header line');
    // Row order preserved: exchange-level rows are strictly newer, so a plain
    // append keeps timestamp order — fund rows first, then exchange-level rows.
    assert.deepEqual(lines, [HEADER, row(1), row(2), row(3), row(4)]);
  });

  it('is idempotent: a second call after a move does nothing further', () => {
    const content = [HEADER, row(1)].join('\n') + '\n';
    writeLegacyFile(exchangeDir(), 'transactions.tsv', content);

    const first = migration.repairStrandedTransactionLog(EXCHANGE, PAIR);
    assert.equal(first.action, 'moved');

    const second = migration.repairStrandedTransactionLog(EXCHANGE, PAIR);
    assert.deepEqual(second, { repaired: false, action: 'none', rowsAppended: 0 });
    assert.equal(fs.readFileSync(path.join(fundDir(), 'transactions.tsv'), 'utf8'), content);
  });

  it('is idempotent: a second call after a merge duplicates no rows', () => {
    const perFundContent = [HEADER, row(1)].join('\n') + '\n';
    const exchangeLevelContent = [HEADER, row(2)].join('\n') + '\n';
    writeLegacyFile(fundDir(), 'transactions.tsv', perFundContent);
    writeLegacyFile(exchangeDir(), 'transactions.tsv', exchangeLevelContent);

    const first = migration.repairStrandedTransactionLog(EXCHANGE, PAIR);
    assert.equal(first.action, 'merged');
    const afterFirst = fs.readFileSync(path.join(fundDir(), 'transactions.tsv'), 'utf8');

    // Second call: nothing at the exchange level any more, so it's a plain no-op.
    const second = migration.repairStrandedTransactionLog(EXCHANGE, PAIR);
    assert.deepEqual(second, { repaired: false, action: 'none', rowsAppended: 0 });
    assert.equal(fs.readFileSync(path.join(fundDir(), 'transactions.tsv'), 'utf8'), afterFirst, 'no duplicate rows after a second call');
  });

  it('recovers idempotently from a crash between the merge write and deleting the stranded copy', () => {
    // Simulate the post-crash state directly: the fund file already reflects
    // the merge (exchange-level rows appended), but the stranded copy was
    // never deleted because the process died between the two steps.
    const mergedContent = [HEADER, row(1), row(2)].join('\n') + '\n';
    const staleExchangeLevelContent = [HEADER, row(2)].join('\n') + '\n';
    writeLegacyFile(fundDir(), 'transactions.tsv', mergedContent);
    writeLegacyFile(exchangeDir(), 'transactions.tsv', staleExchangeLevelContent);

    const result = migration.repairStrandedTransactionLog(EXCHANGE, PAIR);

    assert.equal(result.repaired, true);
    assert.equal(result.action, 'merged');
    assert.ok(!fs.existsSync(path.join(exchangeDir(), 'transactions.tsv')), 'stranded copy must be cleaned up');
    // Row must NOT be duplicated — the rewrite was skipped because row(2) was
    // already the tail of the fund file.
    assert.equal(fs.readFileSync(path.join(fundDir(), 'transactions.tsv'), 'utf8'), mergedContent);
  });

  it('treats an empty stranded file as nothing to append and just removes it', () => {
    writeLegacyFile(fundDir(), 'transactions.tsv', [HEADER, row(1)].join('\n') + '\n');
    writeLegacyFile(exchangeDir(), 'transactions.tsv', '');

    const result = migration.repairStrandedTransactionLog(EXCHANGE, PAIR);

    assert.equal(result.repaired, true);
    assert.equal(result.rowsAppended, 0);
    assert.ok(!fs.existsSync(path.join(exchangeDir(), 'transactions.tsv')));
    assert.equal(fs.readFileSync(path.join(fundDir(), 'transactions.tsv'), 'utf8'), [HEADER, row(1)].join('\n') + '\n');
  });

  it('treats a header-only stranded file as nothing to append and just removes it', () => {
    const perFundContent = [HEADER, row(1)].join('\n') + '\n';
    writeLegacyFile(fundDir(), 'transactions.tsv', perFundContent);
    writeLegacyFile(exchangeDir(), 'transactions.tsv', HEADER + '\n');

    const result = migration.repairStrandedTransactionLog(EXCHANGE, PAIR);

    assert.equal(result.rowsAppended, 0);
    assert.equal(fs.readFileSync(path.join(fundDir(), 'transactions.tsv'), 'utf8'), perFundContent);
  });

  it('merges correctly when the per-fund file is itself header-only', () => {
    writeLegacyFile(fundDir(), 'transactions.tsv', HEADER + '\n');
    writeLegacyFile(exchangeDir(), 'transactions.tsv', [HEADER, row(1)].join('\n') + '\n');

    const result = migration.repairStrandedTransactionLog(EXCHANGE, PAIR);

    assert.equal(result.action, 'merged');
    assert.equal(result.rowsAppended, 1);
    const lines = fs.readFileSync(path.join(fundDir(), 'transactions.tsv'), 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(lines, [HEADER, row(1)]);
  });

  it('does not glue rows together when the exchange-level file has no trailing newline', () => {
    const perFundContent = [HEADER, row(1)].join('\n') + '\n';
    const exchangeLevelContent = [HEADER, row(2)].join('\n'); // no trailing newline
    writeLegacyFile(fundDir(), 'transactions.tsv', perFundContent);
    writeLegacyFile(exchangeDir(), 'transactions.tsv', exchangeLevelContent);

    migration.repairStrandedTransactionLog(EXCHANGE, PAIR);

    const lines = fs.readFileSync(path.join(fundDir(), 'transactions.tsv'), 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(lines, [HEADER, row(1), row(2)], 'row(1) and row(2) must remain on separate lines');
  });

  it('does not glue rows together when the per-fund file has no trailing newline', () => {
    const perFundContent = [HEADER, row(1)].join('\n'); // no trailing newline
    const exchangeLevelContent = [HEADER, row(2)].join('\n') + '\n';
    writeLegacyFile(fundDir(), 'transactions.tsv', perFundContent);
    writeLegacyFile(exchangeDir(), 'transactions.tsv', exchangeLevelContent);

    migration.repairStrandedTransactionLog(EXCHANGE, PAIR);

    const lines = fs.readFileSync(path.join(fundDir(), 'transactions.tsv'), 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(lines, [HEADER, row(1), row(2)], 'row(1) and row(2) must remain on separate lines');
  });

  it('handles CRLF line endings in the stranded file without corrupting rows', () => {
    const perFundContent = [HEADER, row(1)].join('\n') + '\n';
    const exchangeLevelContent = [HEADER, row(2)].join('\r\n') + '\r\n';
    writeLegacyFile(fundDir(), 'transactions.tsv', perFundContent);
    writeLegacyFile(exchangeDir(), 'transactions.tsv', exchangeLevelContent);

    const result = migration.repairStrandedTransactionLog(EXCHANGE, PAIR);

    assert.equal(result.rowsAppended, 1);
    const lines = fs.readFileSync(path.join(fundDir(), 'transactions.tsv'), 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(lines, [HEADER, row(1), row(2)]);
  });
});

describe('migrateExchangeToPairs invokes the transaction-log repair in both branches (issue #543)', () => {
  const HEADER = 'Timestamp\tDate\tType\tPrice\tBTC Amount\tUSDC Amount\tFees\tRebates\tNet Fees\tOrder ID\tFund Size\tBTC Reserves\tOutstanding USDC\tOutstanding BTC\tTotal Fees\tTotal Rebates';
  const row = (orderId) => `2026-01-0${orderId}T00:00:00.000Z\t2026-01-0${orderId}\tBUY\t100.00\t1.00000000\t100.00\t0.1000\t0.0000\t0.1000\torder-${orderId}\t1000.00\t1.00000000\t0.00\t0.00\t0.1000\t0.0000`;

  it('reconciles a stranded transactions.tsv even when needsPairMigration is false (already-migrated install)', () => {
    const exchangeDir = path.join(tmpDir, EXCHANGE);
    const fundDir = path.join(exchangeDir, PAIR);
    // Already-migrated layout: state lives in the fund dir.
    writeLegacyFile(fundDir, 'state.json', '{}');
    writeLegacyFile(fundDir, 'transactions.tsv', [HEADER, row(1)].join('\n') + '\n');
    // Post-migration bug recreated an exchange-level copy.
    writeLegacyFile(exchangeDir, 'transactions.tsv', [HEADER, row(2)].join('\n') + '\n');

    assert.equal(migration.needsPairMigration(EXCHANGE), false);

    const result = migration.migrateExchangeToPairs(EXCHANGE);

    assert.equal(result.migrated, false, 'the rest of migration has nothing to do');
    assert.equal(result.transactionLogRepair.repaired, true);
    assert.equal(result.transactionLogRepair.action, 'merged');
    assert.ok(!fs.existsSync(path.join(exchangeDir, 'transactions.tsv')));
    const lines = fs.readFileSync(path.join(fundDir, 'transactions.tsv'), 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(lines, [HEADER, row(1), row(2)]);
  });

  it('reconciles a stranded transactions.tsv during a full legacy migration when normalizeExchangeTreeToPairs skipped it', () => {
    const exchangeDir = path.join(tmpDir, EXCHANGE);
    const fundDir = path.join(exchangeDir, PAIR);
    // Legacy layout not yet migrated (state.json at exchange level)...
    writeLegacyFile(exchangeDir, 'state.json', '{}');
    // ...but a per-fund transactions.tsv already exists from a previous
    // partial migration attempt, AND a fresh exchange-level copy was
    // recreated by the unpatched accessor since.
    writeLegacyFile(fundDir, 'transactions.tsv', [HEADER, row(1)].join('\n') + '\n');
    writeLegacyFile(exchangeDir, 'transactions.tsv', [HEADER, row(2)].join('\n') + '\n');

    const result = migration.migrateExchangeToPairs(EXCHANGE);

    assert.equal(result.migrated, true);
    assert.deepEqual(result.skippedFiles, ['transactions.tsv'], 'the generic move must skip the colliding file');
    assert.equal(result.transactionLogRepair.repaired, true);
    assert.equal(result.transactionLogRepair.action, 'merged');
    assert.ok(!fs.existsSync(path.join(exchangeDir, 'transactions.tsv')));
    const lines = fs.readFileSync(path.join(fundDir, 'transactions.tsv'), 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(lines, [HEADER, row(1), row(2)]);
  });

  it('a plain never-migrated install moves transactions.tsv via the generic per-fund move, and the repair is then a no-op', () => {
    const exchangeDir = path.join(tmpDir, EXCHANGE);
    const fundDir = path.join(exchangeDir, PAIR);
    writeLegacyFile(exchangeDir, 'state.json', '{}');
    writeLegacyFile(exchangeDir, 'transactions.tsv', [HEADER, row(1)].join('\n') + '\n');

    const result = migration.migrateExchangeToPairs(EXCHANGE);

    assert.equal(result.migrated, true);
    assert.ok(result.skippedFiles.length === 0 || !result.skippedFiles.includes('transactions.tsv'));
    assert.deepEqual(result.transactionLogRepair, { repaired: false, action: 'none', rowsAppended: 0 });
    assert.ok(!fs.existsSync(path.join(exchangeDir, 'transactions.tsv')));
    assert.equal(fs.readFileSync(path.join(fundDir, 'transactions.tsv'), 'utf8'), [HEADER, row(1)].join('\n') + '\n');
  });
});
