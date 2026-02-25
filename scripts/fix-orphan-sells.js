#!/usr/bin/env node
const { createGeminiAdapter } = require('../src/adapters/gemini/api');
const fs = require('fs');
const path = require('path');

const adapter = createGeminiAdapter();
const stateFile = path.join(__dirname, '..', 'data/gemini/regime-state.json');
const ledgerFile = path.join(__dirname, '..', 'data/gemini/fill-ledger.json');

const BODY1_SELL_QTY = 0.03924966;
const BODY1_SELL_PRICE = 77549.25;
const BODY2_SELL_QTY = 0.00048069;
const BODY2_SELL_PRICE = 68139.30;

const body1SourceIds = new Set([
  'consolidated-1771115708528', '73771272149434674', '73771272201699942',
  '73771272202643083', '73771272204808113', '73771272205549538',
  '73771272208333634', '73771272211413794', '73771272217179631',
]);

async function main() {
  // Place both sells
  console.log('Placing hypergiant sell...');
  const sell1 = await adapter.placeLimitSell('BTCUSD', BODY1_SELL_QTY, BODY1_SELL_PRICE, { postOnly: false });
  console.log('  orderId:', sell1.orderId, sell1.success ? 'OK' : 'FAILED: ' + sell1.errorMessage);

  console.log('Placing satellite sell...');
  const sell2 = await adapter.placeLimitSell('BTCUSD', BODY2_SELL_QTY, BODY2_SELL_PRICE, { postOnly: false });
  console.log('  orderId:', sell2.orderId, sell2.success ? 'OK' : 'FAILED: ' + sell2.errorMessage);

  if (sell1.errorMessage || sell2.errorMessage) {
    console.error('One or both sells failed, aborting state update');
    process.exit(1);
  }

  // Update regime-state.json
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const body1 = state.position.celestialBodies.find(b => b.id === 'body-15708528-mln0kjy7');
  const body2 = state.position.celestialBodies.find(b => b.id === 'body-67414173-mly10lat');

  body1.tpOrderId = sell1.orderId;
  body1.tpPrice = BODY1_SELL_PRICE;
  body1.assetOnOrder = BODY1_SELL_QTY;

  body2.tpOrderId = sell2.orderId;
  body2.tpPrice = BODY2_SELL_PRICE;
  body2.assetOnOrder = BODY2_SELL_QTY;

  state.position.assetOnOrder = BODY1_SELL_QTY + BODY2_SELL_QTY;
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  console.log('regime-state.json updated');

  // Update fill-ledger.json
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  for (const fill of ledger) {
    if (fill.side !== 'buy') continue;
    if (body1SourceIds.has(fill.orderId)) fill.sellOrderId = sell1.orderId;
    else if (fill.orderId === '73771272767414173') fill.sellOrderId = sell2.orderId;
  }
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
  console.log('fill-ledger.json updated');

  // Start heartbeat to keep orders alive
  console.log('\nStarting heartbeat to keep orders alive...');
  adapter.startHeartbeat();
  console.log('Heartbeat running. Orders will be cancelled ~5min after this process dies.');
  console.log('Start the engine, then kill this process.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
