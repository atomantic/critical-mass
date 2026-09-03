// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { placeWithUnknownReconcile } = require('../src/order-manager');

// ---------------------------------------------------------------------------
// #253 — core trading modules log through the canonical context logger, so
// every operator-visible line keeps its original text AND carries structured
// exchange / pair / order / error context for centralized sinks.
// ---------------------------------------------------------------------------

/** Split a rendered log line into its message and its trailing JSON context. */
const contextFor = (lines, prefix) => {
  const line = lines.find(candidate => candidate.startsWith(prefix));
  assert.ok(line, `missing log line starting with: ${prefix}`);
  const contextStart = line.lastIndexOf(' {');
  assert.notEqual(contextStart, -1, `missing structured context: ${line}`);
  return {
    context: JSON.parse(line.slice(contextStart + 1)),
    message: line.slice(0, contextStart),
  };
};

/** Capture everything the logger writes while `run` executes. */
const captureLogs = async (run) => {
  const lines = [];
  const originalLog = console.log;
  console.log = line => lines.push(line);
  try {
    return { result: await run(), lines };
  } finally {
    console.log = originalLog;
  }
};

/** An ambiguous order-POST outcome, exactly as the coinbase adapter throws it. */
const unknownError = (clientOrderId = 'coid-abc') =>
  Object.assign(new Error('unknown order outcome — reconcile by client_order_id'), {
    status: 'unknown',
    unknownOutcome: true,
    clientOrderId,
  });

describe('core trading module structured logging', () => {
  it('keeps core trading modules on the canonical context logger', () => {
    for (const relativePath of [
      '../src/order-manager.js',
      '../src/dca-engine.js',
      '../engines/coinbase-engine.js',
    ]) {
      const source = fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
      assert.doesNotMatch(source, /\bconsole\.(?:log|warn|error)\b/, relativePath);
      // The log(level, message) helper carries no structured context, in either
      // its bare `log('WARN', …)` or module-qualified `logger.log('WARN', …)`
      // form — these modules must route through createContextLogger instead.
      assert.doesNotMatch(source, /log\('(?:INFO|WARN|ERROR)'/, relativePath);
      assert.match(source, /createContextLogger\(/, relativePath);
    }
  });

  it('adds exchange, pair, order and error context to a reconciled placement', async () => {
    const adapter = {
      name: 'coinbase',
      findOrderByClientOrderId: async () => ({ orderId: 'real-1', status: 'OPEN' }),
    };

    const { result, lines } = await captureLogs(() => placeWithUnknownReconcile(
      adapter,
      'BTC-USDC',
      async () => { throw unknownError('coid-1'); },
      [],
    ));

    assert.equal(result.orderId, 'real-1');

    // The warning that opens the reconcile keeps its text and names the exchange.
    const warn = contextFor(lines, '⚠️ Unknown order outcome — reconciling by client_order_id coid-1');
    assert.deepStrictEqual(warn.context, {
      module: 'order-manager',
      exchange: 'coinbase',
      pair: 'BTC-USDC',
      clientOrderId: 'coid-1',
      error: 'unknown order outcome — reconcile by client_order_id',
    });

    // The adoption keeps its original text and carries the adopted order id.
    const info = contextFor(lines, 'ℹ️ ✅ Reconciled unknown placement');
    assert.equal(
      info.message,
      'ℹ️ ✅ Reconciled unknown placement — adopting exchange order real-1 (status OPEN)',
    );
    assert.deepStrictEqual(info.context, {
      module: 'order-manager',
      exchange: 'coinbase',
      pair: 'BTC-USDC',
      orderId: 'real-1',
      clientOrderId: 'coid-1',
      status: 'OPEN',
      reconciled: true,
    });
  });

  it('reports an unreconcilable order failure with the error attached', async () => {
    // No findOrderByClientOrderId → the placement cannot be reconciled at all.
    const adapter = { name: 'gemini' };

    const { result, lines } = await captureLogs(() => placeWithUnknownReconcile(
      adapter,
      'ETHUSD',
      async () => { throw unknownError('coid-2'); },
      [],
    ));

    assert.equal(result.success, false);

    const { context, message } = contextFor(lines, '❌ Unknown order outcome and cannot reconcile');
    assert.equal(
      message,
      '❌ Unknown order outcome and cannot reconcile (clientOrderId=coid-2) — treating as failed',
    );
    assert.deepStrictEqual(context, {
      module: 'order-manager',
      exchange: 'gemini',
      pair: 'ETHUSD',
      clientOrderId: 'coid-2',
      reconcilable: false,
      error: 'unknown order outcome — reconcile by client_order_id',
    });
  });

  it('marks a placement that never landed as safe to re-place, with lookup status', async () => {
    const adapter = {
      name: 'cryptocom',
      findOrderByClientOrderId: async () => null,
    };

    const { result, lines } = await captureLogs(() => placeWithUnknownReconcile(
      adapter,
      'CRO_USD',
      async () => { throw unknownError('coid-3'); },
      [],
    ));

    assert.equal(result.success, false);

    const { context } = contextFor(lines, '❌ Unknown placement not found live on exchange');
    assert.deepStrictEqual(context, {
      module: 'order-manager',
      exchange: 'cryptocom',
      pair: 'CRO_USD',
      clientOrderId: 'coid-3',
      status: 'absent',
      error: 'unknown order outcome — reconcile by client_order_id',
    });
  });
});
