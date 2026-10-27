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
const {
  createBackup,
  createFundStateBackup,
  restoreBackup,
  checkRestorePreconditions,
  checkFundStateRestorePreconditions,
  restoreFundStateBackup,
  MANIFEST_FILENAME,
} = require('../src/backup-service');


const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

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
      pendImport(source);
      const created = await createBackup({ paths: source.paths });
      assert.equal(created.success, true, created.error);
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
      writeJson(path.join(source.dataDir, 'coinbase', 'ETH-USDC', 'fill-ledger.json'), ledger);
      const created = await createBackup({ paths: source.paths });
      assert.equal(created.success, true, created.error);
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

  it('refuses invalid JSON and a non-object state file in an archive (#1811)', async () => {
    const source = makeInstall('source', BASE);
    fs.mkdirSync(path.join(source.dataDir, 'coinbase', 'ETH-USDC'), { recursive: true });
    fs.writeFileSync(path.join(source.dataDir, 'coinbase', 'ETH-USDC', 'fill-ledger.json'), '{not json');
    const created = await createBackup({ paths: source.paths });
    const dest = makeInstall('dest', BASE);
    transfer(source, dest, created.filename);
    const jsonCheck = await checkRestorePreconditions(created.filename, { paths: dest.paths });
    assert.equal(jsonCheck.code, 'payload-incompatible');
    assert.match(jsonCheck.error, /corrupted or unreadable/);

    writeJson(path.join(source.dataDir, 'coinbase', 'ETH-USDC', 'fill-ledger.json'), ledgerOf('t1'));
    writeJson(path.join(source.dataDir, 'coinbase', 'ETH-USDC', 'regime-state.json'), [1]);
    const second = await createBackup({ paths: source.paths });
    transfer(source, dest, second.filename);
    const stateCheck = await checkRestorePreconditions(second.filename, { paths: dest.paths });
    assert.equal(stateCheck.code, 'payload-incompatible');
    assert.match(stateCheck.error, /regime-state.json did not parse to an object/);
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
