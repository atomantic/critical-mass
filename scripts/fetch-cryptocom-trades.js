#!/usr/bin/env node
/**
 * Pull all CRO_USD trades from crypto.com private/get-trades, paginating
 * backward from now until before bot inception. Saves raw response to
 * data/cryptocom/CRO_USD/exchange-trades.json.
 *
 * Why string timestamps: auth.js buildParamString strips trailing zeros from
 * numbers ("100" -> "1"), which breaks signing for numeric params. Strings
 * pass through verbatim.
 *
 * Run with: NODE_OPTIONS="--dns-result-order=ipv4first" node scripts/fetch-cryptocom-trades.js
 */
const fs = require('fs');
const path = require('path');
const { createAuthenticatedRequest } = require('../src/adapters/cryptocom/auth');

const keys = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'cryptocom-keys.json'), 'utf8'));
const OUT_PATH = path.join(__dirname, '..', 'data', 'cryptocom', 'CRO_USD', 'exchange-trades.json');
const INCEPTION = new Date('2026-01-20T00:00:00Z').getTime();

const callPrivate = async (method, params) => {
  const body = createAuthenticatedRequest(method, params, keys.apiKey, keys.apiSecret);
  const r = await fetch(`https://api.crypto.com/exchange/v1/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`API ${j.code}: ${j.message}`);
  return j.result;
};

(async () => {
  // private/get-trades returns max 100 trades and appears to apply an implicit
  // ~24h window when only end_time is set. So walk a 24h window backward
  // explicitly. If a window has >=100 trades, halve the window and retry to
  // avoid losing fills in that bucket.
  const WINDOW_MS = 24 * 60 * 60 * 1000;
  const all = [];
  const seen = new Set();
  let windowEnd = Date.now();
  let page = 0;
  while (windowEnd > INCEPTION) {
    page++;
    let span = WINDOW_MS;
    let trades;
    let attempts = 0;
    while (true) {
      const windowStart = windowEnd - span;
      const result = await callPrivate('private/get-trades', {
        instrument_name: 'CRO_USD',
        start_time: String(windowStart),
        end_time: String(windowEnd),
      });
      trades = result?.data || [];
      if (trades.length < 100 || span <= 60 * 1000) break;
      span = Math.floor(span / 2);
      attempts++;
      if (attempts > 10) break;
    }
    const added = trades.filter(t => !seen.has(String(t.trade_id))).length;
    for (const t of trades) {
      const tid = String(t.trade_id);
      if (!seen.has(tid)) { seen.add(tid); all.push(t); }
    }
    const cts = trades.map(t => Number(t.create_time));
    const oldest = cts.length ? Math.min(...cts) : windowEnd - span;
    const newest = cts.length ? Math.max(...cts) : windowEnd;
    console.log(`page ${page}: ${trades.length} fetched (${added} new), ${new Date(oldest).toISOString()} → ${new Date(newest).toISOString()} (span=${span/3600000}h${attempts > 0 ? `, ${attempts} halvings` : ''})`);

    // Step backward by the span we actually used
    windowEnd = windowEnd - span;
    await new Promise(r => setTimeout(r, 200));
  }

  all.sort((a, b) => Number(a.create_time) - Number(b.create_time));
  fs.writeFileSync(OUT_PATH, JSON.stringify(all, null, 2));
  console.log(`\nWrote ${all.length} trades to ${OUT_PATH}`);
  const buys = all.filter(t => t.side === 'BUY');
  const sells = all.filter(t => t.side === 'SELL');
  const bq = buys.reduce((s, t) => s + Number(t.traded_quantity), 0);
  const sq = sells.reduce((s, t) => s + Number(t.traded_quantity), 0);
  const bu = buys.reduce((s, t) => s + Number(t.traded_quantity) * Number(t.traded_price), 0);
  const su = sells.reduce((s, t) => s + Number(t.traded_quantity) * Number(t.traded_price), 0);
  console.log(`buys:  ${buys.length} fills, ${bq.toFixed(2)} CRO, $${bu.toFixed(2)}`);
  console.log(`sells: ${sells.length} fills, ${sq.toFixed(2)} CRO, $${su.toFixed(2)}`);
  console.log(`net:   ${(bq - sq).toFixed(2)} CRO, $${(su - bu).toFixed(2)}`);
})().catch(e => { console.error('fatal:', e.message); process.exit(1); });
