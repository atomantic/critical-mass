// @ts-check
/**
 * Issue #1384 — a restore that is going to be refused must not leave healthy
 * funds stopped.
 *
 *  - Archive and acknowledgement refusals (legacy archive, fund removal, a
 *    corrupt archive) are decided by `checkRestorePreconditions` before any
 *    engine window opens or any `regime:stop-all` is sent.
 *  - A refusal after stop-all (an unconfirmed writer, or an applier failure that
 *    rolled back) restarts the stopped funds through `regime:start` once the
 *    engine windows close, and reports them.
 *  - An incomplete rollback (`rolledBack: false`) restarts nothing.
 *
 * Archives are built in temp installs; IPC is a recording stub.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { performRestore } = require('../src/restore-coordinator');
const maintenance = require('../src/restore-maintenance');
const { ledgerOf } = require('./helpers/ledger-fixture');
const { buildConfigSnapshot } = require('../src/config-utils');
const {
  createBackup,
  createFundStateBackup,
  restoreBackup,
  inspectBackup,
  checkRestorePreconditions,
  checkFundStateRestorePreconditions,
  restoreFundStateBackup,
  MANIFEST_FILENAME,
} = require('../src/backup-service');


const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

// A minimal stored ZIP fixture, built in Node so the tests can retain literal
// ./ prefixes and Unix symlink metadata without requiring Python or zipnote.
const archiveWithMembers = (file, members, { zip64 = false } = {}) => {
  const local = [];
  const central = [];
  let offset = 0;
  const crc32 = (data) => {
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  for (const member of members) {
    const name = Buffer.from(member.name);
    const content = Buffer.from(member.content ?? '');
    const crc = crc32(content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(content.length, 18);
    header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(member.dos ? 0x0014 : 0x0314, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(content.length, 20);
    entry.writeUInt32LE(content.length, 24);
    entry.writeUInt16LE(name.length, 28);
    const zip64Extra = zip64 ? Buffer.alloc(12) : Buffer.alloc(0);
    if (zip64) {
      zip64Extra.writeUInt16LE(1, 0);
      zip64Extra.writeUInt16LE(8, 2);
      zip64Extra.writeBigUInt64LE(BigInt(offset), 4);
      entry.writeUInt16LE(zip64Extra.length, 30);
    }
    entry.writeUInt32LE(member.dos ? (member.name.endsWith('/') ? 0x10 : 0x20) : ((member.mode ?? 0o100644) << 16) >>> 0, 38);
    entry.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    local.push(header, name, content);
    central.push(entry, name, zip64Extra);
    offset += header.length + name.length + content.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : members.length, 8);
  end.writeUInt16LE(zip64 ? 0xffff : members.length, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : centralSize, 12);
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  const trailer = [];
  if (zip64) {
    const end64 = Buffer.alloc(56);
    end64.writeUInt32LE(0x06064b50, 0);
    end64.writeBigUInt64LE(44n, 4);
    end64.writeUInt16LE(45, 12);
    end64.writeUInt16LE(45, 14);
    end64.writeBigUInt64LE(BigInt(members.length), 24);
    end64.writeBigUInt64LE(BigInt(members.length), 32);
    end64.writeBigUInt64LE(BigInt(centralSize), 40);
    end64.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + centralSize), 8);
    locator.writeUInt32LE(1, 16);
    trailer.push(end64, locator);
  }
  fs.writeFileSync(file, Buffer.concat([...local, ...central, ...trailer, end]));
};

/**
 * IPC stub that records every request as `channel exchange[/pair]` and answers
 * stop-all with the given funds. `startResult` decides each `regime:start`.
 * @param {string} exchange
 * @param {Array<string>} pairs - Funds this engine reports stopped
 * @param {Array<string>} calls - Shared call log
 * @param {Object} [opts]
 * @param {(pair: string) => any} [opts.startResult]
 * @param {boolean} [opts.failStop] - Reject stop-all (unconfirmed writer)
 */
const recordingIPC = (exchange, pairs, calls, { startResult = () => ({ success: true }), failStop = false } = {}) => ({
  isConnected: () => true,
  request: async (channel, payload, ex, pairOrTimeout) => {
    if (channel === 'engine:maintenance') {
      calls.push(`${channel}:${payload.active} ${exchange}`);
      return { success: true };
    }
    if (channel === 'regime:stop-all') {
      calls.push(`${channel} ${exchange}`);
      if (failStop) throw new Error('socket hang up');
      return { success: true, stopped: pairs.map((pair) => ({ exchange, pair })) };
    }
    calls.push(`${channel} ${exchange}/${pairOrTimeout}`);
    if (channel === 'regime:start') return startResult(/** @type {string} */ (pairOrTimeout));
    return { success: true };
  },
});

afterEach(() => maintenance.endMaintenance());

describe('restore pre-flight runs before any engine is touched', () => {
  it('refuses with no IPC traffic and passes the refusal code through', async () => {
    const calls = [];
    const restoreCalls = [];
    const { status, body } = await performRestore({
      filename: 'backup-x.zip',
      exchangeIPCMap: { coinbase: recordingIPC('coinbase', ['BTC-USDC'], calls) },
      configuredExchanges: ['coinbase'],
      preflight: async () => ({ ok: false, code: 'fund-removal-unacknowledged', error: 'would remove funds. No files were changed.' }),
      restore: (f) => { restoreCalls.push(f); return { success: true, filesRestored: 1 }; },
      logger: silentLogger,
    });
    assert.equal(status, 400);
    assert.equal(body.code, 'fund-removal-unacknowledged');
    assert.equal(body.error, 'would remove funds. No files were changed.');
    assert.deepEqual(body.stoppedEngines, []);
    assert.deepEqual(calls, [], 'no maintenance window, stop-all or start');
    assert.deepEqual(restoreCalls, []);
    assert.equal(maintenance.isMaintenanceActive(), false, 'lock released');
  });

  it('treats a throwing pre-flight as a refusal', async () => {
    const calls = [];
    const { status, body } = await performRestore({
      filename: 'backup-x.zip',
      exchangeIPCMap: { coinbase: recordingIPC('coinbase', ['BTC-USDC'], calls) },
      configuredExchanges: ['coinbase'],
      preflight: () => { throw new Error('unzip missing'); },
      restore: () => ({ success: true, filesRestored: 1 }),
      logger: silentLogger,
    });
    assert.equal(status, 400);
    assert.equal(body.code, 'restore-precheck-failed');
    assert.equal(body.error, 'unzip missing');
    assert.deepEqual(calls, []);
  });

  it('proceeds to stop the engines once the pre-flight passes', async () => {
    const calls = [];
    const { status } = await performRestore({
      filename: 'backup-x.zip',
      exchangeIPCMap: { coinbase: recordingIPC('coinbase', ['BTC-USDC'], calls) },
      configuredExchanges: ['coinbase'],
      preflight: async () => ({ ok: true }),
      restore: () => ({ success: true, filesRestored: 1 }),
      logger: silentLogger,
    });
    assert.equal(status, 200);
    assert.deepEqual(calls, ['engine:maintenance:true coinbase', 'regime:stop-all coinbase', 'engine:maintenance:false coinbase'],
      'a successful restore leaves restarting to the operator');
  });
});

describe('a restore refused after stop-all restarts the funds it stopped', () => {
  it('restarts the funds the confirming engine stopped when another engine is unconfirmed', async () => {
    const calls = [];
    const { status, body } = await performRestore({
      filename: 'backup-x.zip',
      exchangeIPCMap: {
        coinbase: recordingIPC('coinbase', ['BTC-USDC', 'ETH-USDC'], calls),
        gemini: recordingIPC('gemini', [], calls, { failStop: true }),
      },
      configuredExchanges: ['coinbase', 'gemini'],
      restore: () => assert.fail('a blocked restore must not apply'),
      logger: silentLogger,
    });
    assert.equal(status, 409);
    assert.equal(body.code, 'writers-not-quiesced');
    assert.deepEqual(body.restartedEngines, ['coinbase BTC-USDC', 'coinbase ETH-USDC']);
    assert.equal(body.restartFailed, undefined);
    assert.match(body.error, /No files were changed\. Engines stopped for the restore were restarted: coinbase BTC-USDC, coinbase ETH-USDC\.$/);
    // Starts only after every engine window is closed — an engine refuses
    // regime:start inside one.
    const lastClose = Math.max(calls.indexOf('engine:maintenance:false coinbase'), calls.indexOf('engine:maintenance:false gemini'));
    const firstStart = calls.findIndex((c) => c.startsWith('regime:start'));
    assert.ok(lastClose >= 0 && firstStart > lastClose, `starts follow the window close: ${calls.join(' | ')}`);
    assert.deepEqual(calls.filter((c) => c.startsWith('regime:start')), ['regime:start coinbase/BTC-USDC', 'regime:start coinbase/ETH-USDC']);
    assert.equal(maintenance.isMaintenanceActive(), false);
  });

  it('reports a fund that fails to restart and tells the operator to start it', async () => {
    const calls = [];
    const { body } = await performRestore({
      filename: 'backup-x.zip',
      exchangeIPCMap: {
        coinbase: recordingIPC('coinbase', ['BTC-USDC', 'ETH-USDC'], calls, {
          startResult: (pair) => (pair === 'ETH-USDC' ? { success: false, error: 'API keys not configured for this exchange' } : { success: true }),
        }),
        gemini: recordingIPC('gemini', [], calls, { failStop: true }),
      },
      configuredExchanges: ['coinbase', 'gemini'],
      restore: () => ({ success: true, filesRestored: 1 }),
      logger: silentLogger,
    });
    assert.deepEqual(body.restartedEngines, ['coinbase BTC-USDC']);
    assert.deepEqual(body.restartFailed, [{ fund: 'coinbase ETH-USDC', error: 'API keys not configured for this exchange' }]);
    assert.match(body.error, /were restarted: coinbase BTC-USDC\. Engines stopped for the restore are still stopped: coinbase ETH-USDC \(API keys not configured for this exchange\) — restart them from the dashboard\.$/);
  });

  it('treats a rejected start request as a failed restart', async () => {
    const calls = [];
    const { body } = await performRestore({
      filename: 'backup-x.zip',
      exchangeIPCMap: { coinbase: recordingIPC('coinbase', ['BTC-USDC'], calls, { startResult: () => { throw new Error('IPC request timeout'); } }) },
      configuredExchanges: ['coinbase'],
      restore: () => ({ success: false, code: 'restore-failed', error: 'ENOSPC', rolledBack: true }),
      logger: silentLogger,
    });
    assert.deepEqual(body.restartedEngines, []);
    assert.deepEqual(body.restartFailed, [{ fund: 'coinbase BTC-USDC', error: 'IPC request timeout' }]);
  });

  it('restarts after an applier failure that rolled back', async () => {
    const calls = [];
    const { status, body } = await performRestore({
      filename: 'backup-x.zip',
      exchangeIPCMap: { coinbase: recordingIPC('coinbase', ['BTC-USDC'], calls) },
      configuredExchanges: ['coinbase'],
      restore: () => ({ success: false, code: 'restore-failed', error: 'copy failed; every destination was reverted', rolledBack: true }),
      logger: silentLogger,
    });
    assert.equal(status, 500);
    assert.deepEqual(body.restartedEngines, ['coinbase BTC-USDC']);
    assert.equal(body.error, 'copy failed; every destination was reverted. Engines stopped for the restore were restarted: coinbase BTC-USDC.');
    assert.deepEqual(calls.slice(-1), ['regime:start coinbase/BTC-USDC']);
  });

  it('restarts nothing when the rollback was incomplete', async () => {
    const calls = [];
    const { status, body } = await performRestore({
      filename: 'backup-x.zip',
      exchangeIPCMap: { coinbase: recordingIPC('coinbase', ['BTC-USDC'], calls) },
      configuredExchanges: ['coinbase'],
      restore: () => ({ success: false, code: 'restore-incomplete-recovery', error: 'rollback failed', rolledBack: false }),
      logger: silentLogger,
    });
    assert.equal(status, 500);
    assert.equal(body.rolledBack, false);
    assert.equal(body.error, 'rollback failed');
    assert.equal(body.restartedEngines, undefined);
    assert.deepEqual(calls.filter((c) => c.startsWith('regime:start')), [], 'never trade on a mixed generation');
    assert.equal(maintenance.isMaintenanceActive(), true, 'the gateway gate stays held');
  });
});

describe('checkRestorePreconditions mirrors the applier refusals without extracting', () => {
  /** @type {string} */
  let root;
  const BASE = {
    exchanges: { coinbase: { pairs: { 'ETH-USDC': { productId: 'ETH-USDC', totalAllocation: 1000, enabled: true, dryRun: true } } } },
    global: {},
  };
  const DEST_BASE = {
    exchanges: { coinbase: { pairs: { 'BTC-USDC': { productId: 'BTC-USDC', totalAllocation: 500, enabled: true, dryRun: true } } } },
    global: {},
  };
  const writeJson = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
  };
  const makeInstall = (name, baseConfig) => {
    const dataDir = path.join(root, name, 'data');
    const baseConfigFile = path.join(root, name, 'config.json');
    writeJson(baseConfigFile, baseConfig);
    writeJson(path.join(dataDir, 'config.json'), {});
    return { dataDir, paths: { dataDir, baseConfigFile } };
  };
  const transfer = (from, to, filename) => {
    fs.mkdirSync(path.join(to.dataDir, 'backups'), { recursive: true });
    fs.copyFileSync(path.join(from.dataDir, 'backups', filename), path.join(to.dataDir, 'backups', filename));
  };
  const listDir = (dir) => fs.readdirSync(dir).sort();
  // Production creation refuses archives restore would reject (#1885), so a
  // deliberately unrestorable archive is a valid one with members overwritten.
  const plantMembers = (install, filename, members) => {
    const staging = fs.mkdtempSync(path.join(root, 'plant-'));
    for (const [rel, bytes] of Object.entries(members)) {
      fs.mkdirSync(path.dirname(path.join(staging, rel)), { recursive: true });
      fs.writeFileSync(path.join(staging, rel), typeof bytes === 'string' ? bytes : JSON.stringify(bytes));
    }
    assert.equal(spawnSync('zip', ['-q', path.join(install.dataDir, 'backups', filename), ...Object.keys(members)], { cwd: staging }).status, 0);
  };

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-restore-preflight-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('refuses a legacy archive without acknowledgement, and the restore sends no stop-all', async () => {
    const source = makeInstall('source', BASE);
    writeJson(path.join(source.dataDir, 'coinbase', 'ETH-USDC', 'regime-state.json'), { cycleBuys: 1 });
    const filename = 'backup-legacy-0001.zip';
    fs.mkdirSync(path.join(source.dataDir, 'backups'));
    assert.equal(spawnSync('zip', ['-r', '-q', path.join('backups', filename), '.', '-x', 'backups/*'], { cwd: source.dataDir }).status, 0);
    const dest = makeInstall('dest', BASE);
    transfer(source, dest, filename);
    const before = listDir(dest.dataDir);

    const check = await checkRestorePreconditions(filename, { paths: dest.paths });
    assert.equal(check.ok, false);
    assert.equal(check.code, 'legacy-archive-missing-base');
    assert.equal(check.error, restoreBackup(filename, { paths: dest.paths }).error, 'same refusal text as the applier');
    assert.equal((await checkRestorePreconditions(filename, { paths: dest.paths, acceptLegacyWithoutBase: true })).ok, true);
    assert.equal((await checkRestorePreconditions(filename, { paths: dest.paths, legacyBaseConfig: BASE })).ok, true);

    const calls = [];
    const { status, body } = await performRestore({
      filename,
      exchangeIPCMap: { coinbase: recordingIPC('coinbase', ['ETH-USDC'], calls) },
      configuredExchanges: ['coinbase'],
      preflight: () => checkRestorePreconditions(filename, { paths: dest.paths }),
      restore: () => assert.fail('applier must not run'),
      logger: silentLogger,
    });
    assert.equal(status, 400);
    assert.equal(body.code, 'legacy-archive-missing-base');
    assert.deepEqual(calls, [], 'no regime:stop-all for a legacy refusal');
    assert.deepEqual(listDir(dest.dataDir), before, 'no staging left behind');
  });

  it('refuses an unacknowledged fund removal, and the restore sends no stop-all', async () => {
    const source = makeInstall('source', BASE);
    const created = await createBackup({ paths: source.paths });
    assert.equal(created.success, true, created.error);
    const dest = makeInstall('dest', DEST_BASE);
    transfer(source, dest, created.filename);

    const check = await checkRestorePreconditions(created.filename, { paths: dest.paths });
    assert.equal(check.ok, false);
    assert.equal(check.code, 'fund-removal-unacknowledged');
    assert.equal(check.error, restoreBackup(created.filename, { paths: dest.paths }).error);
    assert.equal((await checkRestorePreconditions(created.filename, { paths: dest.paths, acceptFundRemoval: true })).ok, true);

    const calls = [];
    const { status, body } = await performRestore({
      filename: created.filename,
      exchangeIPCMap: { coinbase: recordingIPC('coinbase', ['BTC-USDC'], calls) },
      configuredExchanges: ['coinbase'],
      preflight: () => checkRestorePreconditions(created.filename, { paths: dest.paths }),
      restore: () => assert.fail('applier must not run'),
      logger: silentLogger,
    });
    assert.equal(status, 400);
    assert.equal(body.code, 'fund-removal-unacknowledged');
    assert.deepEqual(calls, []);
  });

  it('refuses a corrupt archive, a malformed manifest and an invalid legacy base', async () => {
    const install = makeInstall('dest', BASE);
    const backups = path.join(install.dataDir, 'backups');
    fs.mkdirSync(backups, { recursive: true });
    fs.writeFileSync(path.join(backups, 'backup-corrupt.zip'), 'not a zip at all');
    assert.equal((await checkRestorePreconditions('backup-corrupt.zip', { paths: install.paths })).code, 'archive-corrupt');

    const staging = path.join(root, 'manifest');
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, MANIFEST_FILENAME), '{not json');
    assert.equal(spawnSync('zip', ['-q', path.join(backups, 'backup-badmanifest.zip'), MANIFEST_FILENAME], { cwd: staging }).status, 0);
    assert.equal((await checkRestorePreconditions('backup-badmanifest.zip', { paths: install.paths })).code, 'manifest-malformed');

    assert.equal((await checkRestorePreconditions('backup-corrupt.zip', { paths: install.paths, legacyBaseConfig: /** @type {any} */ ('x') })).code, 'legacy-base-invalid');
    assert.equal((await checkRestorePreconditions('backup-missing.zip', { paths: install.paths })).error, 'Backup not found');
  });

  it('passes a manifest archive that restores cleanly', async () => {
    const source = makeInstall('source', BASE);
    const created = await createBackup({ paths: source.paths });
    assert.equal(created.success, true, created.error);
    const dest = makeInstall('dest', BASE);
    transfer(source, dest, created.filename);
    assert.deepEqual(await checkRestorePreconditions(created.filename, { paths: dest.paths }), { ok: true });
  });

  // #1809 — a destination fund's interrupted DCA import would roll forward
  // over (or strand) the restored generation; an archive carrying a journal
  // was taken mid-import. Both refuse before maintenance or stop-all.
  describe('pending DCA imports (#1809)', () => {
    const { JOURNAL_FILENAME } = require('../src/dca-conversion-transaction');
    const fundDir = (install) => path.join(install.dataDir, 'coinbase', 'ETH-USDC');
    const seedAccounting = (install) => {
      writeJson(path.join(fundDir(install), 'fill-ledger.json'), ledgerOf('saved'));
      writeJson(path.join(fundDir(install), 'regime-state.json'), { position: { totalAsset: 0 } });
      writeJson(path.join(fundDir(install), 'state.json'), { orders: [{ status: 'pending' }] });
    };
    const pendImport = (install) => {
      writeJson(path.join(fundDir(install), 'regime-state.json'), { position: { totalAsset: 1 } });
      writeJson(path.join(fundDir(install), JOURNAL_FILENAME), { version: 1, status: 'publishing', entries: [] });
    };
    /** Every file under the data directory, by relative path. */
    const tree = (dataDir) => {
      const out = {};
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else out[path.relative(dataDir, full)] = fs.readFileSync(full, 'utf8');
        }
      };
      walk(dataDir);
      return out;
    };
    const restoreWith = async (filename, preflight) => {
      const calls = [];
      const result = await performRestore({
        filename,
        exchangeIPCMap: { coinbase: recordingIPC('coinbase', ['ETH-USDC'], calls) },
        configuredExchanges: ['coinbase'],
        preflight,
        restore: () => assert.fail('applier must not run'),
        logger: silentLogger,
      });
      return { ...result, calls };
    };

    it('refuses hourly and full restores onto a fund with a publishing import journal', async () => {
      const install = makeInstall('dest', BASE);
      seedAccounting(install);
      const snapshot = createFundStateBackup({ paths: install.paths });
      assert.equal(snapshot.success, true, snapshot.error);
      const archive = await createBackup({ paths: install.paths });
      assert.equal(archive.success, true, archive.error);
      pendImport(install);
      const before = tree(install.dataDir);

      const hourly = await restoreWith(snapshot.snapshotId,
        () => checkFundStateRestorePreconditions(snapshot.snapshotId, 'coinbase', 'ETH-USDC', { paths: install.paths }));
      assert.equal(hourly.status, 400);
      assert.equal(hourly.body.code, 'dca-import-pending');
      assert.match(hourly.body.error, /coinbase\/ETH-USDC has an interrupted DCA import.*Finish import recovery first/);
      assert.deepEqual(hourly.calls, [], 'no maintenance window or stop-all');

      const check = await checkRestorePreconditions(archive.filename, { paths: install.paths });
      assert.equal(check.ok, false);
      assert.equal(check.code, 'dca-import-pending');
      const applied = restoreBackup(archive.filename, { paths: install.paths });
      assert.equal(applied.success, false);
      assert.equal(applied.code, 'dca-import-pending');
      assert.equal(applied.error, check.error, 'same refusal text as the applier');
      const full = await restoreWith(archive.filename, () => checkRestorePreconditions(archive.filename, { paths: install.paths }));
      assert.equal(full.status, 400);
      assert.equal(full.body.code, 'dca-import-pending');
      assert.deepEqual(full.calls, []);

      assert.deepEqual(tree(install.dataDir), before, 'journal and accounting byte-identical, no staging left');
      assert.equal(maintenance.isMaintenanceActive(), false);
    });

    it('refuses an archive that carries an unresolved import journal', async () => {
      const source = makeInstall('source', BASE);
      seedAccounting(source);
      const created = await createBackup({ paths: source.paths });
      assert.equal(created.success, true, created.error);
      plantMembers(source, created.filename, { 'coinbase/ETH-USDC/regime-state.json': { position: { totalAsset: 1 } }, [`coinbase/ETH-USDC/${JOURNAL_FILENAME}`]: { version: 1, status: 'publishing', entries: [] } });
      const dest = makeInstall('dest', BASE);
      seedAccounting(dest);
      transfer(source, dest, created.filename);
      const before = tree(dest.dataDir);

      const check = await checkRestorePreconditions(created.filename, { paths: dest.paths });
      assert.equal(check.ok, false);
      assert.equal(check.code, 'archive-dca-import-pending');
      assert.match(check.error, new RegExp(`coinbase/ETH-USDC/${JOURNAL_FILENAME.replace(/\./g, '\\.')}`));
      assert.match(check.error, /taken after that import's recovery completed\. No files were changed\./);
      const applied = restoreBackup(created.filename, { paths: dest.paths });
      assert.equal(applied.code, 'archive-dca-import-pending');
      assert.equal(applied.error, check.error);
      const full = await restoreWith(created.filename, () => checkRestorePreconditions(created.filename, { paths: dest.paths }));
      assert.equal(full.body.code, 'archive-dca-import-pending');
      assert.deepEqual(full.calls, []);
      assert.deepEqual(tree(dest.dataDir), before);
    });

    it('counts a root-layout legacy archive\'s translated fund in the pre-flight', async () => {
      const staging = path.join(root, 'root-layout');
      writeJson(path.join(staging, 'state.json'), { orders: [{ status: 'pending' }] });
      const filename = 'backup-root-layout-0001.zip';
      const dest = makeInstall('dest', BASE);
      seedAccounting(dest);
      pendImport(dest);
      fs.mkdirSync(path.join(dest.dataDir, 'backups'), { recursive: true });
      assert.equal(spawnSync('zip', ['-q', path.join(dest.dataDir, 'backups', filename), 'state.json'], { cwd: staging }).status, 0);
      const before = tree(dest.dataDir);
      const check = await checkRestorePreconditions(filename, { paths: dest.paths, acceptLegacyWithoutBase: true });
      assert.equal(check.code, 'dca-import-pending', JSON.stringify(check));
      const applied = restoreBackup(filename, { paths: dest.paths, acceptLegacyWithoutBase: true });
      assert.equal(applied.code, 'dca-import-pending');
      assert.deepEqual(tree(dest.dataDir), before);
    });

    it('ignores a pending import in a fund the archive does not restore', async () => {
      const source = makeInstall('source', BASE);
      seedAccounting(source);
      const created = await createBackup({ paths: source.paths });
      assert.equal(created.success, true, created.error);
      const dest = makeInstall('dest', {
        exchanges: { coinbase: { pairs: { ...BASE.exchanges.coinbase.pairs, ...DEST_BASE.exchanges.coinbase.pairs } } },
        global: {},
      });
      transfer(source, dest, created.filename);
      writeJson(path.join(dest.dataDir, 'coinbase', 'BTC-USDC', JOURNAL_FILENAME), { version: 1, status: 'publishing', entries: [] });
      // Restoring removes BTC-USDC from the configuration but writes none of its files.
      assert.deepEqual(await checkRestorePreconditions(created.filename, { paths: dest.paths, acceptFundRemoval: true }), { ok: true });
    });
  });

  it('refuses archive accounting the readers would reject, before stop-all and without touching the destination (#1811)', async () => {
    const incompatible = {
      'a non-array ledger': { ledger: { fills: [] }, reason: /not an array/ },
      'a newer ledger format': { ledger: ledgerOf('t1').map((row) => ({ ...row, formatVersion: 2 })), reason: /newer build/ },
      'a malformed ledger row': { ledger: [{ tradeId: 't1' }], reason: /invalid entry/ },
    };
    for (const [name, { ledger, reason }] of Object.entries(incompatible)) {
      const source = makeInstall(`source-${name}`, BASE);
      const created = await createBackup({ paths: source.paths });
      assert.equal(created.success, true, created.error);
      plantMembers(source, created.filename, { 'coinbase/ETH-USDC/fill-ledger.json': ledger });
      const dest = makeInstall(`dest-${name}`, BASE);
      const destLedger = path.join(dest.dataDir, 'coinbase', 'ETH-USDC', 'fill-ledger.json');
      writeJson(destLedger, ledgerOf('working'));
      transfer(source, dest, created.filename);
      const before = fs.readFileSync(destLedger, 'utf8');
      const dirBefore = listDir(dest.dataDir);

      const check = await checkRestorePreconditions(created.filename, { paths: dest.paths });
      assert.equal(check.ok, false, name);
      assert.equal(check.code, 'payload-incompatible');
      assert.match(check.error, reason);
      const calls = [];
      const { status, body } = await performRestore({
        filename: created.filename,
        exchangeIPCMap: { coinbase: recordingIPC('coinbase', ['ETH-USDC'], calls) },
        configuredExchanges: ['coinbase'],
        preflight: () => checkRestorePreconditions(created.filename, { paths: dest.paths }),
        restore: () => assert.fail('applier must not run'),
        logger: silentLogger,
      });
      assert.equal(status, 400);
      assert.equal(body.code, 'payload-incompatible');
      assert.deepEqual(calls, [], 'no engine maintenance or stop-all');
      // The applier repeats the check for a source that changed after preflight.
      const applied = restoreBackup(created.filename, { paths: dest.paths });
      assert.equal(applied.success, false);
      assert.equal(applied.code, 'payload-incompatible');
      assert.equal(fs.readFileSync(destLedger, 'utf8'), before, 'working ledger preserved');
      assert.deepEqual(listDir(dest.dataDir), dirBefore, 'no staging or recovery generation left behind');
    }
  });

  it('refuses conflicting legacy and per-fund placement intents before stopping engines', async () => {
    const dest = makeInstall('dest-duplicate-intents', BASE);
    const staging = path.join(root, 'duplicate-intents-archive');
    const legacy = 'coinbase/placement-intents.json';
    const fund = 'coinbase/ETH-USDC/placement-intents.json';
    writeJson(path.join(staging, legacy), { version: 1, intents: [{ id: 'uncertain-order', status: 'unresolved' }] });
    writeJson(path.join(staging, fund), { version: 1, intents: [] });
    const backups = path.join(dest.dataDir, 'backups');
    fs.mkdirSync(backups);
    const filename = 'backup-duplicate-intents.zip';
    assert.equal(spawnSync('zip', ['-q', path.join(backups, filename), legacy, fund], { cwd: staging }).status, 0);
    const options = { paths: dest.paths, acceptLegacyWithoutBase: true };
    const inspection = inspectBackup(filename, { paths: dest.paths });
    assert.deepEqual(inspection.layoutConflicts, [{ artifact: legacy, existing: fund }]);
    const check = await checkRestorePreconditions(filename, options);
    assert.equal(check.code, 'legacy-layout-placement-intents-conflict');
    assert.match(check.error, /preserve both.*reconcile/i);
    const calls = [];
    const result = await performRestore({
      filename,
      exchangeIPCMap: { coinbase: recordingIPC('coinbase', ['ETH-USDC'], calls) },
      configuredExchanges: ['coinbase'],
      preflight: () => checkRestorePreconditions(filename, options),
      restore: () => assert.fail('applier must not run'),
      logger: silentLogger,
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, check.code);
    assert.deepEqual(calls, []);
    const applied = restoreBackup(filename, options);
    assert.equal(applied.code, check.code);
    assert.equal(fs.existsSync(path.join(dest.dataDir, fund)), false);
  });

  it('rejects both orders of aliased placement-intent members before extraction or stopping engines', async () => {
    for (const reverse of [false, true]) {
      const dest = makeInstall(`dest-intent-alias-${reverse}`, BASE);
      const filename = `backup-alias-${reverse}.zip`;
      const backups = path.join(dest.dataDir, 'backups');
      fs.mkdirSync(backups);
      const retained = { version: 1, intents: [{ id: 'live-blocker', status: 'unresolved' }] };
      const destinationFile = path.join(dest.dataDir, 'coinbase', 'ETH-USDC', 'placement-intents.json');
      writeJson(destinationFile, retained);
      const members = [
        { name: 'coinbase/ETH-USDC/placement-intents.json', content: JSON.stringify({ intents: [{ id: 'source-blocker', status: 'unresolved' }] }) },
        { name: './coinbase/ETH-USDC/placement-intents.json', content: JSON.stringify({ intents: [] }) },
      ];
      archiveWithMembers(path.join(backups, filename), reverse ? members.reverse() : members);
      const options = { paths: dest.paths, acceptLegacyWithoutBase: true };
      const check = await checkRestorePreconditions(filename, options);
      assert.equal(check.code, 'archive-unsafe-paths');
      assert.match(check.error, /conflicting members/);
      assert.equal(inspectBackup(filename, { paths: dest.paths }).code, check.code);
      const calls = [];
      const result = await performRestore({
        filename,
        exchangeIPCMap: { coinbase: recordingIPC('coinbase', ['ETH-USDC'], calls) },
        configuredExchanges: ['coinbase'],
        preflight: () => checkRestorePreconditions(filename, options),
        restore: () => assert.fail('applier must not run'),
        logger: silentLogger,
      });
      assert.equal(result.body.code, check.code);
      assert.deepEqual(calls, []);
      assert.equal(restoreBackup(filename, options).code, check.code);
      assert.deepEqual(JSON.parse(fs.readFileSync(destinationFile, 'utf8')), retained);
      assert.ok(!fs.readdirSync(dest.dataDir).some(name => name.startsWith('.restore-temp-')));
    }
  });

  it('checks prefixed legacy conflicts and invalid prefixed fund accounting before stopping engines', async () => {
    const dest = makeInstall('dest-prefixed-refusals', BASE);
    const backups = path.join(dest.dataDir, 'backups');
    fs.mkdirSync(backups);
    const cases = [
      ['backup-prefixed-intents.zip', [
        { name: './coinbase/placement-intents.json', content: JSON.stringify({ intents: [] }) },
        { name: './coinbase/ETH-USDC/placement-intents.json', content: JSON.stringify({ intents: [] }) },
      ], 'legacy-layout-placement-intents-conflict'],
      ['backup-prefixed-state.zip', [{ name: './coinbase/ETH-USDC/state.json', content: '[1]' }], 'payload-incompatible'],
      ['backup-prefixed-root.zip', [{ name: './state.json', content: '[1]' }], 'payload-incompatible'],
    ];
    for (const [filename, members, code] of cases) {
      archiveWithMembers(path.join(backups, filename), members);
      const options = { paths: dest.paths, acceptLegacyWithoutBase: true };
      const check = await checkRestorePreconditions(filename, options);
      assert.equal(check.code, code, filename);
      const calls = [];
      const result = await performRestore({
        filename,
        exchangeIPCMap: { coinbase: recordingIPC('coinbase', ['ETH-USDC'], calls) },
        configuredExchanges: ['coinbase'],
        preflight: () => checkRestorePreconditions(filename, options),
        restore: () => assert.fail('applier must not run'),
        logger: silentLogger,
      });
      assert.equal(result.body.code, code);
      assert.deepEqual(calls, []);
      assert.equal(restoreBackup(filename, options).code, code);
    }
    assert.deepEqual(inspectBackup('backup-prefixed-intents.zip', { paths: dest.paths }).layoutConflicts, [
      { artifact: 'coinbase/placement-intents.json', existing: 'coinbase/ETH-USDC/placement-intents.json' },
    ]);
  });

  it('accepts ordinary prefixed members and identifies a prefixed manifest consistently', async () => {
    const dest = makeInstall('dest-prefixed-manifest', BASE);
    const backups = path.join(dest.dataDir, 'backups');
    fs.mkdirSync(backups);
    const filename = 'backup-prefixed-manifest.zip';
    const state = { orders: [{ id: 'kept' }] };
    const manifest = { manifestVersion: 1, createdAt: new Date().toISOString(), config: buildConfigSnapshot(BASE) };
    archiveWithMembers(path.join(backups, filename), [
      { name: './backup-manifest.json', content: JSON.stringify(manifest) },
      { name: './coinbase/ETH-USDC/state.json', content: JSON.stringify(state) },
    ]);
    const options = { paths: dest.paths };
    const report = inspectBackup(filename, options);
    assert.equal(report.success, true);
    assert.equal(report.legacy, false);
    assert.equal(report.compatible, true);
    assert.deepEqual(await checkRestorePreconditions(filename, options), { ok: true });
    const restored = restoreBackup(filename, options);
    assert.equal(restored.success, true, restored.error);
    assert.equal(restored.legacy, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dest.dataDir, 'coinbase', 'ETH-USDC', 'state.json'), 'utf8')), state);

    const legacy = 'backup-prefixed-root-valid.zip';
    archiveWithMembers(path.join(backups, legacy), [{ name: './state.json', content: JSON.stringify(state) }]);
    const legacyOptions = { paths: dest.paths, acceptLegacyWithoutBase: true };
    assert.deepEqual(await checkRestorePreconditions(legacy, legacyOptions), { ok: true });
    assert.equal(inspectBackup(legacy, { paths: dest.paths }).rootTranslation.files[0].target, 'coinbase/ETH-USDC/state.json');
    assert.equal(restoreBackup(legacy, legacyOptions).success, true);
  });

  it('refuses symbolic links, including directory parents, without touching their targets', async () => {
    for (const parentLink of [false, true]) {
      const dest = makeInstall(`dest-link-${parentLink}`, BASE);
      const backups = path.join(dest.dataDir, 'backups');
      fs.mkdirSync(backups);
      const filename = `backup-link-${parentLink}.zip`;
      const victim = path.join(root, `victim-${parentLink}.json`);
      fs.writeFileSync(victim, '{"sentinel":"untouched"}');
      const manifest = { manifestVersion: 1, createdAt: new Date().toISOString(), config: buildConfigSnapshot(BASE) };
      const members = [
        { name: 'backup-manifest.json', content: JSON.stringify(manifest) },
        { name: parentLink ? 'coinbase' : 'config.json', content: victim, mode: 0o120777 },
      ];
      if (parentLink) members.push({ name: 'coinbase/ETH-USDC/state.json', content: '{}' });
      archiveWithMembers(path.join(backups, filename), members);
      const options = { paths: dest.paths };
      const check = await checkRestorePreconditions(filename, options);
      assert.equal(check.code, 'archive-unsafe-paths');
      assert.match(check.error, /symbolic links/);
      assert.equal(inspectBackup(filename, options).code, check.code);
      assert.equal(restoreBackup(filename, options).code, check.code);
      assert.equal(fs.readFileSync(victim, 'utf8'), '{"sentinel":"untouched"}');
    }
  });

  it('refuses unsafe paths and fails closed when member metadata cannot be verified', async () => {
    const dest = makeInstall('dest-unsafe-paths', BASE);
    const backups = path.join(dest.dataDir, 'backups');
    fs.mkdirSync(backups);
    const options = { paths: dest.paths, acceptLegacyWithoutBase: true };
    for (const [index, name] of ['../state.json', '/state.json', 'C:/state.json', 'coinbase\\state.json', 'coinbase/evil\nstate.json'].entries()) {
      const filename = `backup-unsafe-${index}.zip`;
      archiveWithMembers(path.join(backups, filename), [{ name, content: '{}' }]);
      assert.equal((await checkRestorePreconditions(filename, options)).code, 'archive-unsafe-paths', name);
      assert.equal(restoreBackup(filename, options).code, 'archive-unsafe-paths', name);
    }

    const filename = 'backup-bad-metadata.zip';
    const malformed = path.join(backups, filename);
    archiveWithMembers(malformed, [{ name: 'state.json', content: '{}' }]);
    const bytes = fs.readFileSync(malformed);
    // Disagree with the central directory on the UTF-8 flag.
    bytes.writeUInt16LE(0, 6);
    fs.writeFileSync(malformed, bytes);
    const check = await checkRestorePreconditions(filename, options);
    assert.ok(['archive-corrupt', 'archive-unsafe-paths'].includes(check.code));
    assert.equal(inspectBackup(filename, options).code, 'archive-unsafe-paths');
    assert.equal(restoreBackup(filename, options).code, 'archive-unsafe-paths');
  });

  it('round-trips ordinary UTF-8 and glob characters in a real backup', async () => {
    const source = makeInstall('source-ordinary-names', BASE);
    fs.writeFileSync(path.join(source.dataDir, 'report[1].txt'), 'brackets');
    fs.writeFileSync(path.join(source.dataDir, '普通.txt'), 'unicode');
    const created = await createBackup({ paths: source.paths });
    assert.equal(created.success, true, created.error);
    const dest = makeInstall('dest-ordinary-names', BASE);
    transfer(source, dest, created.filename);
    assert.equal(inspectBackup(created.filename, { paths: dest.paths }).compatible, true);
    assert.deepEqual(await checkRestorePreconditions(created.filename, { paths: dest.paths }), { ok: true });
    const result = restoreBackup(created.filename, { paths: dest.paths });
    assert.equal(result.success, true, result.error);
    assert.equal(fs.readFileSync(path.join(dest.dataDir, 'report[1].txt'), 'utf8'), 'brackets');
    assert.equal(fs.readFileSync(path.join(dest.dataDir, '普通.txt'), 'utf8'), 'unicode');
  });

  it('preserves a leading Unicode BOM in a filename through native backup and restore', async () => {
    const source = makeInstall('source-bom-name', BASE);
    fs.writeFileSync(path.join(source.dataDir, 'note.txt'), 'plain');
    fs.writeFileSync(path.join(source.dataDir, '\uFEFFnote.txt'), 'leading BOM');
    const created = await createBackup({ paths: source.paths });
    assert.equal(created.success, true, created.error);
    const dest = makeInstall('dest-bom-name', BASE);
    transfer(source, dest, created.filename);
    assert.equal(inspectBackup(created.filename, { paths: dest.paths }).compatible, true);
    assert.deepEqual(await checkRestorePreconditions(created.filename, { paths: dest.paths }), { ok: true });
    const restored = restoreBackup(created.filename, { paths: dest.paths });
    assert.equal(restored.success, true, restored.error);
    assert.equal(fs.readFileSync(path.join(dest.dataDir, 'note.txt'), 'utf8'), 'plain');
    assert.equal(fs.readFileSync(path.join(dest.dataDir, '\uFEFFnote.txt'), 'utf8'), 'leading BOM');
  });

  it('accepts FAT-created file and directory metadata through inspection and restore', async () => {
    const dest = makeInstall('dest-dos-archive', BASE);
    const backups = path.join(dest.dataDir, 'backups');
    fs.mkdirSync(backups);
    const filename = 'backup-dos-archive.zip';
    const manifest = { manifestVersion: 1, createdAt: new Date().toISOString(), config: buildConfigSnapshot(BASE) };
    archiveWithMembers(path.join(backups, filename), [
      { name: 'backup-manifest.json', content: JSON.stringify(manifest), dos: true },
      { name: 'coinbase/', dos: true },
      { name: 'coinbase/ETH-USDC/', dos: true },
      { name: 'coinbase/ETH-USDC/state.json', content: '{"orders":[]}', dos: true },
    ]);
    const options = { paths: dest.paths };
    assert.equal(inspectBackup(filename, options).compatible, true);
    assert.deepEqual(await checkRestorePreconditions(filename, options), { ok: true });
    const restored = restoreBackup(filename, options);
    assert.equal(restored.success, true, restored.error);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dest.dataDir, 'coinbase', 'ETH-USDC', 'state.json'), 'utf8')), { orders: [] });
  });

  it('accepts ZIP64 directory and local-offset metadata through inspection and restore', async () => {
    const dest = makeInstall('dest-zip64', BASE);
    const backups = path.join(dest.dataDir, 'backups');
    fs.mkdirSync(backups);
    const filename = 'backup-zip64.zip';
    archiveWithMembers(path.join(backups, filename), [
      { name: 'coinbase/ETH-USDC/state.json', content: '{"orders":[]}' },
    ], { zip64: true });
    const options = { paths: dest.paths, acceptLegacyWithoutBase: true };
    assert.equal(inspectBackup(filename, options).legacy, true);
    assert.deepEqual(await checkRestorePreconditions(filename, options), { ok: true });
    const restored = restoreBackup(filename, options);
    assert.equal(restored.success, true, restored.error);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dest.dataDir, 'coinbase', 'ETH-USDC', 'state.json'), 'utf8')), { orders: [] });
  });

  it('reads a literal bracketed accounting member rather than an unzip wildcard match', async () => {
    const dest = makeInstall('dest-wildcard-member', BASE);
    const backups = path.join(dest.dataDir, 'backups');
    fs.mkdirSync(backups);
    const filename = 'backup-wildcard-member.zip';
    archiveWithMembers(path.join(backups, filename), [
      { name: 'coinbase/[1]/state.json', content: '[1]' },
      { name: 'coinbase/1/state.json', content: '{}' },
    ]);
    const check = await checkRestorePreconditions(filename, { paths: dest.paths, acceptLegacyWithoutBase: true });
    assert.equal(check.code, 'payload-incompatible');
    assert.match(check.error, /coinbase\/\[1\]\/state.json/);
  });

  it('checks generated configuration destinations before stopping engines', async () => {
    const dest = makeInstall('dest-generated-case', BASE);
    const backups = path.join(dest.dataDir, 'backups');
    fs.mkdirSync(backups);
    const filename = 'backup-generated-case.zip';
    archiveWithMembers(path.join(backups, filename), [{ name: 'state.json', content: '{}' }]);
    const baseFile = path.join(dest.dataDir, 'CONFIG-BASE.SNAPSHOT.JSON');
    fs.writeFileSync(baseFile, '{"keep":true}');
    const options = { paths: dest.paths, acceptLegacyWithoutBase: true };
    const check = await checkRestorePreconditions(filename, options);
    assert.equal(check.code, 'destination-path-unsafe');
    assert.equal(inspectBackup(filename, options).code, check.code);
    const calls = [];
    const result = await performRestore({
      filename, exchangeIPCMap: { coinbase: recordingIPC('coinbase', ['ETH-USDC'], calls) },
      configuredExchanges: ['coinbase'], preflight: () => checkRestorePreconditions(filename, options),
      restore: () => assert.fail('applier must not run'), logger: silentLogger,
    });
    assert.equal(result.body.code, check.code);
    assert.deepEqual(calls, []);
    assert.equal(restoreBackup(filename, options).code, check.code);
    assert.equal(fs.readFileSync(baseFile, 'utf8'), '{"keep":true}');
  });

  it('refuses case aliases of protected accounting, credentials, and journals', async () => {
    const dest = makeInstall('dest-protected-case', BASE);
    const backups = path.join(dest.dataDir, 'backups');
    fs.mkdirSync(backups);
    const secrets = { token: 'keep' };
    writeJson(path.join(dest.dataDir, 'operator-auth.json'), secrets);
    const intents = { version: 1, intents: [{ id: 'keep-blocker', status: 'unresolved' }] };
    writeJson(path.join(dest.dataDir, 'coinbase', 'ETH-USDC', 'placement-intents.json'), intents);
    const cases = [
      'OPERATOR-AUTH.JSON', 'COINBASE-KEYS.JSON',
      'coinbase/ETH-USDC/PLACEMENT-INTENTS.JSON',
      'coinbase/ETH-USDC/REGIME-STATE.JSON',
      'coinbase/ETH-USDC/.DCA-IMPORT-JOURNAL.JSON',
      '.RESTORE-JOURNAL.JSON',
    ];
    const options = { paths: dest.paths, acceptLegacyWithoutBase: true };
    for (const [index, name] of cases.entries()) {
      const filename = `backup-protected-case-${index}.zip`;
      archiveWithMembers(path.join(backups, filename), [{ name, content: '{}' }]);
      const check = await checkRestorePreconditions(filename, options);
      assert.equal(check.code, 'archive-unsafe-paths', name);
      assert.equal(restoreBackup(filename, options).code, check.code, name);
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dest.dataDir, 'operator-auth.json'), 'utf8')), secrets);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dest.dataDir, 'coinbase', 'ETH-USDC', 'placement-intents.json'), 'utf8')), intents);
  });

  it('refuses aliases of existing destination components, including Unicode-equivalent spellings', async () => {
    const dest = makeInstall('dest-existing-case', BASE);
    const backups = path.join(dest.dataDir, 'backups');
    fs.mkdirSync(backups);
    const existing = path.join(dest.dataDir, 'coinbase', 'ETH-USDC', 'operator-note.txt');
    writeJson(existing, { value: 'keep' });
    const accented = path.join(dest.dataDir, 'coinbase', 'ETH-USDC', 'café.txt');
    fs.writeFileSync(accented, 'keep');
    const actual = fs.readdirSync(path.dirname(accented)).find(name => name.normalize('NFC') === 'café.txt');
    const variant = actual === actual.normalize('NFC') ? actual.normalize('NFD') : actual.normalize('NFC');
    const cases = ['COINBASE/ETH-USDC/other.txt', 'coinbase/eth-usdc/other.txt',
      'coinbase/ETH-USDC/OPERATOR-NOTE.TXT', `coinbase/ETH-USDC/${variant}`];
    const options = { paths: dest.paths, acceptLegacyWithoutBase: true };
    for (const [index, name] of cases.entries()) {
      const filename = `backup-destination-case-${index}.zip`;
      archiveWithMembers(path.join(backups, filename), [{ name, content: 'overwrite' }]);
      const check = await checkRestorePreconditions(filename, options);
      if (index === cases.length - 1) {
        // Some unzip builds render this UTF-8 spelling lossily; refusing the
        // archive before destination comparison is also safe.
        assert.ok(['destination-path-unsafe', 'archive-unsafe-paths'].includes(check.code), name);
      } else {
        assert.equal(check.code, 'destination-path-unsafe', name);
      }
      assert.equal(inspectBackup(filename, options).code, check.code, name);
      assert.equal(restoreBackup(filename, options).code, check.code, name);
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(existing, 'utf8')), { value: 'keep' });
    assert.equal(fs.readFileSync(accented, 'utf8'), 'keep');
  });

  it('extracts the validated archive copy when the original is replaced during validation', () => {
    const dest = makeInstall('dest-archive-swap', BASE);
    const backups = path.join(dest.dataDir, 'backups');
    fs.mkdirSync(backups);
    const filename = 'backup-archive-swap.zip';
    const archive = path.join(backups, filename);
    const replacement = path.join(root, 'replacement.zip');
    const victim = path.join(root, 'swap-victim.json');
    fs.writeFileSync(victim, '{"sentinel":"untouched"}');
    archiveWithMembers(archive, [{ name: 'state.json', content: '{"orders":[{"id":"original"}]}' }]);
    archiveWithMembers(replacement, [{ name: 'config.json', content: victim, mode: 0o120777 }]);
    const fakeBin = path.join(root, 'swap-unzip');
    fs.mkdirSync(fakeBin);
    const realUnzip = spawnSync('which', ['unzip']).stdout.toString().trim();
    fs.writeFileSync(path.join(fakeBin, 'unzip'),
      `#!/bin/sh\nif [ "$1" = "-o" ]; then cp "${replacement}" "${archive}"; fi\nexec "${realUnzip}" "$@"\n`, { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath}`;
    try {
      const result = restoreBackup(filename, { paths: dest.paths, acceptLegacyWithoutBase: true });
      assert.equal(result.success, true, result.error);
    } finally {
      process.env.PATH = originalPath;
    }
    assert.equal(fs.readFileSync(victim, 'utf8'), '{"sentinel":"untouched"}');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dest.dataDir, 'coinbase', 'ETH-USDC', 'state.json'), 'utf8')), { orders: [{ id: 'original' }] });
    assert.equal(spawnSync('unzip', ['-Z1', archive]).stdout.toString().trim(), 'config.json');
    assert.ok(!fs.readdirSync(dest.dataDir).some(name => name.startsWith('.restore-temp-')));
  });

  it('validates translated root state before stopping engines for a legacy restore', async () => {
    const dest = makeInstall('dest-root-state', BASE);
    const staging = path.join(root, 'root-state-archive');
    fs.mkdirSync(staging);
    const backups = path.join(dest.dataDir, 'backups');
    fs.mkdirSync(backups);

    for (const [name, contents] of [['invalid-json', '{bad'], ['non-object', '[1]'], ['valid', '{"orders":[]}']]) {
      fs.writeFileSync(path.join(staging, 'state.json'), contents);
      const filename = `backup-root-state-${name}.zip`;
      assert.equal(spawnSync('zip', ['-q', path.join(backups, filename), 'state.json'], { cwd: staging }).status, 0);
      const options = { paths: dest.paths, acceptLegacyWithoutBase: true };
      const check = await checkRestorePreconditions(filename, options);
      if (name === 'valid') {
        assert.deepEqual(check, { ok: true });
        continue;
      }
      assert.equal(check.code, 'payload-incompatible', name);
      assert.match(check.error, /coinbase\/ETH-USDC\/state\.json/);
      const calls = [];
      const result = await performRestore({
        filename,
        exchangeIPCMap: { coinbase: recordingIPC('coinbase', ['ETH-USDC'], calls) },
        configuredExchanges: ['coinbase'],
        preflight: () => checkRestorePreconditions(filename, options),
        restore: () => assert.fail('applier must not run'),
        logger: silentLogger,
      });
      assert.equal(result.status, 400);
      assert.equal(result.body.code, 'payload-incompatible');
      assert.deepEqual(calls, [], 'no engine maintenance or stop-all');
      assert.equal(restoreBackup(filename, options).code, 'payload-incompatible');
    }
  });

  it('refuses invalid JSON and a non-object state file in an archive (#1811)', async () => {
    const source = makeInstall('source', BASE);
    fs.mkdirSync(path.join(source.dataDir, 'coinbase', 'ETH-USDC'), { recursive: true });
    const created = await createBackup({ paths: source.paths });
    plantMembers(source, created.filename, { 'coinbase/ETH-USDC/fill-ledger.json': '{not json' });
    const dest = makeInstall('dest', BASE);
    transfer(source, dest, created.filename);
    const jsonCheck = await checkRestorePreconditions(created.filename, { paths: dest.paths });
    assert.equal(jsonCheck.code, 'payload-incompatible');
    assert.match(jsonCheck.error, /corrupted or unreadable/);

    writeJson(path.join(source.dataDir, 'coinbase', 'ETH-USDC', 'fill-ledger.json'), ledgerOf('t1'));
    const second = await createBackup({ paths: source.paths });
    plantMembers(source, second.filename, { 'coinbase/ETH-USDC/regime-state.json': [1] });
    transfer(source, dest, second.filename);
    const stateCheck = await checkRestorePreconditions(second.filename, { paths: dest.paths });
    assert.equal(stateCheck.code, 'payload-incompatible');
    assert.match(stateCheck.error, /regime-state.json did not parse to an object/);
  });

  describe('placement intents in a full archive (#1843)', () => {
    const intentsPath = (install) => path.join(install.dataDir, 'coinbase', 'ETH-USDC', 'placement-intents.json');
    const intentsDoc = (...intents) => ({ version: 1, intents });
    const intent = (id, status) => ({ id, status });

    it('merges archived intents into the destination without clearing a live blocker', async () => {
      const source = makeInstall('source', BASE);
      writeJson(path.join(source.dataDir, 'coinbase', 'ETH-USDC', 'fill-ledger.json'), ledgerOf('t1'));
      writeJson(intentsPath(source), intentsDoc(intent('intent-archived', 'unresolved')));
      const created = await createBackup({ paths: source.paths });
      assert.equal(created.success, true, created.error);
      const dest = makeInstall('dest', BASE);
      writeJson(path.join(dest.dataDir, 'coinbase', 'ETH-USDC', 'fill-ledger.json'), ledgerOf('working'));
      writeJson(intentsPath(dest), intentsDoc(intent('intent-live-unresolved', 'unresolved')));
      transfer(source, dest, created.filename);

      const restored = restoreBackup(created.filename, { paths: dest.paths });
      assert.equal(restored.success, true, restored.error);
      const ids = JSON.parse(fs.readFileSync(intentsPath(dest), 'utf8')).intents.map((row) => row.id).sort();
      assert.deepEqual(ids, ['intent-archived', 'intent-live-unresolved']);
    });

    it('keeps the live blocker when the archive holds an empty intents file', async () => {
      const source = makeInstall('source', BASE);
      writeJson(path.join(source.dataDir, 'coinbase', 'ETH-USDC', 'fill-ledger.json'), ledgerOf('t1'));
      writeJson(intentsPath(source), intentsDoc());
      const created = await createBackup({ paths: source.paths });
      const dest = makeInstall('dest', BASE);
      writeJson(intentsPath(dest), intentsDoc(intent('intent-live-unresolved', 'unresolved')));
      transfer(source, dest, created.filename);

      const restored = restoreBackup(created.filename, { paths: dest.paths });
      assert.equal(restored.success, true, restored.error);
      assert.deepEqual(JSON.parse(fs.readFileSync(intentsPath(dest), 'utf8')).intents, [intent('intent-live-unresolved', 'unresolved')]);
    });

    it('refuses a malformed intents document before stop-all and leaves the destination untouched', async () => {
      const malformed = {
        'invalid JSON': '{not valid json',
        'a missing intents array': JSON.stringify({ version: 1 }),
        'a row without a string status': JSON.stringify(intentsDoc({ id: 'x' })),
      };
      for (const [name, bytes] of Object.entries(malformed)) {
        const source = makeInstall(`source-${name}`, BASE);
        writeJson(path.join(source.dataDir, 'coinbase', 'ETH-USDC', 'fill-ledger.json'), ledgerOf('t1'));
        const created = await createBackup({ paths: source.paths });
        assert.equal(created.success, true, created.error);
        plantMembers(source, created.filename, { 'coinbase/ETH-USDC/placement-intents.json': bytes });
        const dest = makeInstall(`dest-${name}`, BASE);
        const destLedger = path.join(dest.dataDir, 'coinbase', 'ETH-USDC', 'fill-ledger.json');
        writeJson(destLedger, ledgerOf('working'));
        writeJson(intentsPath(dest), intentsDoc(intent('intent-live-unresolved', 'unresolved')));
        transfer(source, dest, created.filename);
        const intentsBefore = fs.readFileSync(intentsPath(dest), 'utf8');
        const ledgerBefore = fs.readFileSync(destLedger, 'utf8');
        const dirBefore = listDir(dest.dataDir);

        const check = await checkRestorePreconditions(created.filename, { paths: dest.paths });
        assert.equal(check.ok, false, name);
        assert.equal(check.code, 'payload-incompatible');
        assert.match(check.error, /placement-intents\.json/);
        const calls = [];
        const { status, body } = await performRestore({
          filename: created.filename,
          exchangeIPCMap: { coinbase: recordingIPC('coinbase', ['ETH-USDC'], calls) },
          configuredExchanges: ['coinbase'],
          preflight: () => checkRestorePreconditions(created.filename, { paths: dest.paths }),
          restore: () => assert.fail('applier must not run'),
          logger: silentLogger,
        });
        assert.equal(status, 400, name);
        assert.deepEqual(calls, [], 'no engine maintenance or stop-all');
        const applied = restoreBackup(created.filename, { paths: dest.paths });
        assert.equal(applied.success, false, name);
        assert.equal(applied.code, 'payload-incompatible');
        assert.equal(fs.readFileSync(intentsPath(dest), 'utf8'), intentsBefore, 'live blocker preserved');
        assert.equal(fs.readFileSync(destLedger, 'utf8'), ledgerBefore, 'accounting untouched');
        assert.deepEqual(listDir(dest.dataDir), dirBefore, 'no staging or recovery generation left behind');
      }
    });

    it('refuses without changing anything when the destination intents file is unreadable', async () => {
      const source = makeInstall('source', BASE);
      writeJson(path.join(source.dataDir, 'coinbase', 'ETH-USDC', 'fill-ledger.json'), ledgerOf('t1'));
      writeJson(intentsPath(source), intentsDoc(intent('intent-archived', 'unresolved')));
      const created = await createBackup({ paths: source.paths });
      const dest = makeInstall('dest', BASE);
      const destLedger = path.join(dest.dataDir, 'coinbase', 'ETH-USDC', 'fill-ledger.json');
      writeJson(destLedger, ledgerOf('working'));
      fs.writeFileSync(intentsPath(dest), '{corrupt');
      transfer(source, dest, created.filename);
      const dirBefore = listDir(dest.dataDir);

      const result = restoreBackup(created.filename, { paths: dest.paths });
      assert.equal(result.success, false);
      assert.match(result.error, /No files were changed/);
      assert.equal(fs.readFileSync(intentsPath(dest), 'utf8'), '{corrupt');
      assert.deepEqual(JSON.parse(fs.readFileSync(destLedger, 'utf8')), ledgerOf('working'));
      assert.deepEqual(listDir(dest.dataDir), dirBefore);
    });
  });

  it('still restores unversioned legacy ledgers and fee-only rows, leaving the bytes unchanged (#1811)', async () => {
    const source = makeInstall('source', BASE);
    const legacyRows = [{ tradeId: 'old-1', side: 'sell', size: 2, price: 50, quoteAmount: 100, fee: 0.4, timestamp: 5 }];
    writeJson(path.join(source.dataDir, 'coinbase', 'ETH-USDC', 'fill-ledger.json'), legacyRows);
    writeJson(path.join(source.dataDir, 'coinbase', 'ETH-USDC', 'state.json'), { legacy: true });
    const created = await createBackup({ paths: source.paths });
    const dest = makeInstall('dest', BASE);
    transfer(source, dest, created.filename);
    assert.deepEqual(await checkRestorePreconditions(created.filename, { paths: dest.paths }), { ok: true });
    const restored = restoreBackup(created.filename, { paths: dest.paths });
    assert.equal(restored.success, true, restored.error);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dest.dataDir, 'coinbase', 'ETH-USDC', 'fill-ledger.json'), 'utf8')), legacyRows);
  });

  it('refuses an incompatible hourly snapshot before stop-all and preserves the live ledger (#1811)', async () => {
    const install = makeInstall('dest', BASE);
    const liveLedger = path.join(install.dataDir, 'coinbase', 'ETH-USDC', 'fill-ledger.json');
    writeJson(liveLedger, ledgerOf('working'));
    const created = createFundStateBackup({ paths: install.paths });
    assert.equal(created.success, true, created.error);
    writeJson(path.join(install.dataDir, 'backups', 'fund-state', created.snapshotId, 'coinbase', 'ETH-USDC', 'fill-ledger.json'), { fills: [] });
    const before = fs.readFileSync(liveLedger, 'utf8');
    const calls = [];
    const { status, body } = await performRestore({
      filename: created.snapshotId,
      exchangeIPCMap: { coinbase: recordingIPC('coinbase', ['ETH-USDC'], calls) },
      configuredExchanges: ['coinbase'],
      preflight: () => checkFundStateRestorePreconditions(created.snapshotId, 'coinbase', 'ETH-USDC', { paths: install.paths }),
      restore: () => assert.fail('incompatible snapshots must not reach restore'),
      logger: silentLogger,
    });
    assert.equal(status, 400);
    assert.match(body.error, /not an array/);
    assert.deepEqual(calls, []);
    assert.equal(fs.readFileSync(liveLedger, 'utf8'), before);
    const direct = restoreFundStateBackup(created.snapshotId, 'coinbase', 'ETH-USDC', { paths: install.paths });
    assert.equal(direct.success, false);
    assert.equal(fs.readFileSync(liveLedger, 'utf8'), before);
  });

  it('checks a fund-state snapshot without staging it', () => {
    const install = makeInstall('dest', BASE);
    const missing = checkFundStateRestorePreconditions('20260101T000000Z', 'coinbase', 'ETH-USDC', { paths: install.paths });
    assert.deepEqual(missing, { ok: false, error: 'Fund-state snapshot not found' });
    assert.equal(checkFundStateRestorePreconditions('../x', 'coinbase', 'ETH-USDC', { paths: install.paths }).ok, false);
  });

  it('refuses an incomplete hourly snapshot before maintenance or stop-all (#1703)', async () => {
    const install = makeInstall('dest', BASE);
    writeJson(path.join(install.dataDir, 'coinbase', 'ETH-USDC', 'fill-ledger.json'), ledgerOf('synthetic'));
    const created = createFundStateBackup({ paths: install.paths });
    assert.equal(created.success, true, created.error);
    fs.unlinkSync(path.join(install.dataDir, 'backups', 'fund-state', created.snapshotId, 'coinbase', 'ETH-USDC', 'fill-ledger.json'));
    const calls = [];
    const before = listDir(install.dataDir);
    const { status, body } = await performRestore({
      filename: created.snapshotId,
      exchangeIPCMap: { coinbase: recordingIPC('coinbase', ['ETH-USDC'], calls) },
      configuredExchanges: ['coinbase'],
      preflight: () => checkFundStateRestorePreconditions(created.snapshotId, 'coinbase', 'ETH-USDC', { paths: install.paths }),
      restore: () => assert.fail('invalid snapshots must not reach restore'),
      logger: silentLogger,
    });
    assert.equal(status, 400);
    assert.match(body.error, /incomplete.*fill-ledger.json/);
    assert.deepEqual(calls, [], 'no engine maintenance, stop or restart call');
    assert.deepEqual(listDir(install.dataDir), before, 'no staging or recovery state');
    assert.equal(maintenance.isMaintenanceActive(), false);
  });
});
