// @ts-check
/**
 * A committed restore drops its rollback copies, so the pre-restore archive is
 * the only way back from restoring the wrong archive. This drives the real
 * archive writer and applier in a temp data root and proves the recovery
 * archive restores the newer state the restore replaced.
 */
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { performRestore } = require('../src/restore-coordinator');
const { createBackup, restoreBackup } = require('../src/backup-service');

const logger = { info: () => {}, warn: () => {}, error: () => {} };
const roots = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

describe('pre-restore recovery archive', () => {
  it('undoes a restore of an older archive', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-restore-recovery-'));
    roots.push(root);
    const paths = { dataDir: path.join(root, 'data'), baseConfigFile: path.join(root, 'base.json') };
    const fundFile = path.join(paths.dataDir, 'coinbase', 'BTC-USDC', 'regime-state.json');
    fs.mkdirSync(path.dirname(fundFile), { recursive: true });
    fs.writeFileSync(paths.baseConfigFile, JSON.stringify({
      exchanges: { coinbase: { pairs: { 'BTC-USDC': { productId: 'BTC-USDC', enabled: true } } } },
    }));
    const generation = () => JSON.parse(fs.readFileSync(fundFile, 'utf8')).generation;

    fs.writeFileSync(fundFile, JSON.stringify({ generation: 'old' }));
    const older = await createBackup({ paths });
    assert.equal(older.success, true, older.error);
    fs.writeFileSync(fundFile, JSON.stringify({ generation: 'newer' }));

    const { status, body } = await performRestore({
      filename: older.filename,
      restore: (name) => restoreBackup(name, { paths, logger }),
      createRecoveryPoint: () => createBackup({ paths }),
      logger,
    });
    assert.equal(status, 200, body.error);
    assert.equal(generation(), 'old');
    assert.notEqual(body.recoveryPoint, older.filename);
    assert.ok(body.message.includes(body.recoveryPoint));

    assert.equal(restoreBackup(body.recoveryPoint, { paths, logger }).success, true);
    assert.equal(generation(), 'newer', 'restoring the recovery archive undoes the restore');
  });
});
