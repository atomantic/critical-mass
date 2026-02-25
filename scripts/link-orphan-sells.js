#!/usr/bin/env node
// Links existing open sell orders to celestial bodies in state files
// Does NOT place new orders — just fixes the state linkage
const fs = require('fs');
const path = require('path');

const stateFile = path.join(__dirname, '..', 'data/gemini/regime-state.json');
const ledgerFile = path.join(__dirname, '..', 'data/gemini/fill-ledger.json');

const BODY1_ID = 'body-15708528-mln0kjy7';
const BODY2_ID = 'body-67414173-mly10lat';

const BODY1_SELL_ID = '73771273009712511';
const BODY1_SELL_PRICE = 77549.25;
const BODY1_SELL_QTY = 0.03924966;

const BODY2_SELL_ID = '73771273009713075';
const BODY2_SELL_PRICE = 68139.30;
const BODY2_SELL_QTY = 0.00048069;

const body1SourceIds = new Set([
  'consolidated-1771115708528', '73771272149434674', '73771272201699942',
  '73771272202643083', '73771272204808113', '73771272205549538',
  '73771272208333634', '73771272211413794', '73771272217179631',
]);

// Update regime-state.json
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const body1 = state.position.celestialBodies.find(b => b.id === BODY1_ID);
const body2 = state.position.celestialBodies.find(b => b.id === BODY2_ID);

body1.tpOrderId = BODY1_SELL_ID;
body1.tpPrice = BODY1_SELL_PRICE;
body1.assetOnOrder = BODY1_SELL_QTY;

body2.tpOrderId = BODY2_SELL_ID;
body2.tpPrice = BODY2_SELL_PRICE;
body2.assetOnOrder = BODY2_SELL_QTY;

state.position.assetOnOrder = BODY1_SELL_QTY + BODY2_SELL_QTY;

fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
console.log('regime-state.json updated');
console.log('  body1 tpOrderId:', body1.tpOrderId);
console.log('  body2 tpOrderId:', body2.tpOrderId);

// Update fill-ledger.json
const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
let b1 = 0, b2 = 0;
for (const fill of ledger) {
  if (fill.side !== 'buy') continue;
  if (body1SourceIds.has(fill.orderId)) { fill.sellOrderId = BODY1_SELL_ID; b1++; }
  else if (fill.orderId === '73771272767414173') { fill.sellOrderId = BODY2_SELL_ID; b2++; }
}
fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
console.log('fill-ledger.json updated:', b1, 'body1 fills,', b2, 'body2 fills');
