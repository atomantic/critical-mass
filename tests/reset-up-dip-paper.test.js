const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resetUpDipPaper, gatewayState } = require('../scripts/reset-up-dip-paper');
const { createUpDipPaper } = require('../src/updown/up-dip-paper');

const NOW = Date.parse('2026-11-24T10:00:00.000Z');
const CONTRACT = { floor: 60600, ceiling: 62600, range: 2000, maxPayout: 1000, expiry: NOW + 86_400_000, expiryDate: '2026-11-28' };
const OLD = {
  position: { contract: CONTRACT, contracts: 1, cost: 790.955, lastFillPrice: 62177.93, entryPrice: 62177.93, openedAt: NOW - 1000 },
  pending: null, lastBarTs: NOW - 60_000, cycles: Array.from({ length: 14 }, () => ({ pnl: 51.04 })), events: [], startedAt: 1,
  latest: { at: NOW - 30_000, features: { price: 61130.84 } }, totals: { cycles: 14, wins: 14, losses: 0, pnl: 714.55, worst: 25.36 }, gaps: 0,
};

let dir, statePath, shadowPath, archiveDir;
const run = (over = {}) => resetUpDipPaper({ statePath, archiveDir, apply: true, now: NOW, gatewayOnline: false, ...over });
const archives = () => (fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir) : []);
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'up-dip-reset-'));
  statePath = path.join(dir, 'up-dip-paper.json');
  shadowPath = path.join(dir, 'up-dip-paper-shadow.json');
  archiveDir = path.join(dir, 'archive');
  fs.writeFileSync(statePath, JSON.stringify(OLD));
  fs.writeFileSync(shadowPath, JSON.stringify({ cycles: [] }));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('reset-up-dip-paper', () => {
  it('summarizes without writing by default', () => {
    const before = fs.readFileSync(statePath, 'utf8');
    const r = run({ apply: false, gatewayOnline: true });
    assert.equal(r.applied, false);
    assert.equal(fs.readFileSync(statePath, 'utf8'), before);
    assert.deepEqual(archives(), []);
    assert.equal(r.summary.closedCycles, 14);
  });

  for (const online of [true, null]) {
    it(`refuses to apply while the gateway is ${online === null ? 'in an unknown state' : 'online'}`, () => {
      assert.throws(() => run({ gatewayOnline: online }), /gateway/i);
      assert.deepEqual(archives(), []);
    });
  }

  it('archives the whole book with its open loss, then writes an empty stamped one', () => {
    const r = run();
    assert.equal(r.applied, true);
    const saved = JSON.parse(fs.readFileSync(r.archivePath, 'utf8'));
    assert.deepEqual(saved.state, OLD);
    assert.deepEqual(saved.summary, {
      book: 'up-dip-paper', archivedAt: NOW, pricing: null, closedCycles: 14, wins: 14, pnl: 714.55,
      openPosition: { contract: CONTRACT, contracts: 1, cost: 790.96, markBtc: 61130.84, pnl: -527.53, markedAt: NOW - 30_000 },
    });
    assert.equal(path.basename(r.archivePath), 'up-dip-paper-2026-11-24T10-00-00-000Z.json');
    assert.equal(fs.statSync(r.archivePath).mode & 0o777, 0o600);
    const fresh = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.deepEqual([fresh.position, fresh.cycles, fresh.pricing], [null, [], { spread: true, source: 'cryptocom-index' }]);
  });

  it('leaves a book the tracker will trade, showing the archive', () => {
    run();
    const paper = createUpDipPaper({ getCandles: () => [], getHalfSpread: () => 35, statePath, archiveDir, writeJSON: () => {} });
    const s = paper.getStatus();
    assert.equal(s.needsReset, false);
    assert.equal(s.summary.cycles, 0);
    assert.equal(s.archived.pnl, 714.55);
    assert.equal(s.archived.openPosition.pnl, -527.53);
  });

  it('reports a book with nothing open', () => {
    fs.writeFileSync(statePath, JSON.stringify({ ...OLD, position: null }));
    assert.equal(run().summary.openPosition, null);
  });

  it('marks a stamped book at its own spread', () => {
    fs.writeFileSync(statePath, JSON.stringify({ ...OLD, pricing: { spread: true, source: 'cryptocom-index' }, position: { ...OLD.position, halfSpread: 49 } }));
    assert.equal(run().summary.openPosition.pnl, -552.03);
  });

  it('says so when there is no price to mark with', () => {
    fs.writeFileSync(statePath, JSON.stringify({ ...OLD, latest: null }));
    const { openPosition } = run().summary;
    assert.deepEqual([openPosition.markBtc, openPosition.pnl, openPosition.markedAt], [null, null, null]);
  });

  it('keeps the raw bytes of an unreadable book', () => {
    fs.writeFileSync(statePath, '{half a fi');
    const r = run();
    const saved = JSON.parse(fs.readFileSync(r.archivePath, 'utf8'));
    assert.equal(saved.raw, '{half a fi');
    assert.equal(saved.summary.unreadable, true);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).pricing.spread, true);
  });

  it('refuses when there is no book', () => {
    fs.rmSync(statePath);
    assert.throws(() => run(), /no book/i);
  });

  it('never overwrites an archive, and keeps the book when archiving fails', () => {
    run();
    fs.writeFileSync(statePath, JSON.stringify(OLD));
    assert.throws(() => run());
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), OLD);
    assert.equal(archives().length, 1);
  });

  it('touches only the book it was given', () => {
    const main = fs.readFileSync(statePath, 'utf8');
    const r = run({ statePath: shadowPath });
    assert.equal(fs.readFileSync(statePath, 'utf8'), main);
    assert.match(path.basename(r.archivePath), /^up-dip-paper-shadow-2026/);
  });
});

describe('gatewayState', () => {
  const pm2 = (status) => () => JSON.stringify([{ name: 'critical-mass', pm2_env: { status } }]);
  it('is online unless PM2 says it is stopped', () => {
    for (const status of ['online', 'launching', 'stopping']) assert.equal(gatewayState(pm2(status)), true);
    for (const status of ['stopped', 'errored']) assert.equal(gatewayState(pm2(status)), false);
  });
  it('is unknown when PM2 cannot be asked or does not list it', () => {
    assert.equal(gatewayState(() => { throw new Error('ENOENT'); }), null);
    assert.equal(gatewayState(() => 'garbage'), null);
    assert.equal(gatewayState(() => '[]'), null);
  });
});
