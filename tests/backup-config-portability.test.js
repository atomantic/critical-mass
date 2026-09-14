// @ts-check
// Covers issue #430: data/config.json stores only the DIFF against the
// machine-local base config.json, so an archive of the data directory alone
// carries no fund identity. Restoring onto a machine with a different base
// silently adopted the destination's pair/allocation while the restored state
// files described the original fund.
//
// Every case below runs entirely inside temp directories (source install,
// destination install, and their separate base config files) so nothing here
// can touch the live install's data or configuration.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { createBackup, restoreBackup, inspectBackup, MANIFEST_FILENAME } = require('../src/backup-service');
const {
  buildConfigSnapshot,
  normalizeToMultiExchange,
  normalizeExchangeBlock,
  deepMerge,
  CONFIG_SNAPSHOT_VERSION,
  CONFIG_SNAPSHOT_FIELD_REVISION,
  SNAPSHOT_FUND_KEYS,
  SNAPSHOT_REGIME_KEYS,
  SNAPSHOT_GLOBAL_KEYS,
} = require('../src/config-utils');

/** A source install whose ONLY fund lives in the machine-local base config. */
const SOURCE_BASE = {
  exchanges: {
    coinbase: {
      pairs: {
        'ETH-USDC': {
          productId: 'ETH-USDC',
          totalAllocation: 1234,
          enabled: true,
          dryRun: false,
          sellMarkupPercent: 7,
          regime: { enabled: true, baseSizeUsdc: 77, maxCycleBuys: 9 },
        },
      },
    },
  },
  global: { schedulerInterval: 15000 },
};

/** A fresh clone's shipped defaults: a different pair and a different size. */
const DEST_BASE = {
  exchanges: {
    coinbase: {
      pairs: {
        'BTC-USDC': { productId: 'BTC-USDC', totalAllocation: 10000, enabled: false, dryRun: true },
      },
    },
  },
  global: { schedulerInterval: 30000 },
};

let root;
/** @type {Array<string>} */
const roots = [];

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
};

/**
 * Materialize an install: a data directory plus its own base config file.
 * @param {string} name
 * @param {Object} baseConfig
 * @param {Object} [userOverride]
 */
const makeInstall = (name, baseConfig, userOverride = {}) => {
  const dataDir = path.join(root, name, 'data');
  const baseConfigFile = path.join(root, name, 'config.json');
  fs.mkdirSync(dataDir, { recursive: true });
  writeJson(baseConfigFile, baseConfig);
  writeJson(path.join(dataDir, 'config.json'), userOverride);
  return { dataDir, baseConfigFile, paths: { dataDir, baseConfigFile } };
};

/** Effective (base + override) configuration of an install, read from disk. */
const effectiveConfig = ({ dataDir, baseConfigFile }) => normalizeToMultiExchange(deepMerge(
  JSON.parse(fs.readFileSync(baseConfigFile, 'utf8')),
  JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')),
));

/** Fund identities (exchange/pair) an install would actually run. */
const fundIdentities = (install) => {
  const config = effectiveConfig(install);
  return Object.entries(config.exchanges || {}).flatMap(([exchange, block]) =>
    Object.keys(normalizeExchangeBlock(block).pairs || {}).map((pair) => `${exchange}/${pair}`));
};

/** Copy an archive from one install's backups dir into another's. */
const transferArchive = (from, to, filename) => {
  const dest = path.join(to.dataDir, 'backups');
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(from.dataDir, 'backups', filename), path.join(dest, filename));
};

/** Build a manifest-less archive the way pre-#430 builds did. */
const makeLegacyArchive = (install, filename) => {
  const zipPath = path.join(install.dataDir, 'backups', filename);
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  const result = spawnSync('zip', ['-r', '-q', zipPath, '.', '-x', 'backups/*'], { cwd: install.dataDir });
  assert.equal(result.status, 0, 'legacy fixture archive must build');
  return filename;
};

/** Rewrite an archive's manifest to an arbitrary payload. */
const replaceManifest = (install, filename, contents) => {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-manifest-fixture-'));
  fs.writeFileSync(path.join(staging, MANIFEST_FILENAME), contents);
  const result = spawnSync('zip', ['-q', '-g', path.join(install.dataDir, 'backups', filename), MANIFEST_FILENAME], { cwd: staging });
  fs.rmSync(staging, { recursive: true, force: true });
  assert.equal(result.status, 0, 'manifest fixture rewrite must succeed');
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-backup-portability-'));
  roots.push(root);
});

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('backup config portability — manifest round-trip (#430)', () => {
  it('restores the source fund onto a destination whose base defaults differ', () => {
    const source = makeInstall('source', SOURCE_BASE);
    // Fund state lives under the pair-scoped path; it is meaningless if the
    // destination ends up configured for a different pair.
    writeJson(path.join(source.dataDir, 'coinbase', 'ETH-USDC', 'regime-state.json'), { cycleBuys: 3 });

    const created = createBackup({ paths: source.paths });
    assert.equal(created.success, true, created.error);

    const dest = makeInstall('dest', DEST_BASE);
    transferArchive(source, dest, created.filename);

    // DEST_BASE's own coinbase/BTC-USDC fund is not in the archive, so this
    // restore removes it — requires the #533 acknowledgement.
    const restored = restoreBackup(created.filename, { paths: dest.paths, acceptFundRemoval: true });
    assert.equal(restored.success, true, restored.error);
    assert.equal(restored.configRestored, true);
    assert.equal(restored.legacy, false);

    // Fund identity, not just the numbers: the restored state file's path must
    // name a fund the destination is actually configured to run.
    assert.deepEqual(fundIdentities(dest), ['coinbase/ETH-USDC']);
    assert.equal(fs.existsSync(path.join(dest.dataDir, 'coinbase', 'ETH-USDC', 'regime-state.json')), true);

    assert.deepEqual(
      buildConfigSnapshot(effectiveConfig(dest)).exchanges,
      buildConfigSnapshot(effectiveConfig(source)).exchanges,
    );
  });

  it('round-trips a nested multi-pair config without losing enabled/dryRun/capital/strategy', () => {
    const multiBase = {
      exchanges: {
        coinbase: {
          pairs: {
            'ETH-USDC': { productId: 'ETH-USDC', totalAllocation: 1234, enabled: true, dryRun: false, regime: { enabled: true, baseSizeUsdc: 77 } },
            'SOL-USDC': { productId: 'SOL-USDC', totalAllocation: 555, enabled: false, dryRun: true, regime: { enabled: false, maxCycleBuys: 22, tpMinPercent: 3.5 } },
          },
        },
        gemini: { pairs: { BTCUSD: { productId: 'BTCUSD', totalAllocation: 42, enabled: true, dryRun: true } } },
      },
    };
    const source = makeInstall('source', multiBase);
    const created = createBackup({ paths: source.paths });
    assert.equal(created.success, true, created.error);

    const dest = makeInstall('dest', DEST_BASE);
    transferArchive(source, dest, created.filename);
    // DEST_BASE's coinbase/BTC-USDC fund is not in the archive — removed.
    assert.equal(restoreBackup(created.filename, { paths: dest.paths, acceptFundRemoval: true }).success, true);

    assert.deepEqual(fundIdentities(dest).sort(), ['coinbase/ETH-USDC', 'coinbase/SOL-USDC', 'gemini/BTCUSD']);
    const restoredPairs = buildConfigSnapshot(effectiveConfig(dest)).exchanges.coinbase.pairs;
    assert.equal(restoredPairs['SOL-USDC'].totalAllocation, 555);
    assert.equal(restoredPairs['SOL-USDC'].enabled, false);
    assert.equal(restoredPairs['SOL-USDC'].dryRun, true);
    assert.equal(restoredPairs['SOL-USDC'].regime.maxCycleBuys, 22);
    assert.equal(restoredPairs['SOL-USDC'].regime.tpMinPercent, 3.5);
    assert.equal(restoredPairs['ETH-USDC'].enabled, true);
    assert.equal(restoredPairs['ETH-USDC'].dryRun, false);
    assert.deepEqual(
      buildConfigSnapshot(effectiveConfig(dest)).exchanges,
      buildConfigSnapshot(effectiveConfig(source)).exchanges,
    );
  });

  it('round-trips a legacy single-pair (flat) base config', () => {
    const flatBase = {
      exchanges: {
        coinbase: {
          productId: 'ETH-USDC',
          totalAllocation: 1234,
          enabled: true,
          dryRun: false,
          holdbackPercent: 9,
          regime: { enabled: true, baseSizeUsdc: 88 },
        },
      },
    };
    const source = makeInstall('source', flatBase);
    const created = createBackup({ paths: source.paths });
    assert.equal(created.success, true, created.error);

    // Destination is ALSO flat, and names a different pair — the worst case.
    const dest = makeInstall('dest', { exchanges: { coinbase: { productId: 'BTC-USDC', totalAllocation: 10000 } } });
    transferArchive(source, dest, created.filename);
    // Destination's own coinbase/BTC-USDC fund is not in the archive — removed.
    assert.equal(restoreBackup(created.filename, { paths: dest.paths, acceptFundRemoval: true }).success, true);

    assert.deepEqual(fundIdentities(dest), ['coinbase/ETH-USDC']);
    const fund = buildConfigSnapshot(effectiveConfig(dest)).exchanges.coinbase.pairs['ETH-USDC'];
    assert.equal(fund.totalAllocation, 1234);
    assert.equal(fund.holdbackPercent, 9);
    assert.equal(fund.regime.baseSizeUsdc, 88);
  });

  it('keeps data/config.json a minimal diff when the destination base already matches', () => {
    const source = makeInstall('source', SOURCE_BASE);
    const created = createBackup({ paths: source.paths });
    const dest = makeInstall('dest', SOURCE_BASE);
    transferArchive(source, dest, created.filename);
    assert.equal(restoreBackup(created.filename, { paths: dest.paths }).success, true);

    // A fully-materialized override would shadow every later edit to the base
    // config.json, so reconstruction must prune what the base already resolves.
    const written = JSON.parse(fs.readFileSync(path.join(dest.dataDir, 'config.json'), 'utf8'));
    assert.equal(written.exchanges, undefined, `override should carry no exchange settings: ${JSON.stringify(written)}`);
    assert.deepEqual(fundIdentities(dest), ['coinbase/ETH-USDC']);
  });

  it('drops a destination-only fund the source never had, once the removal is acknowledged', () => {
    const source = makeInstall('source', SOURCE_BASE);
    const created = createBackup({ paths: source.paths });
    const dest = makeInstall('dest', {
      exchanges: {
        coinbase: { pairs: { 'BTC-USDC': { productId: 'BTC-USDC', totalAllocation: 10000 } } },
        cryptocom: { pairs: { CRO_USD: { productId: 'CRO_USD', totalAllocation: 500, enabled: true } } },
      },
    });
    transferArchive(source, dest, created.filename);
    assert.equal(restoreBackup(created.filename, { paths: dest.paths, acceptFundRemoval: true }).success, true);
    assert.deepEqual(fundIdentities(dest), ['coinbase/ETH-USDC']);
  });
});

describe('backup config portability — secrets (#430)', () => {
  it('excludes secret material from the manifest and preserves destination credentials', () => {
    const source = makeInstall('source', {
      ...SOURCE_BASE,
      global: {
        ...SOURCE_BASE.global,
        notifications: { enabled: true, telegram: { botToken: 'SOURCE-BOT-TOKEN', chatId: 'source-chat' } },
        sentinel: { enabled: true, aiClassification: { apiKey: 'SOURCE-AI-KEY' } },
      },
    });
    const created = createBackup({ paths: source.paths });
    assert.equal(created.success, true, created.error);

    const archived = spawnSync('unzip', ['-p', path.join(source.dataDir, 'backups', created.filename), MANIFEST_FILENAME]).stdout.toString();
    assert.equal(archived.includes('SOURCE-BOT-TOKEN'), false, 'bot token must never enter the manifest');
    assert.equal(archived.includes('SOURCE-AI-KEY'), false, 'AI key must never enter the manifest');
    const manifest = JSON.parse(archived);
    assert.equal(manifest.config.global.notifications, undefined);
    assert.equal(manifest.config.global.sentinel, undefined);

    const dest = makeInstall('dest', DEST_BASE, {
      global: {
        notifications: { enabled: true, telegram: { botToken: 'DEST-BOT-TOKEN', chatId: 'dest-chat' } },
        sentinel: { enabled: false, aiClassification: { apiKey: 'DEST-AI-KEY' } },
      },
    });
    transferArchive(source, dest, created.filename);
    // DEST_BASE's coinbase/BTC-USDC fund is not in the archive — removed.
    assert.equal(restoreBackup(created.filename, { paths: dest.paths, acceptFundRemoval: true }).success, true);

    const after = effectiveConfig(dest);
    assert.equal(after.global.notifications.telegram.botToken, 'DEST-BOT-TOKEN');
    assert.equal(after.global.notifications.telegram.chatId, 'dest-chat');
    assert.equal(after.global.sentinel.aiClassification.apiKey, 'DEST-AI-KEY');
    // Non-secret globals still travel with the archive.
    assert.equal(after.global.schedulerInterval, 15000);
  });
});

describe('backup config portability — rejected archives (#430)', () => {
  /** Snapshot of every file under a directory, to prove nothing was written. */
  const fingerprint = (dir) => {
    const out = {};
    const walk = (current, rel) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const next = path.join(current, entry.name);
        const key = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(next, key);
        else out[key] = fs.readFileSync(next, 'utf8');
      }
    };
    walk(dir, '');
    return out;
  };

  it('refuses a legacy archive with no source base, before touching the destination', () => {
    const source = makeInstall('source', SOURCE_BASE);
    writeJson(path.join(source.dataDir, 'coinbase', 'ETH-USDC', 'regime-state.json'), { cycleBuys: 3 });
    const filename = makeLegacyArchive(source, 'backup-legacy-0001.zip');

    const dest = makeInstall('dest', DEST_BASE);
    transferArchive(source, dest, filename);
    const before = fingerprint(dest.dataDir);

    const result = restoreBackup(filename, { paths: dest.paths });
    assert.equal(result.success, false);
    assert.equal(result.code, 'legacy-archive-missing-base');
    assert.match(result.error, /No files were changed/);
    assert.deepEqual(fingerprint(dest.dataDir), before, 'destination must be untouched');
  });

  it('restores a legacy archive when the source base config is supplied', () => {
    const source = makeInstall('source', SOURCE_BASE);
    const filename = makeLegacyArchive(source, 'backup-legacy-0002.zip');

    const dest = makeInstall('dest', DEST_BASE);
    transferArchive(source, dest, filename);

    // DEST_BASE's coinbase/BTC-USDC fund is not in the reconstructed source
    // snapshot — removed.
    const result = restoreBackup(filename, { paths: dest.paths, legacyBaseConfig: SOURCE_BASE, acceptFundRemoval: true });
    assert.equal(result.success, true, result.error);
    assert.equal(result.legacy, true);
    assert.equal(result.configRestored, true);
    assert.deepEqual(fundIdentities(dest), ['coinbase/ETH-USDC']);
  });

  it('restores legacy data while preserving the destination override byte-for-byte', () => {
    const source = makeInstall('source', SOURCE_BASE, { global: { schedulerInterval: 11111 } });
    writeJson(path.join(source.dataDir, 'legacy-state.json'), { restored: true });
    const filename = makeLegacyArchive(source, 'backup-legacy-0003.zip');

    const dest = makeInstall('dest', DEST_BASE, {
      exchanges: { coinbase: { pairs: { 'BTC-USDC': { totalAllocation: 4321, dryRun: true } } } },
      global: { schedulerInterval: 98765 },
    });
    const configFile = path.join(dest.dataDir, 'config.json');
    const before = fs.readFileSync(configFile, 'utf8');
    transferArchive(source, dest, filename);

    const result = restoreBackup(filename, { paths: dest.paths, acceptLegacyWithoutBase: true });
    assert.equal(result.success, true, result.error);
    assert.equal(result.configRestored, false);
    assert.equal(fs.readFileSync(configFile, 'utf8'), before);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dest.dataDir, 'legacy-state.json'), 'utf8')), { restored: true });
    assert.deepEqual(fundIdentities(dest), ['coinbase/BTC-USDC']);
  });

  it('rejects a future manifest version before touching the destination', () => {
    const source = makeInstall('source', SOURCE_BASE);
    const created = createBackup({ paths: source.paths });
    replaceManifest(source, created.filename, JSON.stringify({ manifestVersion: 99, config: { version: 99, exchanges: {} } }));

    const dest = makeInstall('dest', DEST_BASE);
    transferArchive(source, dest, created.filename);
    const before = fingerprint(dest.dataDir);

    const result = restoreBackup(created.filename, { paths: dest.paths });
    assert.equal(result.success, false);
    assert.equal(result.code, 'manifest-unsupported-version');
    assert.match(result.error, /not supported by this build/);
    assert.deepEqual(fingerprint(dest.dataDir), before);
  });

  it('rejects a malformed manifest before touching the destination', () => {
    const source = makeInstall('source', SOURCE_BASE);
    const created = createBackup({ paths: source.paths });
    replaceManifest(source, created.filename, '{ not json');

    const dest = makeInstall('dest', DEST_BASE);
    transferArchive(source, dest, created.filename);
    const before = fingerprint(dest.dataDir);

    const result = restoreBackup(created.filename, { paths: dest.paths });
    assert.equal(result.success, false);
    assert.equal(result.code, 'manifest-malformed');
    assert.deepEqual(fingerprint(dest.dataDir), before);
  });

  it('rejects a snapshot carrying an unexpected (potentially secret) field', () => {
    const source = makeInstall('source', SOURCE_BASE);
    const created = createBackup({ paths: source.paths });
    replaceManifest(source, created.filename, JSON.stringify({
      manifestVersion: 1,
      config: { version: 1, exchanges: {}, global: { notifications: { telegram: { botToken: 'INJECTED' } } } },
    }));

    const dest = makeInstall('dest', DEST_BASE);
    transferArchive(source, dest, created.filename);
    const before = fingerprint(dest.dataDir);

    const result = restoreBackup(created.filename, { paths: dest.paths });
    assert.equal(result.success, false);
    assert.equal(result.code, 'config-snapshot-invalid');
    assert.match(result.error, /unsupported global field "notifications"/);
    assert.deepEqual(fingerprint(dest.dataDir), before);
  });
});

describe('backup config portability — inspectBackup pre-flight (#430)', () => {
  it('reports the archived funds and compatibility for a manifest archive', () => {
    const source = makeInstall('source', SOURCE_BASE);
    const created = createBackup({ paths: source.paths });
    const dest = makeInstall('dest', DEST_BASE);
    transferArchive(source, dest, created.filename);

    const report = inspectBackup(created.filename, { paths: dest.paths });
    assert.equal(report.success, true);
    assert.equal(report.legacy, false);
    assert.equal(report.compatible, true);
    assert.equal(report.manifestVersion, 1);
    assert.deepEqual(report.funds, [{
      exchange: 'coinbase', pair: 'ETH-USDC', productId: 'ETH-USDC', totalAllocation: 1234, enabled: true, dryRun: false,
    }]);
    // DEST_BASE's own coinbase/BTC-USDC fund is not in the archive — disclosed
    // as a removal, not silently dropped (issue #533).
    assert.deepEqual(report.removedFunds, [{
      exchange: 'coinbase', pair: 'BTC-USDC', productId: 'BTC-USDC', totalAllocation: 10000, enabled: false, dryRun: true, hasStateOnDisk: false,
    }]);
    // Pre-flight is read-only.
    assert.deepEqual(fundIdentities(dest), ['coinbase/BTC-USDC']);
  });

  it('flags a legacy archive as incompatible with an actionable message', () => {
    const source = makeInstall('source', SOURCE_BASE);
    const filename = makeLegacyArchive(source, 'backup-legacy-0004.zip');
    const dest = makeInstall('dest', DEST_BASE);
    transferArchive(source, dest, filename);

    const report = inspectBackup(filename, { paths: dest.paths });
    assert.equal(report.success, true);
    assert.equal(report.legacy, true);
    assert.equal(report.compatible, false);
    assert.equal(report.code, 'legacy-archive-missing-base');
    assert.match(report.error, /predates configuration manifests/);
  });

  it('rejects an invalid filename', () => {
    assert.deepEqual(inspectBackup('../evil.zip'), { success: false, error: 'Invalid filename' });
    assert.deepEqual(inspectBackup('notabackup.zip'), { success: false, error: 'Invalid backup filename format' });
  });
});

describe('backup config portability — disclosing and gating removed funds (#533)', () => {
  /** Snapshot of every file under a directory, to prove nothing was written. */
  const fingerprint = (dir) => {
    const out = {};
    const walk = (current, rel) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const next = path.join(current, entry.name);
        const key = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(next, key);
        else out[key] = fs.readFileSync(next, 'utf8');
      }
    };
    walk(dir, '');
    return out;
  };

  it('reports both a base-defined and an override-defined destination-only fund in removedFunds', () => {
    const source = makeInstall('source', SOURCE_BASE);
    const created = createBackup({ paths: source.paths });

    // BTC-USDC comes from the destination's base config; CRO_USD exists only
    // in its override (data/config.json) — both must be disclosed, since a
    // restore drops the override-defined one just as completely (#533).
    const dest = makeInstall('dest', DEST_BASE, {
      exchanges: { cryptocom: { pairs: { CRO_USD: { productId: 'CRO_USD', totalAllocation: 500, enabled: true } } } },
    });
    // The base-defined fund already has state on disk; the override-defined one does not.
    writeJson(path.join(dest.dataDir, 'coinbase', 'BTC-USDC', 'state.json'), { position: 'live' });
    transferArchive(source, dest, created.filename);

    const report = inspectBackup(created.filename, { paths: dest.paths });
    assert.equal(report.success, true);
    assert.deepEqual(
      [...report.removedFunds].sort((a, b) => a.pair.localeCompare(b.pair)),
      [
        { exchange: 'coinbase', pair: 'BTC-USDC', productId: 'BTC-USDC', totalAllocation: 10000, enabled: false, dryRun: true, hasStateOnDisk: true },
        { exchange: 'cryptocom', pair: 'CRO_USD', productId: 'CRO_USD', totalAllocation: 500, enabled: true, dryRun: true, hasStateOnDisk: false },
      ],
    );
  });

  it('refuses restoreBackup with fund-removal-unacknowledged and leaves data/config.json byte-identical', () => {
    const source = makeInstall('source', SOURCE_BASE);
    const created = createBackup({ paths: source.paths });
    const dest = makeInstall('dest', DEST_BASE);
    transferArchive(source, dest, created.filename);
    const before = fingerprint(dest.dataDir);

    const result = restoreBackup(created.filename, { paths: dest.paths });
    assert.equal(result.success, false);
    assert.equal(result.code, 'fund-removal-unacknowledged');
    assert.match(result.error, /coinbase\/BTC-USDC/);
    assert.match(result.error, /No files were changed/);
    assert.deepEqual(fingerprint(dest.dataDir), before, 'destination must be untouched');
    assert.deepEqual(fundIdentities(dest), ['coinbase/BTC-USDC']);
  });

  it('succeeds and drops the fund once acceptFundRemoval is set', () => {
    const source = makeInstall('source', SOURCE_BASE);
    const created = createBackup({ paths: source.paths });
    const dest = makeInstall('dest', DEST_BASE);
    transferArchive(source, dest, created.filename);

    const result = restoreBackup(created.filename, { paths: dest.paths, acceptFundRemoval: true });
    assert.equal(result.success, true, result.error);
    assert.equal(result.configRestored, true);
    assert.deepEqual(fundIdentities(dest), ['coinbase/ETH-USDC']);
  });
});

// Covers issue #567: the snapshot allowlists are derived from the live defaults
// objects, so they widen on every ordinary feature commit while
// CONFIG_SNAPSHOT_VERSION deliberately stays put. A second marker —
// CONFIG_SNAPSHOT_FIELD_REVISION — lets an older build recognize "written by a
// newer build" and ignore the one knob it does not know instead of refusing the
// entire restore.
describe('backup config portability — newer-build archives (#567)', () => {
  /** Rewrite an archive's manifest with the install's own snapshot, mutated. */
  const remanifest = (install, filename, mutate) => {
    const config = buildConfigSnapshot(effectiveConfig(install));
    mutate(config);
    replaceManifest(install, filename, JSON.stringify({
      manifestVersion: 1, createdAt: new Date().toISOString(), config,
    }));
  };

  /** An archive from a build that added one regime knob and one fund field. */
  const newerBuildArchive = (install, filename, revision = CONFIG_SNAPSHOT_FIELD_REVISION + 1) =>
    remanifest(install, filename, (config) => {
      config.fieldRevision = revision;
      const fund = config.exchanges.coinbase.pairs['ETH-USDC'];
      fund.someNewFundField = 'from-the-future';
      fund.regime.someNewKnob = 42;
    });

  /** The destination's override file, verbatim. */
  const overrideText = (install) => fs.readFileSync(path.join(install.dataDir, 'config.json'), 'utf8');

  it('emits both markers and keeps the field revision in step with the allowlists', () => {
    // The literal constant must track the lists it describes, so adding a key
    // to REGIME_DEFAULTS without bumping the revision fails CI right here.
    assert.equal(
      CONFIG_SNAPSHOT_FIELD_REVISION,
      SNAPSHOT_FUND_KEYS.length + SNAPSHOT_REGIME_KEYS.length + SNAPSHOT_GLOBAL_KEYS.length,
    );
    const snapshot = buildConfigSnapshot({});
    assert.equal(snapshot.version, CONFIG_SNAPSHOT_VERSION);
    assert.equal(snapshot.fieldRevision, CONFIG_SNAPSHOT_FIELD_REVISION);
  });

  it('restores a higher-revision archive, dropping and reporting the fields it does not know', () => {
    const source = makeInstall('source', SOURCE_BASE);
    const created = createBackup({ paths: source.paths });
    newerBuildArchive(source, created.filename);

    const dest = makeInstall('dest', DEST_BASE);
    transferArchive(source, dest, created.filename);

    const warnings = [];
    const result = restoreBackup(created.filename, {
      paths: dest.paths,
      acceptFundRemoval: true,
      logger: { info: () => {}, warn: (message) => warnings.push(message), error: () => {} },
    });
    assert.equal(result.success, true, result.error);
    assert.equal(result.configRestored, true);
    assert.deepEqual(
      [...result.droppedFields].sort(),
      ['coinbase/ETH-USDC.regime.someNewKnob', 'coinbase/ETH-USDC.someNewFundField'],
    );
    assert.equal(warnings.filter(w => w.includes('someNewKnob')).length, 1);

    // The archived fund still lands intact — only the unknown knobs are gone.
    assert.deepEqual(fundIdentities(dest), ['coinbase/ETH-USDC']);
    assert.doesNotMatch(overrideText(dest), /someNewKnob|someNewFundField/);
    assert.equal(JSON.parse(overrideText(dest)).exchanges.coinbase.pairs['ETH-USDC'].totalAllocation, 1234);
  });

  it('still rejects the same unknown keys at the current or an older field revision', () => {
    for (const revision of [CONFIG_SNAPSHOT_FIELD_REVISION, CONFIG_SNAPSHOT_FIELD_REVISION - 1]) {
      const source = makeInstall(`source-${revision}`, SOURCE_BASE);
      const created = createBackup({ paths: source.paths });
      newerBuildArchive(source, created.filename, revision);

      const dest = makeInstall(`dest-${revision}`, DEST_BASE);
      transferArchive(source, dest, created.filename);
      const before = overrideText(dest);

      const result = restoreBackup(created.filename, { paths: dest.paths, acceptFundRemoval: true });
      assert.equal(result.success, false, `revision ${revision} must stay fatal`);
      assert.equal(result.code, 'config-snapshot-invalid');
      assert.match(result.error, /carries unsupported field "someNewFundField"/);
      assert.equal(overrideText(dest), before, 'destination must be untouched');
    }
  });

  it('never persists a credential-bearing global key a newer-build archive carries', () => {
    const source = makeInstall('source', SOURCE_BASE);
    const created = createBackup({ paths: source.paths });
    remanifest(source, created.filename, (config) => {
      config.fieldRevision = CONFIG_SNAPSHOT_FIELD_REVISION + 1;
      // `notifications` holds the Telegram bot token and is deliberately outside
      // the allowlist. Tolerating a newer build's extra fields must NOT become a
      // way to smuggle one into data/config.json.
      config.global.notifications = { telegram: { botToken: 'INJECTED' } };
    });

    const dest = makeInstall('dest', DEST_BASE);
    transferArchive(source, dest, created.filename);

    const result = restoreBackup(created.filename, { paths: dest.paths, acceptFundRemoval: true });
    assert.equal(result.success, true, result.error);
    assert.deepEqual(result.droppedFields, ['global.notifications']);
    assert.doesNotMatch(overrideText(dest), /INJECTED|notifications/);
  });

  it('inspectBackup reports a higher-revision archive as compatible with a warning', () => {
    const source = makeInstall('source', SOURCE_BASE);
    const created = createBackup({ paths: source.paths });
    newerBuildArchive(source, created.filename);

    const dest = makeInstall('dest', DEST_BASE);
    transferArchive(source, dest, created.filename);

    const report = inspectBackup(created.filename, { paths: dest.paths });
    assert.equal(report.success, true);
    assert.equal(report.compatible, true);
    assert.equal(report.error, undefined);
    assert.equal(report.snapshotFieldRevision, CONFIG_SNAPSHOT_FIELD_REVISION + 1);
    assert.deepEqual(
      [...report.droppedFields].sort(),
      ['coinbase/ETH-USDC.regime.someNewKnob', 'coinbase/ETH-USDC.someNewFundField'],
    );
    // The archive's own funds are still disclosed normally.
    assert.deepEqual(report.funds.map(f => `${f.exchange}/${f.pair}`), ['coinbase/ETH-USDC']);
  });

  it('reports no dropped fields for an ordinary same-build archive', () => {
    const source = makeInstall('source', SOURCE_BASE);
    const created = createBackup({ paths: source.paths });
    const dest = makeInstall('dest', DEST_BASE);
    transferArchive(source, dest, created.filename);

    assert.deepEqual(inspectBackup(created.filename, { paths: dest.paths }).droppedFields, []);
    const result = restoreBackup(created.filename, { paths: dest.paths, acceptFundRemoval: true });
    assert.equal(result.success, true, result.error);
    assert.deepEqual(result.droppedFields, []);
  });
});
