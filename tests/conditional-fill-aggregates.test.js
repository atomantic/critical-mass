const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTransactionsReadView } = require('../src/transactions-regime-query');
const { registerRegimeIpcHandlers } = require('../src/ipc/regime-ipc-handlers');
const { IPC_CHANNELS } = require('../src/ipc/ipc-protocol');

test('conditional aggregate IPC checks the owner revision for running, changed and replaced ledgers', async () => {
  let rows = [];
  let revision = 'instance-one:0';
  let reads = 0;
  const view = createTransactionsReadView(() => { reads++; return rows; }, () => revision);
  const ledger = { getFillAggregates: input => view.aggregates(input) };
  const handlers = new Map();
  const engines = new Map([['fund', ledger]]);
  let standalone = ledger;
  registerRegimeIpcHandlers({ onRequest: (channel, handler) => handlers.set(channel, handler) }, {
    regimeEngines: engines, resolvePair: (_, pair) => pair, fundKey: () => 'fund',
    getStandaloneLedger: () => { if (standalone instanceof Error) throw standalone; return standalone; },
  });
  const read = input => handlers.get(IPC_CHANNELS.REGIME_FILLS_CYCLES)(input, 'coinbase', 'BTC-USD');
  assert.deepEqual(await read({ revision }), { running: true, unchanged: true, revision });
  assert.equal(reads, 0, 'matching revisions skip snapshot enrichment even before the first aggregate read');
  const initial = await read({});
  assert.equal(initial.fillCount, 0);
  assert.equal(initial.unchanged, undefined);
  assert.equal(reads, 1);
  assert.deepEqual(await read({ revision }), { running: true, unchanged: true, revision });
  rows = [{ side: 'buy', tradeId: 'new', orderId: 'new', size: 1, price: 100, quoteAmount: 100, timestamp: 1 }];
  revision = 'instance-one:1';
  const changed = await read({ revision: initial.revision });
  assert.equal(changed.fillCount, 1);
  assert.equal(changed.revision, revision);
  assert.equal(changed.unchanged, undefined);
  engines.delete('fund');
  assert.deepEqual(await read({ revision }), { running: false, unchanged: true, revision });
  standalone = { getFillAggregates: input => createTransactionsReadView(() => [], () => 'instance-two:0').aggregates(input) };
  const replaced = await read({ revision });
  assert.equal(replaced.fillCount, 0);
  assert.equal(replaced.revision, 'instance-two:0');
  assert.equal(replaced.unchanged, undefined);
  standalone = new Error('Corrupt ledger');
  assert.deepEqual(await read({ revision }), { running: false, success: false, error: 'Corrupt ledger' });
  for (const invalid of ['', [], {}, 'x'.repeat(101)]) {
    const result = await read({ revision: invalid });
    assert.equal(result.statusCode, 400);
    assert.equal(result.success, false);
  }
});
