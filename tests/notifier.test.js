// @ts-check
/**
 * Coverage for the Telegram notification pipeline (issue #426):
 * shouldSendEvent/isQuietHours gating order, enqueue/flushQueue batching,
 * sendTelegram error handling, stop()'s flush-then-unsubscribe contract,
 * scheduleDailySummary's delay computation, and updateConfig's reschedule.
 *
 * No real network calls: `fetch` is stubbed throughout. No writes to the
 * repo's real data/ files: config is served from mocked `fs`.
 */
const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const configUtils = require('../src/config-utils');
const { tradeEvents } = require('../src/trade-events');
const {
  createNotifier,
  escapeTelegramMarkdown,
  formatFundSummaryLines,
  isQuietHours,
  shouldSendEvent,
  computeDailySummaryDelay,
  CRITICAL_EVENTS,
} = require('../src/notifier');

// issue #397 — Telegram's legacy Markdown parse_mode rejects unescaped
// reserved characters with an HTTP 400 "can't parse entities" error, which
// silently drops delivery of the entire message (not just the offending
// character). Trade event messages built by regime-engine/risk-manager are
// plain text (e.g. "[DRY-RUN]", "usdc_cap_exceeded"), not intentional
// markdown, so they must be escaped before being sent.
describe('escapeTelegramMarkdown (issue #397)', () => {
  it('escapes square brackets used for tags like [DRY-RUN]', () => {
    assert.equal(escapeTelegramMarkdown('[DRY-RUN] 0.001 BTC @ $50000'), '\\[DRY-RUN\\] 0.001 BTC @ $50000');
  });

  it('escapes brackets used for merge/partial-fill annotations', () => {
    assert.equal(escapeTelegramMarkdown('0.5 BTC @ $50000 [merged→giant]'), '0.5 BTC @ $50000 \\[merged→giant\\]');
    assert.equal(escapeTelegramMarkdown('PnL=$1.23 [PARTIAL]'), 'PnL=$1.23 \\[PARTIAL\\]');
    assert.equal(escapeTelegramMarkdown('PnL=$1.23 [merge-snapshot]'), 'PnL=$1.23 \\[merge-snapshot\\]');
  });

  it('escapes underscores in identifiers like usdc_cap_exceeded', () => {
    assert.equal(escapeTelegramMarkdown('Risk limit triggered: usdc_cap_exceeded'), 'Risk limit triggered: usdc\\_cap\\_exceeded');
  });

  it('escapes asterisks and backticks', () => {
    assert.equal(escapeTelegramMarkdown('50% *bonus* applied `now`'), '50% \\*bonus\\* applied \\`now\\`');
  });

  it('escapes every reserved character together without dropping any text', () => {
    const input = 'order_id [abc123] *urgent* `code`';
    const escaped = escapeTelegramMarkdown(input);
    assert.equal(escaped, 'order\\_id \\[abc123\\] \\*urgent\\* \\`code\\`');
    // Stripping every backslash recovers the original text exactly.
    assert.equal(escaped.replace(/\\/g, ''), input);
  });

  it('leaves plain text with no reserved characters unchanged', () => {
    assert.equal(escapeTelegramMarkdown('Buy filled: 0.00012345 BTC @ $50000.00'), 'Buy filled: 0.00012345 BTC @ $50000.00');
  });

  it('handles non-string / nullish input defensively', () => {
    assert.equal(escapeTelegramMarkdown(undefined), '');
    assert.equal(escapeTelegramMarkdown(null), '');
    assert.equal(escapeTelegramMarkdown(42), '');
  });
});

// issue #397 — sendDailySummary previously iterated getConfiguredExchanges()
// and read productId off the regime config (which doesn't carry it), so
// non-BTC funds were mislabeled as BTC and secondary funds on an exchange
// were dropped entirely. formatFundSummaryLines is the pure per-fund
// formatting step extracted from sendDailySummary so this can be verified
// without touching disk/network.
describe('formatFundSummaryLines multi-fund daily summary (issue #397)', () => {
  const state = {
    regime: { mode: 'active' },
    position: { totalAsset: 0.25, realizedPnL: 123.45, cyclesCompleted: 3, cycleBuys: 2 },
  };

  it('resolves the base currency from the fund config productId, not the regime config', () => {
    const lines = formatFundSummaryLines('coinbase', 'ETH-USDC', state, { productId: 'ETH-USDC' });
    assert.match(lines[0], /coinbase/);
    assert.match(lines[0], /ETH-USDC/);
    assert.match(lines[1], /ETH/);
    assert.doesNotMatch(lines[1], /BTC/);
  });

  it('labels each fund with its exchange and pair so multiple funds on one exchange are distinguishable', () => {
    const btcLines = formatFundSummaryLines('coinbase', 'BTC-USDC', state, { productId: 'BTC-USDC' });
    const ethLines = formatFundSummaryLines('coinbase', 'ETH-USDC', state, { productId: 'ETH-USDC' });
    assert.notEqual(btcLines[0], ethLines[0]);
    assert.match(btcLines[0], /BTC-USDC/);
    assert.match(ethLines[0], /ETH-USDC/);
  });

  it('falls back to BTC when the fund config has no productId', () => {
    const lines = formatFundSummaryLines('coinbase', 'BTC-USDC', state, {});
    assert.match(lines[1], /BTC/);
  });

  it('escapes Crypto.com pair separators in the Markdown daily summary', () => {
    const lines = formatFundSummaryLines('cryptocom', 'CRO_USD', state, { productId: 'CRO_USD' });
    assert.equal(lines[0], '*cryptocom* CRO\\_USD (active)');
    assert.equal(lines[1], '  Position: 0.25000000 CRO');
  });

  it('defaults position/pnl/cycle fields when state is missing pieces', () => {
    const lines = formatFundSummaryLines('kraken', 'BTC-USD', {}, { productId: 'BTC-USD' });
    assert.match(lines[0], /N\/A/);
    assert.match(lines[1], /0\.00000000 BTC/);
    assert.match(lines[2], /\$0\.00/);
    assert.match(lines[3], /Cycles: 0, Current buys: 0/);
  });

  it('formats realized P&L and position quantity for a healthy fund', () => {
    const lines = formatFundSummaryLines('coinbase', 'SOL-USDC', state, { productId: 'SOL-USDC' });
    assert.match(lines[1], /0\.25000000 SOL/);
    assert.match(lines[2], /\$123\.45/);
    assert.match(lines[3], /Cycles: 3, Current buys: 2/);
  });
});

const BASE_CONFIG_FILE = path.join(__dirname, '..', 'config.json');
const USER_CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

// Mirrors src/notifier.js MAX_MESSAGE_LENGTH (not exported: it's an internal
// batching constant, not part of the module's public contract).
const MAX_MESSAGE_LENGTH = 4000;

/** Serve a static, fs-mocked notification config for config-utils. */
const setupFsMocks = (notifications) => {
  configUtils._resetConfigCacheForTests();
  const base = { exchanges: {}, global: { notifications } };

  mock.method(fs, 'existsSync', (filePath) => filePath === BASE_CONFIG_FILE);
  mock.method(fs, 'readFileSync', (filePath) => {
    if (filePath === BASE_CONFIG_FILE) return JSON.stringify(base);
    throw new Error(`ENOENT: ${filePath}`);
  });
  mock.method(fs, 'statSync', (filePath) => {
    if (filePath === BASE_CONFIG_FILE) return { mtimeMs: 1 };
    const err = new Error(`ENOENT: ${filePath}`);
    err.code = 'ENOENT';
    throw err;
  });
};

/** Default notification config used by the createNotifier() integration tests. */
const RUNNING_CONFIG = {
  enabled: true,
  telegram: { botToken: 'FAKE:TEST-TOKEN', chatId: 'chat-1' },
  events: {},
  rateLimitMs: 5000,
  dailySummaryHour: 20,
  quietHours: { enabled: false, start: 23, end: 7 },
};

/** Let queued microtasks (fetch mock resolution, .json() await, etc) settle. */
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

describe('isQuietHours (pure)', () => {
  it('is always false when quiet hours are disabled', () => {
    for (const hour of [0, 12, 23]) {
      assert.equal(isQuietHours({ enabled: false, start: 23, end: 7 }, new Date(2024, 0, 1, hour)), false);
    }
  });

  it('same-day range [start, end) is inclusive of start, exclusive of end', () => {
    const quietHours = { enabled: true, start: 1, end: 5 };
    assert.equal(isQuietHours(quietHours, new Date(2024, 0, 1, 0, 59)), false);
    assert.equal(isQuietHours(quietHours, new Date(2024, 0, 1, 1, 0)), true);
    assert.equal(isQuietHours(quietHours, new Date(2024, 0, 1, 4, 59)), true);
    assert.equal(isQuietHours(quietHours, new Date(2024, 0, 1, 5, 0)), false);
  });

  it('overnight range (start > end, e.g. 23-7) wraps past midnight', () => {
    const quietHours = { enabled: true, start: 23, end: 7 };
    assert.equal(isQuietHours(quietHours, new Date(2024, 0, 1, 2, 0)), true, '02:00 is inside 23->7');
    assert.equal(isQuietHours(quietHours, new Date(2024, 0, 1, 23, 0)), true, '23:00 is inside 23->7');
    assert.equal(isQuietHours(quietHours, new Date(2024, 0, 1, 6, 59)), true, '06:59 is inside 23->7');
    assert.equal(isQuietHours(quietHours, new Date(2024, 0, 1, 7, 0)), false, '07:00 is outside 23->7');
    assert.equal(isQuietHours(quietHours, new Date(2024, 0, 1, 12, 0)), false, '12:00 is outside 23->7');
  });
});

describe('shouldSendEvent (pure)', () => {
  const baseConfig = (overrides = {}) => ({
    enabled: true,
    telegram: { botToken: 'FAKE:TOKEN', chatId: 'chat-1' },
    events: {},
    quietHours: { enabled: false, start: 23, end: 7 },
    ...overrides,
  });

  it('is false when notifications are disabled', () => {
    assert.equal(shouldSendEvent(baseConfig({ enabled: false }), 'buy_filled'), false);
  });

  it('is false when the bot token is missing', () => {
    const cfg = baseConfig({ telegram: { botToken: '', chatId: 'chat-1' } });
    assert.equal(shouldSendEvent(cfg, 'buy_filled'), false);
  });

  it('is false when the chat id is missing', () => {
    const cfg = baseConfig({ telegram: { botToken: 'FAKE:TOKEN', chatId: '' } });
    assert.equal(shouldSendEvent(cfg, 'buy_filled'), false);
  });

  it('an operator-disabled event stays suppressed even when it is in CRITICAL_EVENTS', () => {
    // Pins the check order: config.events[type] === false (checked first)
    // must win over the critical-event quiet-hours bypass (checked after).
    for (const eventType of CRITICAL_EVENTS) {
      const cfg = baseConfig({ events: { [eventType]: false } });
      assert.equal(shouldSendEvent(cfg, eventType), false, eventType);
    }
  });

  it('a non-critical event is suppressed during quiet hours', () => {
    const cfg = baseConfig({ quietHours: { enabled: true, start: 1, end: 5 } });
    assert.equal(shouldSendEvent(cfg, 'buy_filled', new Date(2024, 0, 1, 3, 0)), false);
  });

  it('every CRITICAL_EVENTS type bypasses quiet hours', () => {
    const cfg = baseConfig({ quietHours: { enabled: true, start: 1, end: 5 } });
    const now = new Date(2024, 0, 1, 3, 0);
    for (const eventType of CRITICAL_EVENTS) {
      assert.equal(shouldSendEvent(cfg, eventType, now), true, eventType);
    }
  });

  it('overnight quiet hours (23->7): non-critical blocked at 02:00, allowed at 12:00', () => {
    const cfg = baseConfig({ quietHours: { enabled: true, start: 23, end: 7 } });
    assert.equal(shouldSendEvent(cfg, 'buy_filled', new Date(2024, 0, 1, 2, 0)), false);
    assert.equal(shouldSendEvent(cfg, 'buy_filled', new Date(2024, 0, 1, 12, 0)), true);
  });
});

describe('computeDailySummaryDelay (pure)', () => {
  it('is finite and positive for every hour 0-23, whether already passed or still ahead today', () => {
    const now = new Date(2024, 0, 1, 12, 0, 0, 0);
    for (let hour = 0; hour <= 23; hour++) {
      const delay = computeDailySummaryDelay(hour, now);
      assert.ok(Number.isFinite(delay), `hour ${hour}: not finite`);
      assert.ok(delay > 0, `hour ${hour}: not positive (${delay})`);
    }
  });

  it('target still ahead today rolls within the same day', () => {
    const now = new Date(2024, 0, 1, 9, 0, 0, 0);
    const delay = computeDailySummaryDelay(20, now); // 20:00 later today
    assert.equal(delay, 11 * 60 * 60 * 1000);
  });

  it('target already passed today rolls to tomorrow', () => {
    const now = new Date(2024, 0, 1, 9, 0, 0, 0);
    const delay = computeDailySummaryDelay(5, now); // 05:00 already passed
    assert.equal(delay, 20 * 60 * 60 * 1000);
  });
});

describe('createNotifier() integration (fs-mocked config, stubbed fetch)', () => {
  let originalFetch;
  let notifier;

  afterEach(async () => {
    if (notifier) notifier.stop();
    notifier = null;
    global.fetch = originalFetch;
    mock.restoreAll();
    configUtils._resetConfigCacheForTests();
  });

  /** Capture every fetch call; resolve `ok:true` unless `respond` overrides it. */
  const stubFetch = (respond = async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => ({}) })) => {
    originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return respond();
    };
    return calls;
  };

  const emit = (type, message, exchange = 'coinbase') =>
    tradeEvents.emit('trade', { type, exchange, message, data: {}, timestamp: new Date().toISOString() });

  it('multiple events inside one rateLimitMs window produce exactly one fetch call', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    setupFsMocks(RUNNING_CONFIG);
    const calls = stubFetch();
    notifier = createNotifier();
    notifier.start();

    emit('buy_filled', 'first');
    emit('tp_filled', 'second');
    emit('entry_filled', 'third');
    assert.equal(calls.length, 0, 'nothing sent before the rate-limit window elapses');

    t.mock.timers.tick(RUNNING_CONFIG.rateLimitMs);
    return flushMicrotasks().then(() => {
      assert.equal(calls.length, 1);
      assert.ok(calls[0].body.text.includes('first'));
      assert.ok(calls[0].body.text.includes('second'));
      assert.ok(calls[0].body.text.includes('third'));
    });
  });

  it('a batch exceeding MAX_MESSAGE_LENGTH splits into multiple sequential fetch calls without dropping messages', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    setupFsMocks(RUNNING_CONFIG);
    const calls = stubFetch();
    notifier = createNotifier();
    notifier.start();

    // Each message alone is well under MAX_MESSAGE_LENGTH, but any two
    // combined exceed it, forcing flushQueue to split into three batches.
    emit('buy_filled', `${'a'.repeat(3000)}-MARK1`);
    emit('buy_filled', `${'b'.repeat(3000)}-MARK2`);
    emit('buy_filled', `${'c'.repeat(3000)}-MARK3`);

    t.mock.timers.tick(RUNNING_CONFIG.rateLimitMs);
    return flushMicrotasks().then(async () => {
      // sendTelegram calls chain sequentially (reduce over a promise chain);
      // give any remaining links in the chain a chance to settle.
      await flushMicrotasks();
      assert.equal(calls.length, 3);
      for (const call of calls) assert.ok(call.body.text.length <= MAX_MESSAGE_LENGTH);
      const combined = calls.map(c => c.body.text).join('\n');
      assert.ok(combined.includes('MARK1'));
      assert.ok(combined.includes('MARK2'));
      assert.ok(combined.includes('MARK3'));
    });
  });

  it('sendTelegram: a non-2xx response increments errors/dailyErrors, not sent', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    setupFsMocks(RUNNING_CONFIG);
    stubFetch(async () => ({ ok: false, status: 400, statusText: 'Bad Request', json: async () => ({ description: 'bad' }) }));
    notifier = createNotifier();
    notifier.start();

    emit('buy_filled', 'oops');
    t.mock.timers.tick(RUNNING_CONFIG.rateLimitMs);
    return flushMicrotasks().then(() => {
      const stats = notifier.getStats();
      assert.equal(stats.sent, 0);
      assert.equal(stats.errors, 1);
    });
  });

  it('sendTelegram: a rejected fetch is caught and counted, not left as an unhandled rejection', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    setupFsMocks(RUNNING_CONFIG);
    originalFetch = global.fetch;
    global.fetch = async () => { throw new Error('network down'); };
    notifier = createNotifier();
    notifier.start();

    let unhandled = null;
    const onUnhandled = (err) => { unhandled = err; };
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.removeListener('unhandledRejection', onUnhandled));

    emit('buy_filled', 'oops');
    t.mock.timers.tick(RUNNING_CONFIG.rateLimitMs);
    await flushMicrotasks();
    await flushMicrotasks();

    const stats = notifier.getStats();
    assert.equal(stats.sent, 0);
    assert.equal(stats.errors, 1);
    assert.equal(unhandled, null);
  });

  it('stop() flushes the pending queue instead of dropping it', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    setupFsMocks(RUNNING_CONFIG);
    const calls = stubFetch();
    notifier = createNotifier();
    notifier.start();

    emit('buy_filled', 'pending message');
    assert.equal(calls.length, 0, 'still queued, rate-limit timer has not fired yet');

    notifier.stop();
    return flushMicrotasks().then(() => {
      assert.equal(calls.length, 1, 'stop() flushed the queued message');
      assert.ok(calls[0].body.text.includes('pending message'));
      assert.equal(notifier.getStats().queueDepth, 0);
    });
  });

  it('stop() removes the tradeEvents listener so a later emit produces no fetch', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    setupFsMocks(RUNNING_CONFIG);
    const calls = stubFetch();
    notifier = createNotifier();
    notifier.start();
    notifier.stop();

    emit('buy_filled', 'after stop');
    t.mock.timers.tick(RUNNING_CONFIG.rateLimitMs);
    return flushMicrotasks().then(() => {
      assert.equal(calls.length, 0);
      assert.equal(notifier.getStats().isRunning, false);
    });
  });

  it('updateConfig reschedules the daily summary when a changed dailySummaryHour takes effect while running', (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(2024, 0, 1, 8, 0, 0, 0).getTime() });
    setupFsMocks({ ...RUNNING_CONFIG, dailySummaryHour: 10 }); // 2h out at 08:00
    const calls = stubFetch();
    notifier = createNotifier();
    notifier.start();

    // Move the scheduled hour closer (08:00 -> 09:00 target = 1h out) and
    // notify the running notifier. Without the reschedule fix, the original
    // timer (fired at the 2h mark) would still be pending at the 1h mark.
    setupFsMocks({ ...RUNNING_CONFIG, dailySummaryHour: 9 });
    notifier.updateConfig({ dailySummaryHour: 9 });

    t.mock.timers.tick(60 * 60 * 1000); // advance exactly 1h
    return flushMicrotasks().then(() => {
      assert.equal(calls.length, 1, 'daily summary fired on the rescheduled (1h) timer, not the stale 2h one');
    });
  });
});
