// @ts-check
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tryOwnerDirectoryLock, waitForLock } = require('../src/file-lock');

const fixture = (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-file-lock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'lock');
};

it('preserves an ownerless lock when its policy requires readable ownership', (t) => {
  const lock = fixture(t);
  fs.mkdirSync(lock);

  assert.equal(tryOwnerDirectoryLock(lock, {}), null);
  assert.deepEqual(fs.readdirSync(lock), []);
});

it('keeps an owner that is unreachable with EPERM or belongs to another host', (t) => {
  const lock = fixture(t);
  const ownerPath = path.join(lock, 'owner.json');
  fs.mkdirSync(lock);
  const probe = t.mock.method(process, 'kill', () => {
    throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
  });

  fs.writeFileSync(ownerPath, JSON.stringify({ pid: 123, host: 'other-host' }));
  assert.equal(tryOwnerDirectoryLock(lock, { ownerlessMs: 1 }), null);
  assert.equal(probe.mock.callCount(), 0);

  fs.writeFileSync(ownerPath, JSON.stringify({ pid: 123, host: os.hostname() }));
  assert.equal(tryOwnerDirectoryLock(lock, { ownerlessMs: 1 }), null);
  assert.equal(probe.mock.callCount(), 1);
});

it('does not release a subsequent owner when a release is called twice', (t) => {
  const lock = fixture(t);
  const release = tryOwnerDirectoryLock(lock, { ownerlessMs: 30_000 });
  assert.ok(release);
  release();

  const releaseSuccessor = tryOwnerDirectoryLock(lock, {
    ownerlessMs: 30_000,
    metadata: { purpose: 'successor' },
  });
  assert.ok(releaseSuccessor);
  release();
  assert.equal(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')).purpose, 'successor');
  releaseSuccessor();
  assert.equal(fs.existsSync(lock), false);
});

it('bounds synchronous polling by the remaining wait time', () => {
  let now = 0;
  const intervals = [];
  const result = waitForLock(() => null, {
    waitMs: 8,
    pollMs: 5,
    now: () => now,
    sleep: (ms) => { intervals.push(ms); now += ms; },
  });

  assert.equal(result, null);
  assert.deepEqual(intervals, [5, 3]);
});
