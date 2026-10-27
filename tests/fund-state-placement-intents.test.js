// @ts-check
// #1810 — hourly fund-state snapshots carry the durable placement intents, so a
// restored fund still refuses to place against an order whose POST outcome was
// never learned. Real intent storage and the real dispatch funnel are used; the
// only thing mocked is where fund data lives.
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const migration = require('../src/migration');
const stateTracker = require('../src/state-tracker');
const { placeWithUnknownReconcile } = require('../src/order-manager');
const {
  createFundStateBackup,
  listFundStateBackups,
  checkFundStateRestorePreconditions,
  restoreFundStateBackup,
} = require('../src/backup-service');

const EXCHANGE = 'coinbase';
const PAIR = 'BTC-USDC';

let root;
let dataDir;
let paths;
let fundDir;

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
};
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-fund-state-intents-'));
  dataDir = path.join(root, 'data');
  paths = { dataDir, baseConfigFile: path.join(root, 'config.json') };
  fundDir = path.join(dataDir, EXCHANGE, PAIR);
  mock.method(migration, 'getExchangeDataDir', (exchange) => path.join(dataDir, exchange));
  writeJson(paths.baseConfigFile, { exchanges: { [EXCHANGE]: { pairs: { [PAIR]: { productId: PAIR, enabled: true } } } } });
  writeJson(path.join(fundDir, 'fill-ledger.json'), { fills: [{ id: 'fill-1' }] });
});

afterEach(() => {
  mock.restoreAll();
  fs.rmSync(root, { recursive: true, force: true });
});

const unknownError = (clientOrderId) => Object.assign(new Error('socket hang up'), { status: 'unknown', unknownOutcome: true, clientOrderId });
const scope = { intent: { exchange: EXCHANGE, pair: PAIR, action: 'entry_bid', side: 'buy', price: 100, size: 0.5, sizeUsdc: 50 } };

/** Leaves one unresolved intent on disk the way a real ambiguous POST does. */
const leaveUnresolvedIntent = async () => {
  await placeWithUnknownReconcile({ name: EXCHANGE }, PAIR, async () => { throw unknownError('coid-1'); }, scope);
  const [intent] = stateTracker.loadPlacementIntents(EXCHANGE, PAIR);
  assert.equal(intent.status, stateTracker.PLACEMENT_INTENT_STATUS.UNRESOLVED);
  return intent;
};

const snapshot = (now = '2026-10-27T00:00:00.000Z') => {
  const result = createFundStateBackup({ paths, now: new Date(now) });
  assert.equal(result.success, true, JSON.stringify(result));
  return result;
};

const attemptPlacement = async () => {
  let submitted = 0;
  const result = await placeWithUnknownReconcile({ name: EXCHANGE }, PAIR, async () => {
    submitted++;
    return { success: true, orderId: 'new-order' };
  }, scope);
  return { submitted, result };
};

describe('fund-state snapshots preserve placement intents (#1810)', () => {
  it('restores an unresolved intent after fund-directory loss and the dispatch funnel stays closed', async () => {
    const intent = await leaveUnresolvedIntent();
    const backup = snapshot();
    assert.ok(backup.funds[0].files.includes('placement-intents.json'));
    assert.equal(listFundStateBackups({ paths })[0].placementIntentsCaptured, true);

    fs.rmSync(fundDir, { recursive: true, force: true });
    assert.equal(stateTracker.getBlockingPlacementIntents(EXCHANGE, PAIR).length, 0, 'precondition: the safety record is gone');

    const restored = restoreFundStateBackup(backup.snapshotId, EXCHANGE, PAIR, { paths });
    assert.equal(restored.success, true, JSON.stringify(restored));

    const blockers = stateTracker.getBlockingPlacementIntents(EXCHANGE, PAIR);
    assert.equal(blockers.length, 1);
    assert.equal(blockers[0].id, intent.id);
    assert.equal(blockers[0].clientOrderId, 'coid-1');
    assert.equal(blockers[0].action, 'entry_bid');
    assert.equal(blockers[0].instanceId, intent.instanceId);

    const blocked = await attemptPlacement();
    assert.equal(blocked.submitted, 0);
    assert.equal(blocked.result.pending, true);
    assert.equal(blocked.result.blockedByIntentId, intent.id);

    stateTracker.resolvePlacementIntent(EXCHANGE, PAIR, intent.id);
    assert.equal((await attemptPlacement()).submitted, 1, 'normal reconciliation reopens placement');
  });

  it('keeps a crash-leftover dispatching intent blocking for a cold process', async () => {
    writeJson(path.join(fundDir, 'placement-intents.json'), { version: 1, intents: [{
      id: 'dead-1', instanceId: 'dead-process', status: 'dispatching', exchange: EXCHANGE, pair: PAIR, action: 'take_profit', clientOrderId: null, createdAt: 1, updatedAt: 1,
    }] });
    const backup = snapshot();
    fs.rmSync(fundDir, { recursive: true, force: true });
    assert.equal(restoreFundStateBackup(backup.snapshotId, EXCHANGE, PAIR, { paths }).success, true);
    assert.deepEqual(stateTracker.getBlockingPlacementIntents(EXCHANGE, PAIR).map((i) => i.id), ['dead-1']);
  });

  it('never captures or restores placement ownership locks or reclaim artifacts', async () => {
    await leaveUnresolvedIntent();
    for (const name of ['placement-intents.json.lock', 'placement-intents.json.lock.reclaim', 'placement-intents.json.lock.new-1-abc']) {
      fs.mkdirSync(path.join(fundDir, name), { recursive: true });
      writeJson(path.join(fundDir, name, 'owner.json'), { pid: 1 });
    }
    const backup = snapshot();
    assert.deepEqual(backup.funds[0].files.filter((name) => name.includes('.lock')), []);
    const snapshotFund = path.join(dataDir, 'backups', 'fund-state', backup.snapshotId, EXCHANGE, PAIR);
    assert.deepEqual(fs.readdirSync(snapshotFund).filter((name) => name.includes('.lock')), []);

    fs.rmSync(fundDir, { recursive: true, force: true });
    assert.equal(restoreFundStateBackup(backup.snapshotId, EXCHANGE, PAIR, { paths }).success, true);
    assert.deepEqual(fs.readdirSync(fundDir).filter((name) => name.includes('.lock')), []);
  });

  it('adds snapshot intents to destination intents without clearing either side', async () => {
    const original = await leaveUnresolvedIntent();
    const backup = snapshot();
    stateTracker.resolvePlacementIntent(EXCHANGE, PAIR, original.id);
    await placeWithUnknownReconcile({ name: EXCHANGE }, PAIR, async () => { throw unknownError('coid-2'); }, scope);
    const newer = stateTracker.loadPlacementIntents(EXCHANGE, PAIR)[0];

    assert.equal(restoreFundStateBackup(backup.snapshotId, EXCHANGE, PAIR, { paths }).success, true);
    assert.deepEqual(stateTracker.loadPlacementIntents(EXCHANGE, PAIR).map((i) => i.id).sort(), [original.id, newer.id].sort());
  });

  it('does not clear destination blockers when the snapshot holds no intents file', async () => {
    const backup = snapshot();
    assert.equal(backup.funds[0].files.includes('placement-intents.json'), false);
    const intent = await leaveUnresolvedIntent();

    assert.equal(restoreFundStateBackup(backup.snapshotId, EXCHANGE, PAIR, { paths }).success, true);
    assert.deepEqual(stateTracker.getBlockingPlacementIntents(EXCHANGE, PAIR).map((i) => i.id), [intent.id]);
  });

  describe('legacy snapshots without intent capture', () => {
    const makeLegacy = () => {
      const backup = snapshot();
      const manifestFile = path.join(dataDir, 'backups', 'fund-state', backup.snapshotId, 'fund-state-manifest.json');
      const manifest = readJson(manifestFile);
      delete manifest.placementIntentsCaptured;
      writeJson(manifestFile, manifest);
      return backup;
    };

    it('is marked and refused before any engine stops, unless explicitly accepted', () => {
      const backup = makeLegacy();
      assert.equal(listFundStateBackups({ paths })[0].placementIntentsCaptured, false);

      const preflight = checkFundStateRestorePreconditions(backup.snapshotId, EXCHANGE, PAIR, { paths });
      assert.equal(preflight.ok, false);
      assert.equal(preflight.code, 'placement-intents-not-captured');
      assert.equal(checkFundStateRestorePreconditions(backup.snapshotId, EXCHANGE, PAIR, { paths, acceptMissingPlacementIntents: true }).ok, true);

      fs.rmSync(fundDir, { recursive: true, force: true });
      const refused = restoreFundStateBackup(backup.snapshotId, EXCHANGE, PAIR, { paths });
      assert.equal(refused.success, false);
      assert.equal(refused.code, 'placement-intents-not-captured');
      assert.equal(fs.existsSync(fundDir), false, 'a refused restore changes nothing');
    });

    it('restores accounting on acknowledgement, warns, and keeps the destination blockers', async () => {
      const backup = makeLegacy();
      const intent = await leaveUnresolvedIntent();

      const restored = restoreFundStateBackup(backup.snapshotId, EXCHANGE, PAIR, { paths, acceptMissingPlacementIntents: true });
      assert.equal(restored.success, true, JSON.stringify(restored));
      assert.match(restored.warnings?.[0] ?? '', /NOT recovered/);
      assert.deepEqual(readJson(path.join(fundDir, 'fill-ledger.json')), { fills: [{ id: 'fill-1' }] });
      assert.deepEqual(stateTracker.getBlockingPlacementIntents(EXCHANGE, PAIR).map((i) => i.id), [intent.id]);
    });
  });

  it('rejects a snapshot whose intents file is not a valid envelope', async () => {
    await leaveUnresolvedIntent();
    const backup = snapshot();
    const file = path.join(dataDir, 'backups', 'fund-state', backup.snapshotId, EXCHANGE, PAIR, 'placement-intents.json');
    writeJson(file, { intents: [{ status: 'unresolved' }] });
    assert.equal(listFundStateBackups({ paths }).length, 0, 'a snapshot with a malformed row is not a usable recovery point');
    const result = restoreFundStateBackup(backup.snapshotId, EXCHANGE, PAIR, { paths });
    assert.equal(result.success, false);
    assert.match(result.error, /malformed row/);
  });

  it('refuses to snapshot a corrupt live intents file instead of recording it as empty', async () => {
    fs.writeFileSync(path.join(fundDir, 'placement-intents.json'), '{not json');
    const result = createFundStateBackup({ paths, now: new Date('2026-10-27T01:00:00.000Z') });
    assert.equal(result.success, false);
    assert.match(result.error, /corrupted or unreadable/);
  });

  it('rolls intents and accounting back together when the restore fails midway', async () => {
    const original = await leaveUnresolvedIntent();
    const backup = snapshot();
    writeJson(path.join(fundDir, 'fill-ledger.json'), { fills: ['live-newer'] });
    writeJson(path.join(fundDir, 'regime-state.json'), { live: true });
    stateTracker.resolvePlacementIntent(EXCHANGE, PAIR, original.id);
    const liveBefore = Object.fromEntries(fs.readdirSync(fundDir).map((name) => [name, fs.readFileSync(path.join(fundDir, name), 'utf8')]));
    const otherFund = path.join(dataDir, EXCHANGE, 'ETH-USDC');
    writeJson(path.join(otherFund, 'fill-ledger.json'), { fills: ['other'] });

    // Fail the last staged replacement, after the intents file has already been swapped in.
    const rename = fs.renameSync;
    mock.method(fs, 'renameSync', (from, to) => {
      if (String(to) === path.join(fundDir, 'fill-ledger.json') && String(from).includes('.restore-')) throw new Error('disk full');
      return rename(from, to);
    });
    const result = restoreFundStateBackup(backup.snapshotId, EXCHANGE, PAIR, { paths });
    mock.restoreAll();
    mock.method(migration, 'getExchangeDataDir', (exchange) => path.join(dataDir, exchange));

    assert.equal(result.success, false, JSON.stringify(result));
    assert.deepEqual(Object.fromEntries(fs.readdirSync(fundDir).map((name) => [name, fs.readFileSync(path.join(fundDir, name), 'utf8')])), liveBefore);
    assert.deepEqual(stateTracker.loadPlacementIntents(EXCHANGE, PAIR), []);
    assert.deepEqual(readJson(path.join(otherFund, 'fill-ledger.json')), { fills: ['other'] });
  });
});
