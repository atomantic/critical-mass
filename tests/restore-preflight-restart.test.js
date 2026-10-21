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
const {
  createBackup,
  restoreBackup,
  checkRestorePreconditions,
  checkFundStateRestorePreconditions,
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

  it('checks a fund-state snapshot without staging it', () => {
    const install = makeInstall('dest', BASE);
    const missing = checkFundStateRestorePreconditions('20260101T000000Z', 'coinbase', 'ETH-USDC', { paths: install.paths });
    assert.deepEqual(missing, { ok: false, error: 'Fund-state snapshot not found' });
    assert.equal(checkFundStateRestorePreconditions('../x', 'coinbase', 'ETH-USDC', { paths: install.paths }).ok, false);
  });
});
