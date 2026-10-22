const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAdjustmentHistory } = require('../src/adjustment-history');

test('push caps at max, dropping oldest', () => {
  const h = createAdjustmentHistory();
  for (let i = 0; i < 55; i++) h.push({ i });
  const all = h.export();
  assert.equal(all.length, 50);
  assert.equal(all[0].i, 5);
});

test('tail defaults to 10 most recent', () => {
  const h = createAdjustmentHistory();
  for (let i = 0; i < 20; i++) h.push({ i });
  assert.deepEqual(h.tail().map(e => e.i), [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  assert.equal(h.tail(3).length, 3);
});

test('import copies entries, ignores missing state; export is a copy; clear empties', () => {
  const h = createAdjustmentHistory();
  const saved = [{ a: 1 }];
  h.import(saved);
  saved[0].a = 2;
  assert.equal(h.export()[0].a, 1);
  h.import(undefined);
  assert.equal(h.export().length, 1);
  h.export().push({});
  assert.equal(h.export().length, 1);
  h.clear();
  assert.equal(h.export().length, 0);
});
