// @ts-check
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { createArbitrageService } = require('../src/arbitrage/arbitrage-service');
const { createArbitrageSettings, validateArbitrageConfigUpdate, ARBITRAGE_DEFAULTS } = require('../src/config-settings/arbitrage');
const { tradeEvents } = require('../src/trade-events');
const registerArbitrageRoutes = require('../src/routes/arbitrage-routes');

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

const makeService = ({ configOverrides = {}, markets = MARKETS, fx = null, usePublicSources = false, savedState = null } = {}) => {
  let books = HEALTHY;
  let fail = false;
  const source = {
    id: 'kraken',
    label: 'Kraken',
    minRequestSpacingMs: 0,
    parity: [],
    listMarkets: async () => markets,
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
    referenceFx: { enabled: Boolean(fx), refreshMs: 3_600_000 },
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
    readJSON: () => savedState,
    writeJSON: (file, state) => writes.push({ file, state: JSON.parse(JSON.stringify(state)) }),
    DATA_DIR: os.tmpdir(),
    getArbitrageConfig: () => config,
    sources: usePublicSources ? undefined : { kraken: source },
    sleep: async () => {},
    fetchReferenceFx: async () => fx || {},
  });
  return {
    service,
    config,
    emitted,
    writes,
    setBooks: (next) => { books = next; },
    setFail: (value) => { fail = value; },
  };
};

const configEndpoint = (service, config) => {
  let handler;
  registerArbitrageRoutes({
    get: () => {},
    post: () => {},
    delete: () => {},
    put: (route, callback) => {
      assert.equal(route, '/api/arbitrage/config');
      handler = callback;
    },
  }, {
    arbitrageService: service,
    getArbitrageConfig: () => config,
    updateArbitrageConfig: ({ venues, ...updates }) => {
      Object.assign(config, updates);
      for (const [id, patch] of Object.entries(venues || {})) Object.assign(config.venues[id], patch);
    },
  });
  return (body) => handler({ body }, { json: (result) => assert.equal(result.success, true) }, (err) => { throw err; });
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
    assert.match(ping.message, /^ARBITRAGE Kraken: buy BTC via BTC\/CAD, sell via BTC\/USD/);
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

  it('silently closes a disabled venue immediately and requires fresh confirmation after re-enabling it', async (t) => {
    capture = captureTradeEvents();
    const { service, config, emitted, writes, setBooks } = makeService();
    t.after(() => service.stop());
    const update = configEndpoint(service, config);
    setBooks(SLIPPED);
    await service.forcePoll();
    await service.forcePoll();
    const [open] = service.getAlerts({ status: 'open' });

    await update({ pollIntervalMs: 30_000 });
    assert.equal(service.getAlerts({ status: 'open' })[0].id, open.id, 'an interval change keeps the episode open');
    await update({ venues: { kraken: { enabled: false } } });
    const [closed] = service.getAlerts({ status: 'closed' });
    assert.equal(closed.id, open.id);
    assert.equal(closed.closeReason, 'venue disabled');
    assert.ok(closed.closedAt);
    assert.equal(service.getStatus().openOpportunities, 0);
    assert.equal(service.getSnapshot().venues.kraken, undefined);
    assert.equal(writes.at(-1).state.alerts[0].closeReason, 'venue disabled');
    assert.ok(emitted.some(({ event, payload }) => event === 'arbitrage:alert' && payload.closeReason === 'venue disabled'));
    assert.deepEqual(capture.events.map(({ type }) => type), ['arbitrage_opportunity']);
    const writeCount = writes.length;
    await service.forcePoll();
    assert.equal(writes.length, writeCount);

    await update({ venues: { kraken: { enabled: true } } });
    await service.forcePoll();
    assert.equal(service.getStatus().openOpportunities, 0);
    await service.forcePoll();
    assert.notEqual(service.getAlerts({ status: 'open' })[0].id, open.id);
  });

  it('preserves episodes during maintenance and closes them silently when the monitor is disabled', async () => {
    capture = captureTradeEvents();
    const { service, config, writes, setBooks } = makeService();
    setBooks(SLIPPED);
    await service.forcePoll();
    await service.forcePoll();

    service.stop({ preserveAlerts: true });
    assert.equal(service.getStatus().openOpportunities, 1);
    await configEndpoint(service, config)({ enabled: false });

    assert.equal(service.getStatus().running, false);
    assert.equal(service.getStatus().openOpportunities, 0);
    assert.equal(writes.at(-1).state.alerts[0].closeReason, 'monitor stopped');
    assert.deepEqual(capture.events.map(({ type }) => type), ['arbitrage_opportunity']);
  });

  it('closes persisted open episodes even when starting with the monitor already disabled', () => {
    const { service, writes } = makeService({
      configOverrides: { enabled: false },
      savedState: { alerts: [{ venue: 'kraken', status: 'open', type: 'opportunity' }] },
    });
    service.start();
    assert.equal(service.getStatus().openOpportunities, 0);
    assert.equal(writes[0].state.alerts[0].closeReason, 'monitor stopped');
  });

  it('closes open episodes when the running monitor stops', async (t) => {
    capture = captureTradeEvents();
    const { service, writes, setBooks } = makeService();
    t.after(() => service.stop());
    service.start();
    setBooks(SLIPPED);
    await service.forcePoll();
    await service.forcePoll();
    assert.equal(service.getStatus().openOpportunities, 1);

    service.stop();
    assert.equal(service.getStatus().running, false);
    assert.equal(service.getStatus().openOpportunities, 0);
    assert.equal(writes.at(-1).state.alerts[0].closeReason, 'monitor stopped');
    assert.deepEqual(capture.events.map(({ type }) => type), ['arbitrage_opportunity']);
  });

  it('rebuilds Gemini market discovery when quote currencies change through the config route', async (t) => {
    let symbolRequests = 0;
    const oldRequestStarted = Promise.withResolvers();
    const releaseOldRequest = Promise.withResolvers();
    t.mock.method(globalThis, 'fetch', async (url) => {
      const { hostname, pathname } = new URL(url);
      assert.equal(hostname, 'api.gemini.com');
      if (pathname === '/v1/symbols') {
        symbolRequests++;
        if (symbolRequests === 3) {
          oldRequestStarted.resolve();
          await releaseOldRequest.promise;
        }
        return Response.json(['btcusd', 'btcgusd']);
      }
      assert.match(pathname, /^\/v1\/book\/btc(?:usd|gusd)$/);
      return Response.json({ bids: [{ price: '95990', amount: '2' }], asks: [{ price: '96010', amount: '2' }] });
    });
    const { service, config } = makeService({
      usePublicSources: true,
      configOverrides: {
        quoteCurrencies: ['USD'],
        venues: { gemini: { enabled: true, takerFeeBps: 40 } },
      },
    });
    t.after(() => service.stop());
    const update = configEndpoint(service, config);
    const pairs = () => service.getSnapshot().venues.gemini.analysis.pairs.map(({ pair }) => pair).sort();
    await service.forcePoll();
    assert.deepEqual(pairs(), ['BTC/USD']);

    await update({ quoteCurrencies: ['USD', 'GUSD'] });
    await service.forcePoll();
    assert.deepEqual(pairs(), ['BTC/GUSD', 'BTC/USD']);
    assert.equal(symbolRequests, 2);

    await update({ pollIntervalMs: 30_000 });
    await service.forcePoll();
    assert.deepEqual(pairs(), ['BTC/GUSD', 'BTC/USD']);
    assert.equal(symbolRequests, 2, 'an unrelated update keeps the market cache');

    await update({ quoteCurrencies: ['USD'] });
    const oldPoll = service.forcePoll();
    try {
      await Promise.race([oldRequestStarted.promise, oldPoll.then(() => assert.fail('a quote removal must refresh markets'))]);
      await update({ quoteCurrencies: ['USD', 'GUSD'] });
      await service.forcePoll();
      assert.deepEqual(pairs(), ['BTC/GUSD', 'BTC/USD']);
    } finally {
      releaseOldRequest.resolve();
      await oldPoll;
    }
    await service.forcePoll();
    assert.deepEqual(pairs(), ['BTC/GUSD', 'BTC/USD']);
    assert.equal(symbolRequests, 4, 'the old request cannot replace the current cache');
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

  it('raises watch-only alerts only for a no-round-trip pair whose book is tight', async () => {
    capture = captureTradeEvents();
    const markets = [...MARKETS, { symbol: 'BTCEUR', base: 'BTC', quote: 'EUR' }];
    const { service, setBooks } = makeService({ markets, fx: { EUR: 1.1 } });
    // Gemini-shaped: an empty-looking EUR book with a ~27% spread whose bid
    // still converts above the USD ask. No alert of any kind.
    setBooks({ ...HEALTHY, BTCEUR: { bids: [[59_051, 0.02]], asks: [[77_600, 0.02]] } });
    await service.forcePoll();
    await service.forcePoll();
    assert.equal(service.getAlerts().length, 0, JSON.stringify(service.getAlerts()));

    // A tight EUR book 8% rich is worth watching, but never as an opportunity.
    setBooks({ ...HEALTHY, BTCEUR: { bids: [[59_000, 1]], asks: [[59_050, 1]] } });
    await service.forcePoll();
    await service.forcePoll();
    const open = service.getAlerts({ status: 'open' });
    assert.deepEqual(open.map((a) => `${a.type}:${a.pair}`), ['dislocation:BTC/EUR']);
    assert.equal(open[0].severity, 'info');
    assert.match(capture.events.find(({ type }) => type === 'arbitrage_dislocation').message, /^Price dislocation \(watch only\) Kraken BTC\/EUR/);
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
