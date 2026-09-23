// @ts-check
/**
 * A realistic, fully-annotated regime ledger driven through the real
 * fill-ledger API — the shape a long-running engine leaves on disk.
 *
 * Every sell carries the engine's bodyPnl/satellitePnl AND holdback
 * annotations, so the realized totals must not depend on buy↔sell pairing
 * at all. Used as the parity fixture for the shared cycle-pairing module
 * (issue #697): its realized totals were captured from the pre-#697 server
 * implementation and must never move.
 *
 * Covers: multi-partial buys and sells, holdback, per-buy consumedBy records
 * (#607), a partial body TP whose buys were re-linked to a still-resting TP
 * (#128 — the orphaned sellOrderId the bodyId redirect must not disturb), a
 * satellite sell, a merge-snapshot sell with no linked buys, an open body with
 * a resting TP, and a legacy buy with no orderId (#108).
 */

let seq = 0;
const T0 = Date.parse('2026-08-01T00:00:00Z');

/**
 * @param {'buy'|'sell'} side
 * @param {Record<string, any>} overrides
 */
const makeFill = (side, overrides) => {
  seq += 1;
  return {
    tradeId: `rt-${side}-${seq}`,
    side,
    price: '100000',
    size: '0.001',
    totalCommission: '0.10',
    rebate: '0',
    liquidityIndicator: 'MAKER',
    tradeTime: new Date(T0 + seq * 60_000).toISOString(),
    ...overrides,
  };
};

/**
 * Populate `ledger` (a fresh createFillLedger instance) with the fixture.
 * @param {any} ledger
 */
const buildRealisticCycleLedger = (ledger) => {
  seq = 0;
  ledger.startNewCycle();

  // Body A: two buy orders (one in two partial rows), TP fills in two partial
  // rows; engine annotates every sell row identically and records consumption.
  ledger.ingestFill(makeFill('buy', { orderId: 'a-buy-1', price: '98000', size: '0.0006', totalCommission: '0.06' }));
  ledger.ingestFill(makeFill('buy', { orderId: 'a-buy-1', price: '98000', size: '0.0004', totalCommission: '0.04' }));
  ledger.ingestFill(makeFill('buy', { orderId: 'a-buy-2', price: '96000', size: '0.001', totalCommission: '0.10' }));
  ledger.annotateFillsByOrderIds(['a-buy-1', 'a-buy-2'], { isBodyOwned: true, bodyId: 'body-a', bodyTier: 'moon', sellOrderId: 'a-tp' });
  ledger.ingestFill(makeFill('sell', { orderId: 'a-tp', price: '101000', size: '0.001' }));
  ledger.ingestFill(makeFill('sell', { orderId: 'a-tp', price: '101000', size: '0.0008' }));
  ledger.annotateFillsByOrderId('a-tp', {
    isBodyOwned: true, bodyId: 'body-a', bodyTier: 'moon',
    bodyCostBasis: 175.5, bodyBtcQty: 0.002, bodyHoldbackAsset: 0.0002, bodyPnl: 6.1,
  });
  ledger.recordBuyConsumption('a-buy-1', 'a-tp', 0.001);
  ledger.recordBuyConsumption('a-buy-2', 'a-tp', 0.001);

  // Body B (#128): TP partially fills, the engine re-links the buys to a
  // re-placed TP that is still resting (so its id has no sell fills).
  ledger.ingestFill(makeFill('buy', { orderId: 'b-buy-1', price: '97000', size: '0.002', totalCommission: '0.19' }));
  ledger.annotateFillsByOrderId('b-buy-1', { isBodyOwned: true, bodyId: 'body-b', bodyTier: 'planet', sellOrderId: 'b-tp-old' });
  ledger.ingestFill(makeFill('sell', { orderId: 'b-tp-old', price: '102000', size: '0.001' }));
  ledger.annotateFillsByOrderId('b-tp-old', {
    isBodyOwned: true, bodyId: 'body-b', bodyTier: 'planet',
    bodyCostBasis: 97.1, bodyBtcQty: 0.001, bodyHoldbackAsset: 0, bodyPnl: 4.8, partialFill: true,
  });
  ledger.annotateFillsByOrderId('b-buy-1', { sellOrderId: 'b-tp-new', consumedCostFraction: 0.5 });
  ledger.recordBuyConsumption('b-buy-1', 'b-tp-old', 0.001);

  // Satellite: legacy satellite* annotations.
  ledger.ingestFill(makeFill('buy', { orderId: 's-buy-1', price: '95000', size: '0.0005', totalCommission: '0.05' }));
  ledger.annotateFillsByOrderId('s-buy-1', { isSatellite: true, bodyId: 'sat-1', sellOrderId: 's-tp' });
  ledger.ingestFill(makeFill('sell', { orderId: 's-tp', price: '99000', size: '0.00045', totalCommission: '0.04' }));
  ledger.annotateFillsByOrderId('s-tp', { isSatellite: true, bodyId: 'sat-1', satellitePnl: 1.72, satelliteHoldbackAsset: 0.00005 });

  // Merge-snapshot sell: annotated, no buy links to it.
  ledger.ingestFill(makeFill('sell', { orderId: 'm-tp', price: '103000', size: '0.0003', totalCommission: '0.03' }));
  ledger.annotateFillsByOrderId('m-tp', {
    isBodyOwned: true, bodyId: 'merge-snap', bodyCostBasis: 28.9, bodyBtcQty: 0.0003,
    bodyHoldbackAsset: 0.00002, bodyPnl: 1.97, mergeSnapshot: true,
  });

  // Open body C with a resting TP.
  ledger.ingestFill(makeFill('buy', { orderId: 'c-buy-1', price: '99500', size: '0.0012', totalCommission: '0.12' }));
  ledger.annotateFillsByOrderId('c-buy-1', { isBodyOwned: true, bodyId: 'body-c', bodyTier: 'moon', sellOrderId: 'c-tp-resting' });

  // Legacy/manual buy with no orderId, still open.
  ledger.ingestFill(makeFill('buy', { orderId: undefined, price: '94000', size: '0.0003', totalCommission: '0.03' }));
};

module.exports = { buildRealisticCycleLedger };
