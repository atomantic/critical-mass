const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('UpDown Dashboard.jsx 3-column layout', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'admin', 'src', 'components', 'updown', 'Dashboard.jsx'),
    'utf8',
  );

  it('mounts PositionTracker and ContractSetup exactly once each, as their single owners', () => {
    assert.equal((source.match(/<PositionTracker\b/g) || []).length, 1);
    assert.equal((source.match(/<ContractSetup\b/g) || []).length, 1);
  });

  it('renders a 3-column responsive grid layout', () => {
    assert.ok(source.includes('grid-cols-1 lg:grid-cols-4'));
    assert.ok(source.includes('lg:col-span-2'));
  });

  it('renders all key dashboard panels in the 3-column structure', () => {
    const timeframeGridIdx = source.indexOf('<TimeframeGrid');
    const signalPanelIdx = source.indexOf('<SignalPanel');
    const tradeHistoryIdx = source.indexOf('<TradeHistory');
    const priceChartIdx = source.indexOf('<PriceChart');
    const signalBannerIdx = source.indexOf('<SignalBanner');
    const scorecardIdx = source.indexOf('<ScorecardPanel');
    const contractSetupIdx = source.indexOf('<ContractSetup');
    const positionTrackerIdx = source.indexOf('<PositionTracker');

    // Column 1: TimeframeGrid, SignalPanel, TradeHistory
    assert.ok(timeframeGridIdx > -1 && signalPanelIdx > -1 && tradeHistoryIdx > -1);
    assert.ok(timeframeGridIdx < signalPanelIdx);
    assert.ok(signalPanelIdx < tradeHistoryIdx);

    // Column 2: PriceChart
    assert.ok(priceChartIdx > -1);
    assert.ok(tradeHistoryIdx < priceChartIdx);

    // Column 3: SignalBanner, ScorecardPanel, ContractSetup, PositionTracker
    assert.ok(signalBannerIdx > -1 && scorecardIdx > -1 && contractSetupIdx > -1 && positionTrackerIdx > -1);
    assert.ok(priceChartIdx < signalBannerIdx);
    assert.ok(signalBannerIdx < scorecardIdx);
    assert.ok(scorecardIdx < contractSetupIdx);
    assert.ok(contractSetupIdx < positionTrackerIdx);
  });

  it('keeps the /updown/analysis route reachable via an explicit link', () => {
    assert.ok(source.includes('/updown/analysis'));
  });
});
