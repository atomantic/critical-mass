const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { APP_ROOT } = require('../src/paths');
const { atomicWriteSync } = require('../src/state-tracker');
const { JOURNAL_FILENAME, runBackfill, hash, withStoppedWriters } = require('../src/fifo-backfill-transaction');
const { findFunds, stageFund } = require('../scripts/backfill-fifo-realized');
const { guardIncompleteRestore } = require('../src/restore-apply');

const fixture = (t) => {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fifo-backfill-test-')));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const funds = ['AAA-USD', 'BBB-USD'].map((pair) => {
    const dir = path.join(dataDir, 'coinbase', pair);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'regime-state.json');
    const before = JSON.stringify({ position: { realizedPnL: 0, realizedAssetPnL: 0, totalAsset: 0 }, untouched: pair });
    fs.writeFileSync(file, before);
    fs.writeFileSync(path.join(dir, 'fill-ledger.json'), JSON.stringify([
      { side: 'buy', size: 2, quoteAmount: 20, timestamp: 1 },
      { side: 'sell', size: 1, quoteAmount: 15, timestamp: 2 },
    ]));
    return { file, before };
  });
  const stage = () => findFunds(dataDir).map((fund) => stageFund(fund, () => {}));
  return { dataDir, funds, stage };
};

const interruptSecondFund = (second, failure = 'before') => (file, bytes) => {
  if (file === second) {
    if (failure === 'after') atomicWriteSync(file, bytes);
    throw new Error('simulated interruption');
  }
  atomicWriteSync(file, bytes);
};

test('stages the entire cohort and commits verified atomic JSON with an audit journal', (t) => {
  const { dataDir, funds, stage } = fixture(t);
  assert.deepEqual(runBackfill({ dataDir, stage }), { status: 'committed', count: 2 });
  for (const { file } of funds) {
    assert.equal(JSON.parse(fs.readFileSync(file)).position.realizedPnL, 5);
    assert.equal(JSON.parse(fs.readFileSync(file)).position.realizedAssetPnL, 1);
    assert.ok(!fs.readdirSync(path.dirname(file)).some((name) => name.endsWith('.tmp')));
  }
  assert.equal(fs.existsSync(path.join(dataDir, JOURNAL_FILENAME)), false);
  const archiveDir = path.join(dataDir, '.fifo-backfill-history');
  const journal = JSON.parse(fs.readFileSync(path.join(archiveDir, fs.readdirSync(archiveDir)[0])));
  assert.ok(journal.entries.every((entry) => entry.status === 'committed' && hash(entry.before) === entry.beforeHash && hash(entry.after) === entry.afterHash));
});

test('a malformed later fund aborts staging without changing an earlier fund', (t) => {
  const { dataDir, funds, stage } = fixture(t);
  fs.writeFileSync(funds[1].file, '{broken');
  assert.throws(() => runBackfill({ dataDir, stage }));
  assert.equal(fs.readFileSync(funds[0].file, 'utf8'), funds[0].before);
  assert.equal(fs.readFileSync(funds[1].file, 'utf8'), '{broken');
  assert.equal(fs.existsSync(path.join(dataDir, JOURNAL_FILENAME)), false);
});

test('interruption preserves original bytes and per-fund status, then resumes without replacing a committed fund', (t) => {
  const { dataDir, funds, stage } = fixture(t);
  assert.throws(() => runBackfill({ dataDir, stage, write: interruptSecondFund(funds[1].file) }), /simulated interruption/);
  const journal = JSON.parse(fs.readFileSync(path.join(dataDir, JOURNAL_FILENAME)));
  assert.deepEqual(journal.entries.map((entry) => entry.status), ['committed', 'pending']);
  assert.equal(fs.readFileSync(funds[1].file, 'utf8'), funds[1].before);
  const writes = [];
  runBackfill({ dataDir, mode: 'resume', write: (file, bytes) => { writes.push(file); atomicWriteSync(file, bytes); } });
  assert.equal(writes.filter((file) => file === funds[0].file).length, 0);
  assert.equal(writes.filter((file) => file === funds[1].file).length, 1);
});

test('a crash between target rename and journal update is recovered by its after hash', (t) => {
  const { dataDir, funds, stage } = fixture(t);
  assert.throws(() => runBackfill({ dataDir, stage, write: interruptSecondFund(funds[1].file, 'after') }));
  const writes = [];
  runBackfill({ dataDir, mode: 'resume', write: (file, bytes) => { writes.push(file); atomicWriteSync(file, bytes); } });
  assert.ok(funds.every(({ file }) => !writes.includes(file)));
});

test('explicit rollback restores exact original bytes after an earlier commit', (t) => {
  const { dataDir, funds, stage } = fixture(t);
  assert.throws(() => runBackfill({ dataDir, stage, write: interruptSecondFund(funds[1].file) }));
  assert.deepEqual(runBackfill({ dataDir, mode: 'rollback' }), { status: 'rolled-back', count: 2 });
  for (const fund of funds) assert.equal(fs.readFileSync(fund.file, 'utf8'), fund.before);
});

test('recovery refuses unexpected live bytes and retains its journal', (t) => {
  const { dataDir, funds, stage } = fixture(t);
  assert.throws(() => runBackfill({ dataDir, stage, write: interruptSecondFund(funds[1].file) }));
  fs.writeFileSync(funds[1].file, JSON.stringify({ position: { operatorChange: true } }));
  assert.throws(() => runBackfill({ dataDir, mode: 'resume' }), /changed outside/);
  assert.ok(fs.existsSync(path.join(dataDir, JOURNAL_FILENAME)));
});

test('atomic writer rename failure leaves valid old JSON and no orphan temp file', (t) => {
  const { funds } = fixture(t);
  const original = fs.renameSync;
  fs.renameSync = () => { throw new Error('rename refused'); };
  try {
    assert.throws(() => atomicWriteSync(funds[0].file, '{"position":{}}'), /rename refused/);
  } finally { fs.renameSync = original; }
  assert.equal(fs.readFileSync(funds[0].file, 'utf8'), funds[0].before);
  assert.ok(!fs.readdirSync(path.dirname(funds[0].file)).some((name) => name.endsWith('.tmp')));
});

const stopped = (name) => ({ name, pid: 0, pm2_env: { pm_cwd: APP_ROOT, status: 'stopped' } });
const ipc = (stopAck) => ({
  connect: () => {}, disconnect: () => {}, isConnected: () => true,
  request: async (channel, payload) => channel === 'engine:maintenance'
    ? { success: true, maintenance: payload.active ? { expiresAt: Date.now() + 60 * 60_000 } : null }
    : stopAck,
});

test('writer refusal and malformed shutdown acknowledgement never invoke staging', async () => {
  let called = false;
  const operation = () => { called = true; };
  await assert.rejects(withStoppedWriters(operation, { processes: [], configuredExchanges: [] }), /Gateway/);
  for (const stopAck of [{ success: false, stopped: [] }, { success: true }, { success: true, stopped: [], failed: ['fund'] }]) {
    await assert.rejects(withStoppedWriters(operation, {
      processes: [stopped('critical-mass')], configuredExchanges: ['coinbase'], createClient: () => ipc(stopAck),
    }), /Cannot confirm/);
  }
  assert.equal(called, false);
});

test('writer gate accepts only confirmed maintenance plus shutdown, or stopped PM2 engines', async () => {
  const params = { processes: [stopped('critical-mass')], configuredExchanges: ['coinbase'], createClient: () => ipc({ success: true, stopped: [] }) };
  assert.equal(await withStoppedWriters((assertStopped) => { assertStopped(); return 42; }, params), 42);
  assert.equal(await withStoppedWriters((assertStopped) => { assertStopped(); return 43; }, {
    ...params, processes: [stopped('critical-mass'), stopped('critical-mass-coinbase')], createClient: () => { throw new Error('must not connect'); },
  }), 43);
});

test('startup refuses a pending cohort before any restore recovery or trading state load', (t) => {
  const { dataDir, funds, stage } = fixture(t);
  assert.throws(() => runBackfill({ dataDir, stage, write: interruptSecondFund(funds[1].file) }));
  const exits = [];
  const result = guardIncompleteRestore({ dataDir, processLabel: 'test engine', logger: { error: () => {} }, exit: (code) => exits.push(code) });
  assert.equal(result.blocked, true);
  assert.deepEqual(exits, [1]);
});


test('maintenance acknowledgement failure never invokes the cohort operation', async () => {
  let called = false;
  await assert.rejects(withStoppedWriters(() => { called = true; }, {
    processes: [stopped('critical-mass')], configuredExchanges: ['coinbase'],
    createClient: () => ({ ...ipc({ success: true, stopped: [] }), request: async () => ({ success: true }) }),
  }), /No maintenance acknowledgement/);
  assert.equal(called, false);
});

test('an interrupted staging marker cannot report a successfully resumed empty cohort', (t) => {
  const { dataDir } = fixture(t);
  fs.writeFileSync(path.join(dataDir, JOURNAL_FILENAME), JSON.stringify({ version: 1, id: '00000000-0000-0000-0000-000000000000', status: 'staging', entries: [] }));
  assert.throws(() => runBackfill({ dataDir, mode: 'resume' }), /Staging was interrupted/);
  assert.equal(runBackfill({ dataDir, mode: 'rollback' }).status, 'rolled-back');
});

test('a live repair lock refuses a competing repair before staging', (t) => {
  const { dataDir } = fixture(t);
  fs.mkdirSync(path.join(dataDir, `.fifo-backfill-lock-${process.pid}-another-owner`));
  assert.throws(() => runBackfill({ dataDir, stage: () => { throw new Error('must not stage'); } }), /Another backfill process/);
});
