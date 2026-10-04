// @ts-check
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

// issue #971 — the legacy root → data/coinbase/ namespace migration:
//  - its gate looked only at state.json, which it moved FIRST, so a failure on
//    a later artifact stranded it (notably transactions.tsv) forever;
//  - its renameSync replaced an existing exchange-level target, keeping only a
//    backup of the SOURCE generation.
//
// Every fixture lives under fs.mkdtempSync — nothing here touches the
// repository's real data/ directory. `pathsModule.APP_ROOT` / `DATA_DIR` are
// mutated and src/migration.js (and src/logger.js, which captures
// migration's resolveFundDataDir) are re-required fresh, the idiom used by
// tests/migration-pair-layout.test.js and tests/migration-keys.test.js.

const migrationPath = require.resolve('../src/migration');
const loggerPath = require.resolve('../src/logger');
const nsPath = require.resolve('../src/legacy-namespace-migration');
const pathsModule = require('../src/paths');
const configUtils = require('../src/config-utils');
const ns = require('../src/legacy-namespace-migration');

const originalAppRoot = pathsModule.APP_ROOT;
const originalDataDir = pathsModule.DATA_DIR;
const originalGetDefaultPair = configUtils.getDefaultPair;

const PAIR = 'BTC-USDC';

/** @type {string} */
let tmpDir;
/** @type {string} */
let dataDir;
/** @type {any} */
let migration;

const fresh = () => {
  pathsModule.APP_ROOT = tmpDir;
  pathsModule.DATA_DIR = dataDir;
  delete require.cache[migrationPath];
  delete require.cache[loggerPath];
  return require('../src/migration');
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-namespace-test-'));
  dataDir = path.join(tmpDir, 'data');
  configUtils.getDefaultPair = () => PAIR;
  migration = fresh();
});

afterEach(() => {
  mock.restoreAll();
  configUtils.getDefaultPair = originalGetDefaultPair;
  pathsModule.APP_ROOT = originalAppRoot;
  pathsModule.DATA_DIR = originalDataDir;
  delete require.cache[migrationPath];
  delete require.cache[loggerPath];
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const TX_HEADER = 'Timestamp\tDate\tType\tPrice\tBTC Amount\tUSDC Amount\tFees\tRebates\tNet Fees\tOrder ID\tFund Size';
const txLog = (...ids) => [TX_HEADER, ...ids.map((id, i) => `${1700000000000 + i}\t2023-11-14\tBUY\t35000\t0.001\t35\t0.1\t0\t0.1\t${id}\t1000`)].join('\n') + '\n';

const LEGACY = {
  'state.json': JSON.stringify({ totalAllocated: 120, intervalsRun: 4 }),
  'transactions.tsv': txLog('order-a', 'order-b', 'order-c'),
  'optimizer-cache.json': JSON.stringify({ best: { markup: 2 } }),
  'btc-price-cache-5min.json': JSON.stringify({ prices: [{ timestamp: 1, close: 1 }] }),
  'btc-price-cache-daily.json': JSON.stringify({ prices: [{ timestamp: 2, close: 2 }] }),
};
const ORDER = ['state.json', 'transactions.tsv', 'optimizer-cache.json', 'btc-price-cache-5min.json', 'btc-price-cache-daily.json'];

const seedLegacy = (files = LEGACY) => {
  fs.mkdirSync(dataDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dataDir, name), content);
};
const root = (name) => path.join(dataDir, name);
const exch = (name) => path.join(dataDir, 'coinbase', name);
const read = (p) => fs.readFileSync(p, 'utf8');

/** Snapshot every file under dataDir (relative path → bytes). */
const snapshot = () => {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dataDir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  if (fs.existsSync(dataDir)) walk(dataDir);
  return out;
};

const assertFullyMigrated = () => {
  for (const [name, content] of Object.entries(LEGACY)) {
    assert.equal(fs.existsSync(root(name)), false, `${name} must be gone from the data root`);
    assert.equal(read(exch(name)), content, `${name} bytes preserved at coinbase/`);
    assert.equal(read(root(`${name}.backup`)), content, `${name}.backup holds the original bytes`);
  }
  assert.equal(fs.existsSync(root(ns.LOCK_FILENAME)), false, 'lock released');
};

describe('legacy namespace migration — happy path and idempotency (issue #971)', () => {
  it('moves the whole legacy inventory, keeps .backup copies, and a repeat start is a no-op', () => {
    seedLegacy();
    assert.equal(migration.needsMigration(), true);

    const first = migration.runMigrationIfNeeded();
    assert.equal(first.dataMigrated, true);
    assert.equal(first.blocked, false);
    assert.deepEqual(first.namespace.moved, ORDER);
    assertFullyMigrated();
    assert.ok(fs.existsSync(path.join(dataDir, 'gemini')), 'gemini dir created as before');

    const before = snapshot();
    const second = migration.runMigrationIfNeeded();
    assert.equal(second.dataMigrated, false);
    assert.equal(second.namespace.status, 'none');
    assert.equal(migration.needsMigration(), false);
    assert.deepEqual(snapshot(), before, 'repeat start changes nothing and recreates no legacy file');
  });

  it('an empty install stays empty: no data directory is conjured', () => {
    const result = migration.runMigrationIfNeeded();
    assert.equal(result.namespace.status, 'none');
    assert.equal(result.blocked, false);
    assert.equal(fs.existsSync(dataDir), false);
  });

  it('an already-migrated install is untouched (including pre-existing backups)', () => {
    fs.mkdirSync(path.join(dataDir, 'coinbase', PAIR), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'coinbase', PAIR, 'state.json'), 'per-fund');
    fs.writeFileSync(root('state.json.backup'), 'old-backup');
    const before = snapshot();
    const result = migration.runMigrationIfNeeded();
    assert.equal(result.namespace.status, 'none');
    assert.deepEqual(snapshot(), before);
  });

  it('a byte-identical copy already at the target is reconciled by retiring the root copy', () => {
    seedLegacy({ 'transactions.tsv': LEGACY['transactions.tsv'] });
    fs.mkdirSync(path.join(dataDir, 'coinbase'), { recursive: true });
    fs.writeFileSync(exch('transactions.tsv'), LEGACY['transactions.tsv']);

    const result = migration.runMigrationIfNeeded();
    assert.equal(result.namespace.status, 'migrated');
    assert.deepEqual(result.namespace.reconciled, ['transactions.tsv']);
    assert.equal(fs.existsSync(root('transactions.tsv')), false);
    assert.equal(read(exch('transactions.tsv')), LEGACY['transactions.tsv']);
  });
});

describe('legacy namespace migration — interruption and resume (issue #971)', () => {
  for (let k = 0; k < ORDER.length; k++) {
    it(`a failure placing artifact #${k + 1} (${ORDER[k]}) is resumed on the next start`, () => {
      seedLegacy();
      const realLink = fs.linkSync;
      let placements = 0;
      mock.method(fs, 'linkSync', (src, dst) => {
        // Only placements into coinbase/ count; backup links pass through.
        if (String(dst).includes(`${path.sep}coinbase${path.sep}`) && placements++ === k) {
          throw Object.assign(new Error('simulated EIO'), { code: 'EIO' });
        }
        return realLink(src, dst);
      });

      const first = migration.runMigrationIfNeeded();
      assert.equal(first.blocked, true);
      assert.equal(first.namespace.status, 'error');
      assert.deepEqual(first.namespace.moved, ORDER.slice(0, k));
      for (const name of ORDER.slice(k)) assert.equal(read(root(name)), LEGACY[name], `${name} still pending at root`);
      assert.equal(fs.existsSync(root(ns.LOCK_FILENAME)), false, 'lock released after failure');

      mock.restoreAll();
      assert.equal(migration.needsMigration(), true, 'remaining artifacts are still discovered');
      const second = migration.runMigrationIfNeeded();
      assert.equal(second.namespace.status, 'migrated');
      assert.deepEqual(second.namespace.moved, ORDER.slice(k));
      assertFullyMigrated();
    });
  }

  it('the issue scenario: state.json already moved, transactions.tsv left at root, is retried', () => {
    seedLegacy({ 'transactions.tsv': LEGACY['transactions.tsv'] });
    fs.mkdirSync(path.join(dataDir, 'coinbase'), { recursive: true });
    fs.writeFileSync(exch('state.json'), LEGACY['state.json']);

    const result = migration.runMigrationIfNeeded();
    assert.equal(result.dataMigrated, true);
    assert.deepEqual(result.namespace.moved, ['transactions.tsv']);
    assert.equal(read(exch('transactions.tsv')), LEGACY['transactions.tsv']);
  });

  it('a crash between placing the target and removing the source reconciles without duplication', () => {
    seedLegacy({ 'transactions.tsv': LEGACY['transactions.tsv'] });
    const realUnlink = fs.unlinkSync;
    mock.method(fs, 'unlinkSync', (p) => {
      if (p === root('transactions.tsv')) throw Object.assign(new Error('simulated crash'), { code: 'EIO' });
      return realUnlink(p);
    });
    const first = migration.runMigrationIfNeeded();
    assert.equal(first.namespace.status, 'error');
    assert.equal(read(root('transactions.tsv')), LEGACY['transactions.tsv']);
    assert.equal(read(exch('transactions.tsv')), LEGACY['transactions.tsv']);

    mock.restoreAll();
    const second = migration.runMigrationIfNeeded();
    assert.equal(second.namespace.status, 'migrated');
    assert.deepEqual(second.namespace.reconciled, ['transactions.tsv']);
    assert.equal(fs.existsSync(root('transactions.tsv')), false);
    assert.equal(read(exch('transactions.tsv')), LEGACY['transactions.tsv']);
  });

  it('after namespace + pair migration, the real transaction reader returns the original history', () => {
    // Interrupted first upgrade stage: state moved, history stranded at root.
    seedLegacy({ 'transactions.tsv': LEGACY['transactions.tsv'] });
    fs.mkdirSync(path.join(dataDir, 'coinbase'), { recursive: true });
    fs.writeFileSync(exch('state.json'), LEGACY['state.json']);

    migration.runMigrationIfNeeded();
    const pair = migration.migrateExchangeToPairs('coinbase');
    assert.equal(pair.migrated, true);

    const logger = require('../src/logger');
    const history = logger.loadTransactionHistory('coinbase', PAIR);
    assert.deepEqual(history.map((r) => r['Order ID']), ['order-a', 'order-b', 'order-c']);
    assert.equal(read(path.join(dataDir, 'coinbase', PAIR, 'transactions.tsv')), LEGACY['transactions.tsv']);
  });
});

describe('legacy namespace migration — conflicts fail closed (issue #971)', () => {
  it('different exchange-level bytes block startup before ANY move; both generations and backups stay intact', () => {
    seedLegacy();
    fs.mkdirSync(path.join(dataDir, 'coinbase'), { recursive: true });
    fs.writeFileSync(exch('transactions.tsv'), txLog('newer-x'));
    fs.writeFileSync(root('transactions.tsv.backup'), 'earlier-backup-generation');
    const before = snapshot();

    const errors = [];
    const exits = [];
    const result = migration.guardLegacyMigration({
      processLabel: 'gateway',
      logger: { error: (m) => errors.push(m) },
      exit: (code) => exits.push(code),
    });

    assert.equal(result.blocked, true);
    assert.equal(result.namespace.status, 'conflict');
    assert.deepEqual(result.namespace.conflicts, [{
      artifact: 'transactions.tsv',
      source: path.join('data', 'transactions.tsv'),
      target: path.join('data', 'coinbase', 'transactions.tsv'),
      reason: 'source and existing target hold different bytes',
    }]);
    assert.deepEqual(exits, [1]);
    assert.ok(errors.some((m) => m.includes(`${path.join('data', 'transactions.tsv')} vs ${path.join('data', 'coinbase', 'transactions.tsv')}`)), 'relative paths in recovery output');
    assert.deepEqual(snapshot(), before, 'nothing moved, nothing backed up, nothing overwritten');

    // Repeated starts stay blocked and still change nothing.
    assert.equal(migration.runMigrationIfNeeded().blocked, true);
    assert.deepEqual(snapshot(), before);
  });

  it('a differing copy the pair migration already placed in the default fund directory is a conflict too', () => {
    seedLegacy({ 'transactions.tsv': LEGACY['transactions.tsv'] });
    const fundDir = path.join(dataDir, 'coinbase', PAIR);
    fs.mkdirSync(fundDir, { recursive: true });
    fs.writeFileSync(path.join(fundDir, 'transactions.tsv'), txLog('post-upgrade'));
    const before = snapshot();

    const result = migration.runMigrationIfNeeded();
    assert.equal(result.namespace.status, 'conflict');
    assert.equal(result.namespace.conflicts[0].target, path.join('data', 'coinbase', PAIR, 'transactions.tsv'));
    assert.deepEqual(snapshot(), before);
  });

  it('an identical exchange-level copy does not hide a differing fund-directory generation', () => {
    seedLegacy({ 'transactions.tsv': LEGACY['transactions.tsv'] });
    const fundDir = path.join(dataDir, 'coinbase', PAIR);
    fs.mkdirSync(fundDir, { recursive: true });
    fs.writeFileSync(exch('transactions.tsv'), LEGACY['transactions.tsv']);
    fs.writeFileSync(path.join(fundDir, 'transactions.tsv'), txLog('post-upgrade'));
    const before = snapshot();

    const result = migration.runMigrationIfNeeded();
    assert.equal(result.namespace.status, 'conflict');
    assert.equal(result.namespace.conflicts[0].target, path.join('data', 'coinbase', PAIR, 'transactions.tsv'));
    assert.deepEqual(snapshot(), before, 'root copy kept; nothing retired');
  });

  it('an identical copy in the default fund directory is reconciled', () => {
    seedLegacy({ 'state.json': LEGACY['state.json'] });
    const fundDir = path.join(dataDir, 'coinbase', PAIR);
    fs.mkdirSync(fundDir, { recursive: true });
    fs.writeFileSync(path.join(fundDir, 'state.json'), LEGACY['state.json']);

    const result = migration.runMigrationIfNeeded();
    assert.deepEqual(result.namespace.reconciled, ['state.json']);
    assert.equal(fs.existsSync(root('state.json')), false);
    assert.equal(fs.existsSync(exch('state.json')), false, 'no exchange-level copy reintroduced');
  });
});

describe('legacy namespace migration — cross-process ownership (issue #971)', () => {
  const runChild = () => new Promise((resolve, reject) => {
    const script = `
      const ns = require(${JSON.stringify(nsPath)});
      const r = ns.migrateLegacyNamespace({ dataDir: ${JSON.stringify(dataDir)} });
      process.stdout.write(JSON.stringify(r));
    `;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', () => resolve(JSON.parse(out.slice(out.lastIndexOf('{"status"')))));
  });

  const writeLock = (pid, ageMs = 0) => {
    const lockPath = root(ns.LOCK_FILENAME);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid, token: 'other-owner' }));
    if (ageMs) {
      const t = new Date(Date.now() - ageMs);
      fs.utimesSync(lockPath, t, t);
    }
    return lockPath;
  };

  it('a live owner keeps the migration: a second starter reports busy and moves nothing', () => {
    seedLegacy();
    writeLock(process.pid);
    const before = snapshot();
    const result = ns.migrateLegacyNamespace({ dataDir, lock: { waitMs: 100, pollMs: 10 } });
    assert.equal(result.status, 'busy');
    assert.deepEqual(snapshot(), before);
  });

  it('a held lock blocks even when nothing looks pending (the owner may be mid-way)', () => {
    writeLock(process.pid);
    const result = ns.migrateLegacyNamespace({ dataDir, lock: { waitMs: 50, pollMs: 10 } });
    assert.equal(result.status, 'busy');
  });

  it('a lock left by a dead process is broken and the migration completes', () => {
    seedLegacy();
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    writeLock(dead);
    const result = ns.migrateLegacyNamespace({ dataDir, lock: { waitMs: 1000, pollMs: 10 } });
    assert.equal(result.status, 'migrated');
    assertFullyMigrated();
    assert.deepEqual(fs.readdirSync(dataDir).filter((n) => n.startsWith(ns.LOCK_FILENAME)), [], 'no tombstone left');
  });

  it('a lock silent past the stale window is broken even if its pid is (re)used by a live process', () => {
    seedLegacy();
    writeLock(process.pid, ns.LOCK_STALE_MS + 60000);
    const result = ns.migrateLegacyNamespace({ dataDir, lock: { waitMs: 1000, pollMs: 10 } });
    assert.equal(result.status, 'migrated');
    assertFullyMigrated();
  });

  it('stale recovery never removes a lock another starter re-acquired after we judged it stale', () => {
    // Starter B observed a dead owner's lock; before B breaks it, starter C
    // broke it and took a fresh, live lock. B's break must leave C's alone.
    const lockPath = writeLock(process.pid);
    const freshBefore = read(lockPath);
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    const isStale = (owner) => owner.pid === deadPid;
    ns.breakStaleLock(lockPath, isStale);
    assert.equal(read(lockPath), freshBefore, 'live lock untouched');
    assert.equal(fs.existsSync(`${lockPath}.break`), false, 'breaker marker released');
  });

  it('only one starter breaks at a time; an abandoned breaker marker is cleared', () => {
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    const lockPath = writeLock(deadPid);
    const breakPath = `${lockPath}.break`;
    fs.writeFileSync(breakPath, '');
    const isStale = () => true;

    ns.breakStaleLock(lockPath, isStale);
    assert.ok(fs.existsSync(lockPath), 'another breaker holds the marker: lock left for it');
    assert.ok(fs.existsSync(breakPath), 'a fresh marker is respected');

    const old = new Date(Date.now() - 60000);
    fs.utimesSync(breakPath, old, old);
    ns.breakStaleLock(lockPath, isStale);
    assert.equal(fs.existsSync(breakPath), false, 'abandoned marker cleared');
    ns.breakStaleLock(lockPath, isStale);
    assert.equal(fs.existsSync(lockPath), false, 'stale lock then broken');
  });

  it('concurrent starters with an abandoned lock still migrate each artifact exactly once', async () => {
    seedLegacy();
    writeLock(spawnSync(process.execPath, ['-e', '']).pid);
    const results = await Promise.all(Array.from({ length: 5 }, () => runChild()));
    for (const r of results) assert.ok(['migrated', 'none'].includes(r.status), `unexpected status ${r.status}: ${r.error}`);
    assert.deepEqual(results.flatMap((r) => r.moved).sort(), [...ORDER].sort());
    assertFullyMigrated();
  });

  it('concurrent starters never clobber a target and leave a fully migrated namespace', async () => {
    seedLegacy();
    const results = await Promise.all(Array.from({ length: 5 }, () => runChild()));

    for (const r of results) assert.ok(['migrated', 'none'].includes(r.status), `unexpected status ${r.status}: ${r.error}`);
    const moved = results.flatMap((r) => r.moved);
    assert.deepEqual([...moved].sort(), [...ORDER].sort(), 'each artifact moved exactly once across all starters');
    assertFullyMigrated();
  });
});
