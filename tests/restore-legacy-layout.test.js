// @ts-check
/**
 * Issue #541 — an archive taken before the multi-pair release stores its
 * per-fund files at `<exchange>/`, but every reader now looks under
 * `<exchange>/<pair>/`. Restore applied the archive 1:1, so on a destination
 * that had already migrated the recovered files landed where nothing reads
 * them: the restore reported success while the engine resumed on the very
 * state the operator was trying to replace.
 *
 * Covers:
 *  - src/migration.js: normalizeExchangeTreeToPairs as a root-relative,
 *    idempotent, skip-on-conflict relocation shared with the live migration.
 *  - src/backup-service.js: the translation running inside the staging tree
 *    (so the rollback journal covers the translated destinations), the pair
 *    coming from the archive's snapshot, the pre-write abort when no pair can
 *    be resolved, and inspectBackup's pre-flight disclosure.
 *
 * Everything runs inside temp directories; nothing here touches the live install.
 */
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createBackup, restoreBackup, inspectBackup, checkRestorePreconditions } = require('../src/backup-service');
const { migrateLegacyNamespace } = require('../src/legacy-namespace-migration');
const { normalizeExchangeTreeToPairs } = require('../src/migration');
const { JOURNAL_FILENAME } = require('../src/restore-apply');
const { ledgerOf } = require('./helpers/ledger-fixture');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** @type {string[]} */
const roots = [];
/** @type {string} */
let root;

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
};

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

/** A config naming exactly one fund per exchange. */
const configWith = (funds) => ({
  exchanges: Object.fromEntries(Object.entries(funds).map(([exchange, pair]) => [
    exchange,
    { pairs: { [pair]: { productId: pair, totalAllocation: 1000, enabled: true, dryRun: false } } },
  ])),
  global: { schedulerInterval: 30000 },
});

/**
 * Materialize an install: data directory plus its own base config file.
 * @param {string} name
 * @param {Object} baseConfig
 */
const makeInstall = (name, baseConfig) => {
  const dataDir = path.join(root, name, 'data');
  const baseConfigFile = path.join(root, name, 'config.json');
  fs.mkdirSync(dataDir, { recursive: true });
  writeJson(baseConfigFile, baseConfig);
  writeJson(path.join(dataDir, 'config.json'), {});
  return { dataDir, baseConfigFile, paths: { dataDir, baseConfigFile } };
};

/** Copy an archive from one install's backups dir into another's. */
const transferArchive = (from, to, filename) => {
  const dest = path.join(to.dataDir, 'backups');
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(from.dataDir, 'backups', filename), path.join(dest, filename));
};

/** Build an archive whose per-fund files sit at the EXCHANGE level. */
const makeLegacyLayoutArchive = async (sourceConfig, files) => {
  const source = makeInstall(`source-${roots.length}-${Object.keys(files).join('-').length}`, sourceConfig);
  for (const [rel, text] of Object.entries(files)) write(path.join(source.dataDir, rel), text);
  const created = await createBackup({ paths: source.paths });
  assert.equal(created.success, true, created.error);
  return { source, filename: /** @type {string} */ (created.filename) };
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-legacy-layout-'));
  roots.push(root);
});

afterEach(() => {
  mock.restoreAll();
  while (roots.length > 0) fs.rmSync(/** @type {string} */ (roots.pop()), { recursive: true, force: true });
});

describe('normalizeExchangeTreeToPairs (issue #541)', () => {
  it('moves exchange-level per-fund files into the pair subdirectory', async () => {
    write(path.join(root, 'coinbase', 'state.json'), '{"legacy":true}');
    write(path.join(root, 'coinbase', 'fill-ledger.json'), 'ledger');
    write(path.join(root, 'coinbase', 'btc-usdc-price-cache-1min.json'), 'cache');
    write(path.join(root, 'coinbase', 'long-term-candles-btc-usdc.json'), 'candles');

    const result = normalizeExchangeTreeToPairs({ root, exchange: 'coinbase', pair: 'BTC-USDC' });

    assert.deepEqual(result.moved.sort(), ['fill-ledger.json', 'state.json']);
    assert.deepEqual(result.skipped, []);
    assert.equal(read(path.join(root, 'coinbase', 'BTC-USDC', 'state.json')), '{"legacy":true}');
    // Exchange-level by design — the productId in the name already disambiguates.
    // Both the long-term candle store (#535) and the backtest price caches (#565)
    // are read and written at data/<exchange>/, so the restore must leave them there.
    assert.equal(read(path.join(root, 'coinbase', 'long-term-candles-btc-usdc.json')), 'candles');
    assert.equal(read(path.join(root, 'coinbase', 'btc-usdc-price-cache-1min.json')), 'cache');
    assert.equal(read(path.join(root, 'coinbase', 'BTC-USDC', 'btc-usdc-price-cache-1min.json')), null);
    assert.equal(read(path.join(root, 'coinbase', 'state.json')), null);
  });

  it('is a no-op on a tree already in per-fund layout and creates no pair directory', async () => {
    write(path.join(root, 'coinbase', 'BTC-USDC', 'state.json'), 'current');

    const result = normalizeExchangeTreeToPairs({ root, exchange: 'coinbase', pair: 'ETH-USDC' });

    assert.deepEqual(result, { moved: [], skipped: [] });
    assert.deepEqual(fs.readdirSync(path.join(root, 'coinbase')), ['BTC-USDC']);
  });

  it('skips rather than overwrites a file already at the target', async () => {
    write(path.join(root, 'coinbase', 'state.json'), 'legacy');
    write(path.join(root, 'coinbase', 'BTC-USDC', 'state.json'), 'newer');

    const result = normalizeExchangeTreeToPairs({ root, exchange: 'coinbase', pair: 'BTC-USDC' });

    assert.deepEqual(result, { moved: [], skipped: ['state.json'] });
    assert.equal(read(path.join(root, 'coinbase', 'BTC-USDC', 'state.json')), 'newer');
    assert.equal(read(path.join(root, 'coinbase', 'state.json')), 'legacy');
  });

  it('refuses a pair that would escape the exchange directory', async () => {
    write(path.join(root, 'coinbase', 'state.json'), 'legacy');
    assert.throws(
      () => normalizeExchangeTreeToPairs({ root, exchange: 'coinbase', pair: '../../escape' }),
      /escapes exchange data directory/,
    );
  });
});

const ARCHIVED_LEDGER = JSON.stringify(ledgerOf('archived'));
const LIVE_LEDGER = JSON.stringify(ledgerOf('live'));

describe('restoreBackup translates a pre-multi-pair archive (issue #541)', () => {
  it('relocates exchange-level files onto a destination that already holds per-fund files', async () => {
    const { source, filename } = await makeLegacyLayoutArchive(configWith({ coinbase: 'BTC-USDC' }), {
      'coinbase/state.json': '{"generation":"archived"}',
      'coinbase/fill-ledger.json': ARCHIVED_LEDGER,
      'coinbase/regime-state.json': '{"regime":"archived"}',
    });

    const dest = makeInstall('dest', configWith({ coinbase: 'BTC-USDC' }));
    write(path.join(dest.dataDir, 'coinbase', 'BTC-USDC', 'state.json'), '{"generation":"corrupt"}');
    write(path.join(dest.dataDir, 'coinbase', 'BTC-USDC', 'fill-ledger.json'), 'corrupt-ledger');
    transferArchive(source, dest, filename);

    const result = restoreBackup(filename, { paths: dest.paths, logger: silentLogger });
    assert.equal(result.success, true, result.error);

    const fundDir = path.join(dest.dataDir, 'coinbase', 'BTC-USDC');
    assert.equal(read(path.join(fundDir, 'state.json')), '{"generation":"archived"}');
    assert.equal(read(path.join(fundDir, 'fill-ledger.json')), ARCHIVED_LEDGER);
    assert.equal(read(path.join(fundDir, 'regime-state.json')), '{"regime":"archived"}');
    // Nothing stranded at the exchange level to re-trigger the startup migration.
    assert.equal(read(path.join(dest.dataDir, 'coinbase', 'state.json')), null);
    assert.equal(read(path.join(dest.dataDir, 'coinbase', 'fill-ledger.json')), null);
    // No bookkeeping left behind.
    assert.deepEqual(fs.readdirSync(dest.dataDir).filter((n) => n.startsWith('.restore-')), []);
  });

  it('relocates closed-trades.json and manual-trades.json instead of deleting the destination copies (issue #1842)', async () => {
    const { source, filename } = await makeLegacyLayoutArchive(configWith({ coinbase: 'BTC-USDC' }), {
      'coinbase/state.json': '{"generation":"archived"}',
      'coinbase/fill-ledger.json': ARCHIVED_LEDGER,
      'coinbase/closed-trades.json': '[{"trade":"closed-1"}]',
      'coinbase/manual-trades.json': '[{"trade":"manual-1"}]',
    });

    const dest = makeInstall('dest', configWith({ coinbase: 'BTC-USDC' }));
    const fundDir = path.join(dest.dataDir, 'coinbase', 'BTC-USDC');
    write(path.join(fundDir, 'closed-trades.json'), '[{"trade":"destination-closed"}]');
    write(path.join(fundDir, 'manual-trades.json'), '[{"trade":"destination-manual"}]');
    transferArchive(source, dest, filename);

    const result = restoreBackup(filename, { paths: dest.paths, logger: silentLogger });
    assert.equal(result.success, true, result.error);

    assert.equal(read(path.join(fundDir, 'closed-trades.json')), '[{"trade":"closed-1"}]');
    assert.equal(read(path.join(fundDir, 'manual-trades.json')), '[{"trade":"manual-1"}]');
    // Nothing stranded at the exchange level where no reader looks.
    assert.equal(read(path.join(dest.dataDir, 'coinbase', 'closed-trades.json')), null);
    assert.equal(read(path.join(dest.dataDir, 'coinbase', 'manual-trades.json')), null);
  });

  it('takes the pair from the archive snapshot, not the destination default', async () => {
    const { source, filename } = await makeLegacyLayoutArchive(configWith({ coinbase: 'ETH-USDC' }), {
      'coinbase/state.json': '{"fund":"ETH-USDC"}',
    });

    const dest = makeInstall('dest', configWith({ coinbase: 'BTC-USDC' }));
    write(path.join(dest.dataDir, 'coinbase', 'BTC-USDC', 'state.json'), '{"fund":"BTC-USDC"}');
    transferArchive(source, dest, filename);

    const result = restoreBackup(filename, { paths: dest.paths, acceptFundRemoval: true, logger: silentLogger });
    assert.equal(result.success, true, result.error);

    assert.equal(read(path.join(dest.dataDir, 'coinbase', 'ETH-USDC', 'state.json')), '{"fund":"ETH-USDC"}');
    // The destination's own fund is left exactly as it was.
    assert.equal(read(path.join(dest.dataDir, 'coinbase', 'BTC-USDC', 'state.json')), '{"fund":"BTC-USDC"}');
  });

  it('falls back to the destination default for a manifest-less data-only restore', async () => {
    const { source, filename } = await makeLegacyLayoutArchive(configWith({ coinbase: 'BTC-USDC' }), {
      'coinbase/state.json': '{"generation":"archived"}',
    });
    // Strip the manifest to reproduce a pre-v2.24.1 archive.
    const zipPath = path.join(source.dataDir, 'backups', filename);
    require('child_process').spawnSync('zip', ['-q', '-d', zipPath, 'backup-manifest.json']);

    const dest = makeInstall('dest', configWith({ coinbase: 'BTC-USDC' }));
    write(path.join(dest.dataDir, 'coinbase', 'BTC-USDC', 'state.json'), '{"generation":"corrupt"}');
    transferArchive(source, dest, filename);

    const result = restoreBackup(filename, { paths: dest.paths, acceptLegacyWithoutBase: true, logger: silentLogger });
    assert.equal(result.success, true, result.error);
    assert.equal(result.legacy, true);
    assert.equal(read(path.join(dest.dataDir, 'coinbase', 'BTC-USDC', 'state.json')), '{"generation":"archived"}');
  });

  it('aborts before any destination write when no pair can be resolved', async () => {
    const { source, filename } = await makeLegacyLayoutArchive(configWith({ coinbase: 'BTC-USDC' }), {
      'kraken/state.json': '{"orphan":true}',
      'coinbase/BTC-USDC/state.json': '{"generation":"archived"}',
    });

    const dest = makeInstall('dest', configWith({ coinbase: 'BTC-USDC' }));
    write(path.join(dest.dataDir, 'coinbase', 'BTC-USDC', 'state.json'), '{"generation":"live"}');
    transferArchive(source, dest, filename);

    const result = restoreBackup(filename, { paths: dest.paths, logger: silentLogger });
    assert.equal(result.success, false);
    assert.equal(result.code, 'legacy-layout-unresolvable-pair');
    assert.match(String(result.error), /kraken/);
    // Nothing was written, and no staging or journal was left behind.
    assert.equal(read(path.join(dest.dataDir, 'coinbase', 'BTC-USDC', 'state.json')), '{"generation":"live"}');
    assert.equal(fs.existsSync(path.join(dest.dataDir, 'kraken')), false);
    assert.equal(fs.existsSync(path.join(dest.dataDir, JOURNAL_FILENAME)), false);
    assert.deepEqual(fs.readdirSync(dest.dataDir).filter((n) => n.startsWith('.restore-')), []);
  });

  it('leaves an archive already in per-fund layout untouched', async () => {
    const { source, filename } = await makeLegacyLayoutArchive(configWith({ coinbase: 'BTC-USDC' }), {
      'coinbase/BTC-USDC/state.json': '{"generation":"archived"}',
      'coinbase/long-term-candles-btc-usdc.json': 'candles',
    });

    const dest = makeInstall('dest', configWith({ coinbase: 'BTC-USDC' }));
    write(path.join(dest.dataDir, 'coinbase', 'BTC-USDC', 'state.json'), '{"generation":"corrupt"}');
    transferArchive(source, dest, filename);

    const result = restoreBackup(filename, { paths: dest.paths, logger: silentLogger });
    assert.equal(result.success, true, result.error);
    assert.equal(read(path.join(dest.dataDir, 'coinbase', 'BTC-USDC', 'state.json')), '{"generation":"archived"}');
    assert.equal(read(path.join(dest.dataDir, 'coinbase', 'long-term-candles-btc-usdc.json')), 'candles');
    assert.deepEqual(fs.readdirSync(path.join(dest.dataDir, 'coinbase')).sort(), ['BTC-USDC', 'long-term-candles-btc-usdc.json']);
  });

  it('rolls the translated destinations back when the application fails mid-apply', async () => {
    const { source, filename } = await makeLegacyLayoutArchive(configWith({ coinbase: 'BTC-USDC' }), {
      'coinbase/state.json': '{"generation":"archived"}',
      'coinbase/fill-ledger.json': ARCHIVED_LEDGER,
    });

    const dest = makeInstall('dest', configWith({ coinbase: 'BTC-USDC' }));
    const fundDir = path.join(dest.dataDir, 'coinbase', 'BTC-USDC');
    write(path.join(fundDir, 'state.json'), '{"generation":"live"}');
    write(path.join(fundDir, 'fill-ledger.json'), LIVE_LEDGER);
    transferArchive(source, dest, filename);

    // Break the rename of one TRANSLATED destination — reachable only because
    // the translation happened before the applier collected its set.
    const realRenameSync = fs.renameSync;
    const target = path.join(fundDir, 'fill-ledger.json');
    let attempts = 0;
    mock.method(fs, 'renameSync', (from, to) => {
      // Only the APPLY fails; the rollback's own rename of the same
      // destination must be allowed through.
      if (String(to) === target && ++attempts === 1) throw new Error('ENOSPC: injected');
      return realRenameSync(from, to);
    });

    const result = restoreBackup(filename, { paths: dest.paths, logger: silentLogger });
    assert.equal(result.success, false);
    assert.equal(result.rolledBack, true);

    assert.equal(read(path.join(fundDir, 'state.json')), '{"generation":"live"}');
    assert.equal(read(path.join(fundDir, 'fill-ledger.json')), LIVE_LEDGER);
    assert.equal(fs.existsSync(path.join(dest.dataDir, JOURNAL_FILENAME)), false);
  });
});

/** Strip the manifest to reproduce a pre-v2.24.1 archive. */
const stripManifest = (source, filename) => {
  require('child_process').spawnSync('zip', ['-q', '-d', path.join(source.dataDir, 'backups', filename), 'backup-manifest.json']);
};

describe('restoreBackup translates the pre-exchange-namespace root layout (issue #1795)', () => {
  // Fresh backups exclude price caches, so pre-existing legacy archives that carry
  // them are reproduced by appending the entry to the finished zip.
  const legacyRootArchive = async (files, sourceConfig = configWith({ coinbase: 'BTC-USDC' }), extras = {}) => {
    const { source, filename } = await makeLegacyLayoutArchive(sourceConfig, files);
    stripManifest(source, filename);
    const staging = path.join(root, `extras-${roots.length}-${filename}`);
    for (const [name, text] of Object.entries(extras)) {
      write(path.join(staging, name), text);
      require('child_process').spawnSync('zip', ['-q', '-g', path.join(source.dataDir, 'backups', filename), name], { cwd: staging });
    }
    return { source, filename };
  };

  it('replaces the current per-fund state and leaves no root artifact to block startup', async () => {
    const { source, filename } = await legacyRootArchive({
      'state.json': '{"pending":"old-order"}',
      'transactions.tsv': 'old-tx\n',
    }, undefined, { 'btc-price-cache-1h.json': 'prices' });
    const dest = makeInstall('dest', configWith({ coinbase: 'BTC-USDC' }));
    const fundDir = path.join(dest.dataDir, 'coinbase', 'BTC-USDC');
    write(path.join(fundDir, 'state.json'), '{"pending":"current-order"}');
    write(path.join(fundDir, 'transactions.tsv'), 'current-tx\n');
    transferArchive(source, dest, filename);

    const result = restoreBackup(filename, { paths: dest.paths, acceptLegacyWithoutBase: true, logger: silentLogger });
    assert.equal(result.success, true, result.error);

    assert.equal(read(path.join(fundDir, 'state.json')), '{"pending":"old-order"}');
    assert.equal(read(path.join(fundDir, 'transactions.tsv')), 'old-tx\n');
    // Not per-fund: price caches live at exchange level.
    assert.equal(read(path.join(dest.dataDir, 'coinbase', 'btc-price-cache-1h.json')), 'prices');
    for (const name of ['state.json', 'transactions.tsv', 'btc-price-cache-1h.json']) {
      assert.equal(fs.existsSync(path.join(dest.dataDir, name)), false, `${name} stranded at the data root`);
    }
    // The next startup finds nothing to migrate or refuse.
    const migrated = migrateLegacyNamespace({ dataDir: dest.dataDir, pairDir: fundDir });
    assert.equal(migrated.status, 'none');
    assert.deepEqual(fs.readdirSync(dest.dataDir).filter((n) => n.startsWith('.restore-')), []);
  });

  it('restores onto a destination that has no current state for the fund yet', async () => {
    const { source, filename } = await legacyRootArchive({ 'state.json': '{"pending":"old-order"}' });
    const dest = makeInstall('dest', configWith({ coinbase: 'BTC-USDC' }));
    transferArchive(source, dest, filename);

    const result = restoreBackup(filename, { paths: dest.paths, acceptLegacyWithoutBase: true, logger: silentLogger });
    assert.equal(result.success, true, result.error);
    assert.equal(read(path.join(dest.dataDir, 'coinbase', 'BTC-USDC', 'state.json')), '{"pending":"old-order"}');
  });

  it('takes the pair from the supplied source configuration over the destination default', async () => {
    const { source, filename } = await legacyRootArchive({ 'state.json': '{"fund":"ETH-USDC"}' });
    const dest = makeInstall('dest', configWith({ coinbase: 'BTC-USDC' }));
    write(path.join(dest.dataDir, 'coinbase', 'BTC-USDC', 'state.json'), '{"fund":"BTC-USDC"}');
    transferArchive(source, dest, filename);

    const result = restoreBackup(filename, {
      paths: dest.paths,
      legacyBaseConfig: configWith({ coinbase: 'ETH-USDC' }),
      acceptFundRemoval: true,
      logger: silentLogger,
    });
    assert.equal(result.success, true, result.error);
    assert.equal(read(path.join(dest.dataDir, 'coinbase', 'ETH-USDC', 'state.json')), '{"fund":"ETH-USDC"}');
    assert.equal(fs.existsSync(path.join(dest.dataDir, 'state.json')), false);
  });

  it('fails before any destination write when no coinbase fund can be resolved', async () => {
    const { source, filename } = await legacyRootArchive({ 'state.json': '{"pending":"old-order"}' });
    const dest = makeInstall('dest', configWith({ kraken: 'BTC-USD' }));
    write(path.join(dest.dataDir, 'kraken', 'BTC-USD', 'state.json'), '{"current":true}');
    transferArchive(source, dest, filename);

    const options = { paths: dest.paths, acceptLegacyWithoutBase: true };
    const preflight = await checkRestorePreconditions(filename, options);
    assert.equal(preflight.ok, false);
    assert.equal(preflight.code, 'legacy-layout-unresolvable-pair');

    const result = restoreBackup(filename, { ...options, logger: silentLogger });
    assert.equal(result.success, false);
    assert.equal(result.code, 'legacy-layout-unresolvable-pair');
    assert.match(String(result.error), /coinbase/);
    assert.equal(read(path.join(dest.dataDir, 'kraken', 'BTC-USD', 'state.json')), '{"current":true}');
    assert.equal(fs.existsSync(path.join(dest.dataDir, 'state.json')), false);
    assert.equal(fs.existsSync(path.join(dest.dataDir, JOURNAL_FILENAME)), false);
    assert.deepEqual(fs.readdirSync(dest.dataDir).filter((n) => n.startsWith('.restore-')), []);
  });

  it('refuses differing generations inside the archive without touching the destination', async () => {
    const { source, filename } = await legacyRootArchive({
      'state.json': '{"generation":"root"}',
      'coinbase/BTC-USDC/state.json': '{"generation":"pair"}',
    });
    const dest = makeInstall('dest', configWith({ coinbase: 'BTC-USDC' }));
    const fundDir = path.join(dest.dataDir, 'coinbase', 'BTC-USDC');
    write(path.join(fundDir, 'state.json'), '{"generation":"live"}');
    transferArchive(source, dest, filename);

    const options = { paths: dest.paths, acceptLegacyWithoutBase: true };
    const preflight = await checkRestorePreconditions(filename, options);
    assert.equal(preflight.ok, false);
    assert.equal(preflight.code, 'legacy-layout-ambiguous-generations');

    const result = restoreBackup(filename, { ...options, logger: silentLogger });
    assert.equal(result.success, false);
    assert.equal(result.code, 'legacy-layout-ambiguous-generations');
    assert.equal(read(path.join(fundDir, 'state.json')), '{"generation":"live"}');
    assert.equal(fs.existsSync(path.join(dest.dataDir, 'state.json')), false);
    assert.equal(fs.existsSync(path.join(dest.dataDir, JOURNAL_FILENAME)), false);
    assert.deepEqual(fs.readdirSync(dest.dataDir).filter((n) => n.startsWith('.restore-')), []);
  });

  it('refuses a root artifact that differs from an exchange-level copy in the archive', async () => {
    const { source, filename } = await legacyRootArchive({
      'state.json': '{"generation":"root"}',
      'coinbase/state.json': '{"generation":"exchange"}',
    });
    const dest = makeInstall('dest', configWith({ coinbase: 'BTC-USDC' }));
    transferArchive(source, dest, filename);

    const result = restoreBackup(filename, { paths: dest.paths, acceptLegacyWithoutBase: true, logger: silentLogger });
    assert.equal(result.success, false);
    assert.equal(result.code, 'legacy-layout-ambiguous-generations');
  });

  it('reconciles a root artifact identical to the archive copy of the same generation', async () => {
    const { source, filename } = await legacyRootArchive({
      'state.json': '{"generation":"same"}',
      'coinbase/BTC-USDC/state.json': '{"generation":"same"}',
    });
    const dest = makeInstall('dest', configWith({ coinbase: 'BTC-USDC' }));
    write(path.join(dest.dataDir, 'coinbase', 'BTC-USDC', 'state.json'), '{"generation":"live"}');
    transferArchive(source, dest, filename);

    const result = restoreBackup(filename, { paths: dest.paths, acceptLegacyWithoutBase: true, logger: silentLogger });
    assert.equal(result.success, true, result.error);
    assert.equal(read(path.join(dest.dataDir, 'coinbase', 'BTC-USDC', 'state.json')), '{"generation":"same"}');
    assert.equal(fs.existsSync(path.join(dest.dataDir, 'state.json')), false);
  });

  it('rolls every translated destination back when the application fails mid-apply', async () => {
    const { source, filename } = await legacyRootArchive({
      'state.json': '{"pending":"old-order"}',
      'transactions.tsv': 'old-tx\n',
    });
    const dest = makeInstall('dest', configWith({ coinbase: 'BTC-USDC' }));
    const fundDir = path.join(dest.dataDir, 'coinbase', 'BTC-USDC');
    write(path.join(fundDir, 'state.json'), '{"pending":"live"}');
    write(path.join(fundDir, 'transactions.tsv'), 'live-tx\n');
    transferArchive(source, dest, filename);

    const realRenameSync = fs.renameSync;
    const target = path.join(fundDir, 'transactions.tsv');
    let attempts = 0;
    mock.method(fs, 'renameSync', (from, to) => {
      if (String(to) === target && ++attempts === 1) throw new Error('ENOSPC: injected');
      return realRenameSync(from, to);
    });

    const result = restoreBackup(filename, { paths: dest.paths, acceptLegacyWithoutBase: true, logger: silentLogger });
    assert.equal(result.success, false);
    assert.equal(result.rolledBack, true);
    assert.equal(read(path.join(fundDir, 'state.json')), '{"pending":"live"}');
    assert.equal(read(path.join(fundDir, 'transactions.tsv')), 'live-tx\n');
    assert.equal(fs.existsSync(path.join(dest.dataDir, 'state.json')), false);
    assert.equal(fs.existsSync(path.join(dest.dataDir, JOURNAL_FILENAME)), false);
  });

  it('inspection reports the translation the restore performs', async () => {
    const { source, filename } = await legacyRootArchive({
      'state.json': '{"pending":"old-order"}',
    }, undefined, { 'btc-price-cache-1h.json': 'prices' });
    const dest = makeInstall('dest', configWith({ coinbase: 'BTC-USDC' }));
    transferArchive(source, dest, filename);

    const report = inspectBackup(filename, { paths: dest.paths });
    assert.equal(report.legacyLayout, true);
    assert.deepEqual(report.rootTranslation, {
      exchange: 'coinbase',
      pair: 'BTC-USDC',
      files: [
        { name: 'state.json', target: 'coinbase/BTC-USDC/state.json' },
        { name: 'btc-price-cache-1h.json', target: 'coinbase/btc-price-cache-1h.json' },
      ],
    });
    assert.deepEqual(report.layoutConflicts, []);
    assert.deepEqual(report.unresolvableLayoutExchanges, []);

    const result = restoreBackup(filename, { paths: dest.paths, acceptLegacyWithoutBase: true, logger: silentLogger });
    assert.equal(result.success, true, result.error);
    for (const { name, target } of report.rootTranslation.files) {
      assert.equal(fs.existsSync(path.join(dest.dataDir, target)), true, `${target} missing`);
      assert.equal(fs.existsSync(path.join(dest.dataDir, name)), false);
    }
  });

  it('inspection reports an unresolvable root fund and in-archive conflicts', async () => {
    const unresolvable = await legacyRootArchive({ 'state.json': '{}' });
    const destOther = makeInstall('dest-other', configWith({ kraken: 'BTC-USD' }));
    transferArchive(unresolvable.source, destOther, unresolvable.filename);
    const report = inspectBackup(unresolvable.filename, { paths: destOther.paths });
    assert.equal(report.legacyLayout, true);
    assert.equal(report.rootTranslation, null);
    assert.deepEqual(report.unresolvableLayoutExchanges, ['coinbase']);

    const conflicting = await legacyRootArchive({ 'state.json': 'a', 'coinbase/BTC-USDC/state.json': 'b' });
    const dest = makeInstall('dest', configWith({ coinbase: 'BTC-USDC' }));
    transferArchive(conflicting.source, dest, conflicting.filename);
    const conflictReport = inspectBackup(conflicting.filename, { paths: dest.paths });
    assert.deepEqual(conflictReport.layoutConflicts, [{ artifact: 'state.json', existing: 'coinbase/BTC-USDC/state.json' }]);
  });

  it('reports no root translation for a current-layout archive', async () => {
    const { source, filename } = await makeLegacyLayoutArchive(configWith({ coinbase: 'BTC-USDC' }), {
      'coinbase/BTC-USDC/state.json': '{}',
    });
    const dest = makeInstall('dest', configWith({ coinbase: 'BTC-USDC' }));
    transferArchive(source, dest, filename);
    const report = inspectBackup(filename, { paths: dest.paths });
    assert.equal(report.rootTranslation, null);
    assert.deepEqual(report.layoutConflicts, []);
  });
});

describe('inspectBackup discloses the layout translation (issue #541)', () => {
  it('reports legacyLayout and the exchange → pair mapping for a manifest-carrying archive', async () => {
    const { source, filename } = await makeLegacyLayoutArchive(configWith({ coinbase: 'ETH-USDC' }), {
      'coinbase/state.json': '{"generation":"archived"}',
    });

    const dest = makeInstall('dest', configWith({ coinbase: 'BTC-USDC' }));
    transferArchive(source, dest, filename);

    const report = inspectBackup(filename, { paths: dest.paths });
    assert.equal(report.success, true);
    assert.equal(report.legacyLayout, true);
    assert.deepEqual(report.layoutTranslations, [{ exchange: 'coinbase', pair: 'ETH-USDC' }]);
    assert.deepEqual(report.unresolvableLayoutExchanges, []);
  });

  it('reports an exchange whose pair cannot be resolved', async () => {
    const { source, filename } = await makeLegacyLayoutArchive(configWith({ coinbase: 'BTC-USDC' }), {
      'kraken/regime-state.json': '{"orphan":true}',
    });

    const dest = makeInstall('dest', configWith({ coinbase: 'BTC-USDC' }));
    transferArchive(source, dest, filename);

    const report = inspectBackup(filename, { paths: dest.paths });
    assert.equal(report.legacyLayout, true);
    assert.deepEqual(report.layoutTranslations, []);
    assert.deepEqual(report.unresolvableLayoutExchanges, ['kraken']);
  });

  it('reports no translation for an archive already in per-fund layout', async () => {
    const { source, filename } = await makeLegacyLayoutArchive(configWith({ coinbase: 'BTC-USDC' }), {
      'coinbase/BTC-USDC/state.json': '{"generation":"archived"}',
    });

    const dest = makeInstall('dest', configWith({ coinbase: 'BTC-USDC' }));
    transferArchive(source, dest, filename);

    const report = inspectBackup(filename, { paths: dest.paths });
    assert.equal(report.legacyLayout, false);
    assert.deepEqual(report.layoutTranslations, []);
  });
});
