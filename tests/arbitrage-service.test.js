// @ts-check
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { createArbitrageService } = require('../src/arbitrage/arbitrage-service');
const { createArbitrageSettings, validateArbitrageConfigUpdate, ARBITRAGE_DEFAULTS } = require('../src/config-settings/arbitrage');
const { tradeEvents } = require('../src/trade-events');

const MARKETS = [
  { symbol: 'BTCUSD', base: 'BTC', quote: 'USD' },
  { symbol: 'BTCCAD', base: 'BTC', quote: 'CAD' },
  { symbol: 'USDCAD', base: 'USD', quote: 'CAD' },
];
const HEALTHY = {
  BTCUSD: { bids: [[95_990, 2]], asks: [[96_010, 2]] },
  BTCCAD: { bids: [[134_380, 2]], asks: [[134_420, 2]] },
  USDCAD: { bids: [[1.3998, 1e7]], asks: [[1.4002, 1e7]] },
};
const SLIPPED = { ...HEALTHY, BTCCAD: { bids: [[67_100, 0.5]], asks: [[67_200, 0.5], [134_500, 5]] } };

const makeService = ({ configOverrides = {} } = {}) => {
  let books = HEALTHY;
  let fail = false;
  const source = {
    id: 'kraken',
    label: 'Kraken',
    minRequestSpacingMs: 0,
    parity: [],
    listMarkets: async () => MARKETS,
    fetchBook: async (symbol) => {
      if (fail) throw new Error('down');
      return books[symbol];
    },
  };
  const config = {
    ...ARBITRAGE_DEFAULTS,
    enabled: true,
    confirmPolls: 2,
    closeAfterPolls: 2,
    referenceFx: { enabled: false, refreshMs: 3_600_000 },
    venues: {
      coinbase: { enabled: false, takerFeeBps: 60 },
      gemini: { enabled: false, takerFeeBps: 40 },
      cryptocom: { enabled: false, takerFeeBps: 50 },
      kraken: { enabled: true, takerFeeBps: 40 },
    },
    ...configOverrides,
  };
  const emitted = [];
  const writes = [];
  const service = createArbitrageService({ to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) }, {
    readJSON: () => null,
    writeJSON: (file, state) => writes.push({ file, state: JSON.parse(JSON.stringify(state)) }),
    DATA_DIR: os.tmpdir(),
    getArbitrageConfig: () => config,
    sources: { kraken: source },
    sleep: async () => {},
  });
  return {
    service,
    emitted,
    writes,
    setBooks: (next) => { books = next; },
    setFail: (value) => { fail = value; },
  };
};

const captureTradeEvents = () => {
  const events = [];
  const listener = (event) => events.push(event);
  tradeEvents.on('trade', listener);
  return { events, stop: () => tradeEvents.off('trade', listener) };
};

describe('arbitrage service episodes', () => {
  let capture;
  afterEach(() => capture?.stop());

  it('opens after confirmPolls, tracks peak, and closes after closeAfterPolls misses', async () => {
    capture = captureTradeEvents();
    const { service, emitted, setBooks } = makeService();

    await service.forcePoll();
    assert.equal(service.getAlerts().length, 0, 'healthy books raise nothing');

    setBooks(SLIPPED);
    await service.forcePoll();
    assert.equal(service.getAlerts().length, 0, 'one poll is not enough to confirm');
    await service.forcePoll();

    const open = service.getAlerts({ status: 'open' });
    const opportunity = open.find((a) => a.type === 'opportunity');
    assert.ok(opportunity, JSON.stringify(open));
    assert.equal(opportunity.venue, 'kraken');
    assert.equal(opportunity.pair, 'BTC/CAD');
    assert.equal(opportunity.current.buyPair, 'BTC/CAD');
    assert.equal(opportunity.current.sellPair, 'BTC/USD');
    assert.ok(opportunity.current.netBps > 50);
    // An executable pair alerts only as an opportunity, never also as a dislocation.
    assert.equal(open.filter((a) => a.type === 'dislocation').length, 0);
    assert.ok(emitted.some((e) => e.room === 'arbitrage' && e.event === 'arbitrage:alert'));

    const ping = capture.events.find((e) => e.type === 'arbitrage_opportunity');
    assert.ok(ping, 'opportunity notifies');
    assert.match(ping.message, /Kraken: buy BTC via BTC\/CAD, sell via BTC\/USD/);
    assert.match(ping.message, /no orders placed/);
    assert.equal(capture.events.filter((e) => e.type === 'arbitrage_dislocation').length, 0);

    setBooks(HEALTHY);
    await service.forcePoll();
    assert.equal(service.getAlerts({ status: 'open' }).length, 1, 'one miss keeps it open');
    await service.forcePoll();
    assert.equal(service.getAlerts({ status: 'open' }).length, 0);
    const closed = service.getAlerts({ status: 'closed' }).find((a) => a.type === 'opportunity');
    assert.ok(closed.closedAt);
    assert.ok(closed.peak.profitUsd >= closed.current.profitUsd);
    assert.ok(capture.events.some((e) => e.type === 'arbitrage_closed'));
  });

  it('does not close an episode while its venue is unreachable', async () => {
    const { service, setBooks, setFail } = makeService();
    setBooks(SLIPPED);
    await service.forcePoll();
    await service.forcePoll();
    assert.ok(service.getAlerts({ status: 'open' }).length > 0);

    setFail(true);
    for (let i = 0; i < 4; i++) await service.forcePoll();
    assert.ok(service.getAlerts({ status: 'open' }).length > 0, 'failed reads are not misses');
    const kraken = service.getStatus().venues.find((v) => v.id === 'kraken');
    assert.equal(kraken.ok, false);
  });

  it('clearAlerts keeps open episodes and dismiss marks one alert', async () => {
    const { service, setBooks } = makeService({ configOverrides: { closeAfterPolls: 1 } });
    setBooks(SLIPPED);
    await service.forcePoll();
    await service.forcePoll();
    const [first] = service.getAlerts({ status: 'open' });
    assert.equal(service.dismissAlert(first.id), true);
    assert.equal(service.dismissAlert('missing'), false);
    service.clearAlerts();
    assert.ok(service.getAlerts().every((a) => a.status === 'open'));
    setBooks(HEALTHY);
    await service.forcePoll();
    service.clearAlerts();
    assert.equal(service.getAlerts().length, 0);
  });

  it('does nothing while disabled', async () => {
    const { service, writes } = makeService({ configOverrides: { enabled: false } });
    await service.forcePoll();
    service.start();
    assert.equal(service.getStatus().running, false);
    assert.equal(service.getStatus().pollCount, 0);
    assert.equal(writes.length, 0);
  });

  it('exposes no order-placing surface', () => {
    const { service } = makeService();
    for (const name of Object.keys(service)) assert.doesNotMatch(name, /order|place|buy|sell|trade/i);
  });
});

describe('arbitrage config', () => {
  it('validates updates and rejects unknown or out-of-range keys', () => {
    assert.deepEqual(validateArbitrageConfigUpdate({ enabled: true, alertMinNetBps: 25, venues: { kraken: { takerFeeBps: 26 } } }), {
      value: { enabled: true, alertMinNetBps: 25, venues: { kraken: { takerFeeBps: 26 } } },
      errors: [],
    });
    const { errors } = validateArbitrageConfigUpdate({ pollIntervalMs: 10, venues: { binance: {} }, quoteCurrencies: ['cad'], placeOrders: true });
    assert.equal(errors.length, 4, errors.join('; '));
  });

  it('merges per-venue updates and clamps hand-edited values', () => {
    let stored = { global: { arbitrage: { pollIntervalMs: 5, venues: { kraken: { takerFeeBps: -1 } } } } };
    const { getArbitrageConfig, updateArbitrageConfig } = createArbitrageSettings({
      loadConfig: () => stored,
      mutateConfig: (fn) => { const next = JSON.parse(JSON.stringify(stored)); fn(next); stored = next; return next; },
    });
    let config = getArbitrageConfig();
    assert.equal(config.pollIntervalMs, ARBITRAGE_DEFAULTS.pollIntervalMs);
    assert.equal(config.venues.kraken.takerFeeBps, ARBITRAGE_DEFAULTS.venues.kraken.takerFeeBps);

    updateArbitrageConfig({ venues: { kraken: { enabled: false } } });
    updateArbitrageConfig({ venues: { kraken: { takerFeeBps: 26 } } });
    config = getArbitrageConfig();
    assert.equal(config.venues.kraken.enabled, false);
    assert.equal(config.venues.kraken.takerFeeBps, 26);
    assert.equal(config.venues.coinbase.enabled, true);
  });
});
