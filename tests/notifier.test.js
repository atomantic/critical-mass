// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { escapeTelegramMarkdown, formatFundSummaryLines } = require('../src/notifier');

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
