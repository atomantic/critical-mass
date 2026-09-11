const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('UpDown dashboard operational-first layout (issue #507)', async () => {
  const { SECTION_IDS, focusSection } = await import('../admin/src/components/updown/dashboard-layout.js');

  it('exposes stable, distinct section ids for the shortcuts to target', () => {
    assert.equal(typeof SECTION_IDS.position, 'string');
    assert.equal(typeof SECTION_IDS.contractSetup, 'string');
    assert.notEqual(SECTION_IDS.position, SECTION_IDS.contractSetup);
    assert.ok(SECTION_IDS.position.length > 0);
    assert.ok(SECTION_IDS.contractSetup.length > 0);
  });

  it('does nothing when the section is not mounted yet', () => {
    assert.doesNotThrow(() => focusSection(null));
    assert.doesNotThrow(() => focusSection(undefined));
  });

  it('scrolls the section into view and focuses its first focusable control', () => {
    const calls = { scroll: 0, focus: [] };
    const focusable = { focus: (opts) => calls.focus.push(['input', opts]) };
    const section = {
      scrollIntoView: (opts) => { calls.scroll++; assert.deepEqual(opts, { behavior: 'smooth', block: 'start' }); },
      querySelector: (sel) => { assert.equal(sel, 'input, textarea, select, button, [tabindex]'); return focusable; },
      focus: () => calls.focus.push(['section']),
    };

    focusSection(section);

    assert.equal(calls.scroll, 1);
    assert.deepEqual(calls.focus, [['input', { preventScroll: true }]]);
  });

  it('falls back to focusing the section itself when nothing focusable is found', () => {
    const calls = { focus: [] };
    const section = {
      scrollIntoView: () => {},
      querySelector: () => null,
      focus: (opts) => calls.focus.push(['section', opts]),
    };

    focusSection(section);

    assert.deepEqual(calls.focus, [['section', { preventScroll: true }]]);
  });

  it('tolerates environments/elements missing scrollIntoView or focus', () => {
    assert.doesNotThrow(() => focusSection({}));
    assert.doesNotThrow(() => focusSection({ querySelector: () => null }));
  });
});

describe('UpDown Dashboard.jsx structural invariants (issue #507)', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'admin', 'src', 'components', 'updown', 'Dashboard.jsx'),
    'utf8',
  );

  it('mounts PositionTracker and ContractSetup exactly once each, as their single owners', () => {
    assert.equal((source.match(/<PositionTracker\b/g) || []).length, 1);
    assert.equal((source.match(/<ContractSetup\b/g) || []).length, 1);
  });

  it('never conditionally unmounts ContractSetup on the setup disclosure state (retains unsaved values, issues no write on toggle)', () => {
    assert.ok(!/setupOpen\s*&&\s*<ContractSetup/.test(source));
    assert.ok(!/setupOpen\s*\?\s*<ContractSetup/.test(source));
  });

  it('renders the operational section (Position + Contract Setup) before trade history, timeframe charts and the scorecard', () => {
    const positionIdx = source.indexOf('SECTION_IDS.position');
    const setupIdx = source.indexOf('SECTION_IDS.contractSetup');
    const tradeHistoryIdx = source.indexOf('<TradeHistory');
    const timeframeGridIdx = source.indexOf('<TimeframeGrid');
    const scorecardIdx = source.indexOf('<ScorecardPanel');

    assert.ok(positionIdx > -1 && setupIdx > -1 && tradeHistoryIdx > -1 && timeframeGridIdx > -1 && scorecardIdx > -1);
    assert.ok(positionIdx < tradeHistoryIdx);
    assert.ok(positionIdx < timeframeGridIdx);
    assert.ok(positionIdx < scorecardIdx);
    assert.ok(setupIdx < tradeHistoryIdx);
    assert.ok(setupIdx < timeframeGridIdx);
    assert.ok(setupIdx < scorecardIdx);
  });

  it('keeps the /updown/analysis route reachable via an explicit link', () => {
    assert.ok(source.includes('/updown/analysis'));
  });
});
