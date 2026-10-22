// @ts-check
// issue #1591 — placement-intents.json is mutated by the gateway and engine
// processes. Each mutation is load -> change -> rewrite, so without a
// cross-process lock concurrent writers lose each other's rows.

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const migration = require('../src/migration');
const stateTracker = require('../src/state-tracker');

const EXCHANGE = 'coinbase';
const PAIR = 'BTC-USDC';
const REPO_ROOT = path.join(__dirname, '..');

let tmpRoot;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'placement-intents-lock-'));
  mock.method(migration, 'getExchangeDataDir', () => path.join(tmpRoot, EXCHANGE));
});

afterEach(() => {
  mock.restoreAll();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// A child that records COUNT intents (tagged with its label) and resolves every
// second one, so records and resolves interleave with the other child's.
const CHILD = `
const path = require('path');
const migration = require(path.join(process.env.REPO_ROOT, 'src/migration'));
migration.getExchangeDataDir = () => path.join(process.env.TMP_ROOT, process.env.EXCHANGE);
const st = require(path.join(process.env.REPO_ROOT, 'src/state-tracker'));
for (let i = 0; i < Number(process.env.COUNT); i++) {
  const intent = st.recordPlacementIntent({ exchange: process.env.EXCHANGE, pair: process.env.PAIR, action: process.env.LABEL + '-' + i });
  if (i % 2 === 0) st.resolvePlacementIntent(process.env.EXCHANGE, process.env.PAIR, intent.id);
}
`;

const runChild = (label, count) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['-e', CHILD], {
    env: { ...process.env, REPO_ROOT, TMP_ROOT: tmpRoot, EXCHANGE, PAIR, LABEL: label, COUNT: String(count) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  child.on('close', code => (code === 0 ? resolve() : reject(new Error(`child ${label} exited ${code}: ${stderr}`))));
});

describe('placement intents cross-process lock', () => {
  it('two processes recording and resolving concurrently end with exactly the surviving rows', async () => {
    await Promise.all([runChild('a', 200), runChild('b', 200)]);

    const actions = stateTracker.loadPlacementIntents(EXCHANGE, PAIR).map(i => i.action).sort();
    const expected = ['a', 'b'].flatMap(l => Array.from({ length: 100 }, (_, n) => `${l}-${n * 2 + 1}`)).sort();
    assert.deepEqual(actions, expected);
    assert.equal(fs.existsSync(`${stateTracker.getPlacementIntentsFile(EXCHANGE, PAIR)}.lock`), false);
  });

  it('reclaims a lock left by a dead process', () => {
    const lock = `${stateTracker.getPlacementIntentsFile(EXCHANGE, PAIR)}.lock`;
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2 ** 22 - 1, host: os.hostname() }));
    const old = new Date(Date.now() - 5000);
    fs.utimesSync(lock, old, old);

    const intent = stateTracker.recordPlacementIntent({ exchange: EXCHANGE, pair: PAIR, action: 'x' });
    assert.equal(stateTracker.loadPlacementIntents(EXCHANGE, PAIR)[0].id, intent.id);
  });
});
