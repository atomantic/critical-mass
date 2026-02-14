#!/usr/bin/env node
/**
 * Bulk rename BTC-specific identifiers to asset-agnostic names.
 * Run from project root: node scripts/rename-btc-to-asset.js
 */
const fs = require('fs');
const path = require('path');

// Identifier renames (order matters — longer/more specific first to avoid partial matches)
const RENAMES = [
  // Functions
  ['formatBTCCompact', 'formatAssetCompact'],
  ['formatBTC', 'formatAsset'],
  ['roundBTC', 'roundAsset'],

  // Compound field names (longer first)
  ['buyQuantityBTC', 'buyQuantity'],
  ['sellQuantityBTC', 'sellQuantity'],
  ['outstandingOrdersBTC', 'outstandingOrdersAsset'],
  ['bodiesRealizedBtcPnL', 'bodiesRealizedAssetPnL'],
  ['globalRealizedBtcPnL', 'globalRealizedAssetPnL'],
  ['realizedBtcPnL', 'realizedAssetPnL'],
  ['fibCumulativeBTC', 'fibCumulativeAsset'],
  ['maxBtcExposure', 'maxAssetExposure'],

  // Simple field names
  ['btcReserves', 'assetReserves'],
  ['btcOnOrder', 'assetOnOrder'],
  ['btcBalance', 'assetBalance'],
  ['btcAmount', 'assetAmount'],
  ['btcValue', 'assetValue'],
  ['btcQty', 'assetQty'],

  // Position fields
  ['totalBTC', 'totalAsset'],

  // holdbackBTC but NOT holdbackBtc (different casing) — handle both
  ['holdbackBTC', 'holdbackAsset'],
  ['holdbackBtc', 'holdbackAsset'],

  // Local variable names (camelCase Btc variants)
  ['totalRealizedBtcPnL', 'totalRealizedAssetPnL'],
  ['bodyHoldbackBtc', 'bodyHoldbackAsset'],
  ['satelliteHoldbackBtc', 'satelliteHoldbackAsset'],
  ['totalBtcBought', 'totalAssetBought'],
  ['totalBuyBTC', 'totalBuyAsset'],
  ['totalSellBTC', 'totalSellAsset'],
  ['netBTC', 'netAsset'],
  ['orphanBuysBtc', 'orphanBuysAsset'],
  ['orphanSellsBtc', 'orphanSellsAsset'],
  ['orphanBtcBalance', 'orphanAssetBalance'],
  ['buysBtc', 'buysAsset'],
  ['coreSellsBtc', 'coreSellsAsset'],
  ['btcSold', 'assetSold'],
  ['gRunBtc', 'gRunAsset'],
  ['btcPrice', 'assetPrice'],
  ['btcProfitPct', 'assetProfitPct'],
  ['btcHeld', 'assetHeld'],
  ['baseCcy', 'assetCcy'],

  // risk-manager / order-manager / backtest local vars
  ['checkBTCCap', 'checkAssetCap'],
  ['currentBTC', 'currentAsset'],
  ['entryBTC', 'entryAsset'],
  ['maxBTC', 'maxAsset'],
  ['remainingBTC', 'remainingAsset'],
  ['consolidatedBTC', 'consolidatedAsset'],
  ['cumulativeBTC', 'cumulativeAsset'],
  ['sellBTC', 'sellAsset'],
  ['costBasisPerBTC', 'costBasisPerAsset'],
  ['avgCostPerBTC', 'avgCostPerAsset'],
  ['costPerBTC', 'costPerAsset'],
  ['profitPerBTC', 'profitPerAsset'],
  ['profitBtcValue', 'profitAssetValue'],
  ['untrackedBtc', 'untrackedAsset'],
  ['trackedBTC', 'trackedAsset'],
  ['accountBTC', 'accountAsset'],
  ['totalBtcPnL', 'totalAssetPnL'],
  ['pendingBTC', 'pendingAsset'],
  ['reservesBTC', 'reservesAsset'],
  ['estimatedDailyBtc', 'estimatedDailyAsset'],

  // fill-ledger / dry-run-state
  ['simulatedRealizedBtcPnL', 'simulatedRealizedAssetPnL'],
];

// Files/directories to process
const SEARCH_DIRS = [
  'src',
  'admin/src',
];

// Extensions to process
const EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs']);

// Files/dirs to skip
const SKIP = new Set(['node_modules', 'dist', '.git', 'scripts']);

function walk(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(fullPath));
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      results.push(fullPath);
    }
  }
  return results;
}

const root = path.resolve(__dirname, '..');
let totalFiles = 0;
let totalReplacements = 0;

for (const dir of SEARCH_DIRS) {
  const absDir = path.join(root, dir);
  if (!fs.existsSync(absDir)) continue;
  const files = walk(absDir);

  for (const file of files) {
    let content = fs.readFileSync(file, 'utf8');
    let modified = false;
    let fileReplacements = 0;

    for (const [from, to] of RENAMES) {
      // Use word-boundary-aware replacement to avoid partial matches
      // Match the identifier when preceded/followed by non-word chars or string boundaries
      const regex = new RegExp(`\\b${from}\\b`, 'g');
      const matches = content.match(regex);
      if (matches) {
        content = content.replace(regex, to);
        modified = true;
        fileReplacements += matches.length;
      }
    }

    if (modified) {
      fs.writeFileSync(file, content);
      const relPath = path.relative(root, file);
      console.log(`  ${relPath} (${fileReplacements} replacements)`);
      totalFiles++;
      totalReplacements += fileReplacements;
    }
  }
}

console.log(`\nDone: ${totalReplacements} replacements across ${totalFiles} files`);
