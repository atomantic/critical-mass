#!/usr/bin/env node
/**
 * Pull all BTC-USDC fills from Coinbase /api/v3/brokerage/orders/historical/fills,
 * paginating via cursor. Saves raw response to
 * data/coinbase/BTC-USDC/exchange-trades.json.
 *
 * Run: NODE_OPTIONS="--dns-result-order=ipv4first" node scripts/fetch-coinbase-trades.js
 */
const fs = require('fs');
const path = require('path');
const { getAuthHeaders } = require('../src/adapters/coinbase/auth');

const DATA_DIR = path.join(__dirname, '..', 'data', 'coinbase', 'BTC-USDC');
const OUT_PATH = path.join(DATA_DIR, 'exchange-trades.json');
const KEYS_PATH = path.join(__dirname, '..', 'data', 'coinbase-keys.json');
const API_URL = 'https://api.coinbase.com';
const PRODUCT_ID = 'BTC-USDC';
const INCEPTION_ISO = '2025-11-01T00:00:00Z';

const keysRaw = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8'));
const keys = { apiKey: keysRaw.name, apiSecret: keysRaw.privateKey };

const makeRequest = async (apiPath) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch(`${API_URL}${apiPath}`, {
      method: 'GET',
      headers: getAuthHeaders(keys.apiKey, keys.apiSecret, 'GET', apiPath),
      signal: controller.signal,
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`Coinbase API ${resp.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
};

(async () => {
  const all = [];
  let cursor = null;
  let page = 0;
  while (true) {
    page++;
    let apiPath = `/api/v3/brokerage/orders/historical/fills?product_id=${PRODUCT_ID}&start_sequence_timestamp=${INCEPTION_ISO}&limit=500`;
    if (cursor) apiPath += `&cursor=${encodeURIComponent(cursor)}`;
    const data = await makeRequest(apiPath);
    const fills = data.fills || [];
    all.push(...fills);
    cursor = data.cursor || null;
    const cts = fills.map(f => new Date(f.trade_time || f.sequence_timestamp).getTime());
    const oldest = cts.length ? Math.min(...cts) : 0;
    const newest = cts.length ? Math.max(...cts) : 0;
    console.log(`page ${page}: ${fills.length} fills, ${oldest ? new Date(oldest).toISOString() : '?'} → ${newest ? new Date(newest).toISOString() : '?'}${cursor ? ' (cursor)' : ''}`);
    if (!cursor) break;
    await new Promise(r => setTimeout(r, 150));
  }
  all.sort((a, b) => new Date(a.trade_time).getTime() - new Date(b.trade_time).getTime());
  fs.writeFileSync(OUT_PATH, JSON.stringify(all, null, 2));
  const buys = all.filter(f => f.side === 'BUY');
  const sells = all.filter(f => f.side === 'SELL');
  const bq = buys.reduce((s, f) => s + Number(f.size || 0), 0);
  const sq = sells.reduce((s, f) => s + Number(f.size || 0), 0);
  const bu = buys.reduce((s, f) => s + Number(f.size_in_quote || f.size_value || 0), 0);
  const su = sells.reduce((s, f) => s + Number(f.size_in_quote || f.size_value || 0), 0);
  console.log(`\nTotal: ${all.length} fills`);
  console.log(`  buys:  ${buys.length}, ${bq.toFixed(8)} BTC, $${bu.toFixed(2)}`);
  console.log(`  sells: ${sells.length}, ${sq.toFixed(8)} BTC, $${su.toFixed(2)}`);
  console.log(`  net:   ${(bq-sq).toFixed(8)} BTC, $${(su-bu).toFixed(2)}`);
  console.log(`Wrote ${OUT_PATH}`);
})().catch(e => { console.error('fatal:', e.message); process.exit(1); });
