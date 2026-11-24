// @ts-check
/**
 * Keyless BTC market feed for the gateway: 1s bars from Coinbase BTC-USD trades
 * and the Crypto.com BTC index. Public data only, independent of which funds are
 * open. It places no orders; the Up dip paper books read the index through
 * subscribeIndex.
 */

const path = require('path');
const { createWebSocketFeed } = require('../websocket-feed');
const { createContextLogger } = require('../logger');
const { createSecondBars } = require('./second-bars');
const { createIndexSeries } = require('./index-series');
const indexClient = require('./index-client');
const indexHistory = require('./index-history');

const ROOM = 'btc-feed';
const EMIT_INTERVAL_MS = 250;
const WATCHDOG_INTERVAL_MS = 1000;
/** No accepted event for this long means the source is stalled, whatever its socket says. */
const STALL_MS = 30_000;
const MIN_RECREATE_MS = 60_000;
const DROPPED_WARN_COUNT = 50;
/** Drops this soon after connect are the replayed snapshot, not a clock problem. */
const SNAPSHOT_GRACE_MS = 5_000;

/**
 * @param {{to: (room: string) => {emit: (event: string, payload: any) => void}}} io - realtime bus
 * @param {{DATA_DIR: string, now?: () => number, createTradeFeed?: Function, createIndexClient?: Function, createIndexHistory?: Function, logger?: any}} deps
 */
const createBtcFeedService = (io, {
  DATA_DIR,
  now = Date.now,
  createTradeFeed = createWebSocketFeed,
  createIndexClient = indexClient.createIndexClient,
  createIndexHistory = indexHistory.createIndexHistory,
  logger = createContextLogger({ module: 'btc-feed' }),
}) => {
  const bars = createSecondBars({ now });
  const index = createIndexSeries({ now });
  const history = createIndexHistory({ dir: path.join(DATA_DIR, 'btc-feed'), logger });
  let running = false;
  let statusChanged = false;
  /** @type {NodeJS.Timeout[]} */
  let timers = [];
  /** @type {Set<(sample: {value: number, timestamp: number}) => void>} */
  const indexSubscribers = new Set();
  let connectedAt = 0;
  let droppedSinceConnect = 0;
  let acceptedSinceConnect = false;

  /**
   * One socket owner. Every callback is bound to a generation, so a replaced or
   * stopped instance can no longer change anything. Replacing builds a new
   * instance because a lifecycle's disconnect() turns its reconnect off for good.
   */
  const createSource = ({ name, build, onConnect, onDisconnect, getLastEventAt }) => {
    let generation = 0;
    let instance = null;
    let connected = false;
    let openedAt = 0;
    let recreatedAt = -Infinity;

    const setConnected = (value) => {
      if (connected === value) return;
      connected = value;
      statusChanged = true;
    };
    const close = () => {
      generation++;
      const old = instance;
      instance = null;
      if (connected) onDisconnect();
      setConnected(false);
      try {
        old?.disconnect();
      } catch (err) {
        logger.error(`❌ [btc-feed] ${name} disconnect failed: ${err.message}`, { error: err.message });
      }
    };
    const open = () => {
      const mine = ++generation;
      const guard = (fn) => (...args) => { if (mine === generation) fn(...args); };
      openedAt = now();
      try {
        instance = build(guard, {
          onConnect: guard(() => { onConnect(); setConnected(true); }),
          onDisconnect: guard(() => { onDisconnect(); setConnected(false); }),
        });
        instance.connect();
      } catch (err) {
        logger.error(`❌ [btc-feed] ${name} could not be opened: ${err.message}`, { error: err.message });
      }
    };
    const check = () => {
      const at = now();
      if (at - Math.max(openedAt, getLastEventAt() ?? 0) < STALL_MS || at - recreatedAt < MIN_RECREATE_MS) return;
      logger.info(`🔄 [btc-feed] ${name} delivered nothing for ${STALL_MS / 1000}s — reconnecting`, { source: name });
      recreatedAt = at;
      close();
      open();
    };
    return { open, close, check, getStatus: () => ({ connected, lastEventAt: getLastEventAt() }) };
  };

  const handleTrade = (trade) => {
    const result = bars.addTrade(trade);
    if (result === 'accepted') {
      acceptedSinceConnect = true;
      return;
    }
    if (acceptedSinceConnect || now() - connectedAt < SNAPSHOT_GRACE_MS || ++droppedSinceConnect !== DROPPED_WARN_COUNT) return;
    logger.warn(`⚠️ [btc-feed] First ${DROPPED_WARN_COUNT} Coinbase trades since connect were all dropped (last: ${result}) — check this machine's clock`, { result });
  };

  const handleIndex = (sample) => {
    if (!index.add(sample)) return;
    try {
      history.add(sample);
    } catch (err) {
      logger.warn(`⚠️ [btc-feed] Index history rejected a value: ${err.message}`, { error: err.message });
    }
    for (const notify of indexSubscribers) {
      try {
        notify(sample);
      } catch (err) {
        logger.warn(`⚠️ [btc-feed] Index subscriber failed: ${err.message}`, { error: err.message });
      }
    }
  };

  const coinbase = createSource({
    name: 'Coinbase trades',
    build: (guard, callbacks) => createTradeFeed('coinbase', { productId: 'BTC-USD', publicOnly: true, onTrade: guard(handleTrade), ...callbacks }),
    onConnect: () => {
      connectedAt = now();
      droppedSinceConnect = 0;
      acceptedSinceConnect = false;
      bars.markConnected();
    },
    onDisconnect: () => bars.markDisconnected(),
    getLastEventAt: bars.getLastAcceptedAt,
  });
  const indexSource = createSource({
    name: 'Crypto.com index',
    build: (guard, callbacks) => createIndexClient({ onValue: guard(handleIndex), ...callbacks }),
    onConnect: () => {},
    onDisconnect: () => {},
    getLastEventAt: index.getLastAcceptedAt,
  });
  const sources = [coinbase, indexSource];

  const getStatus = () => ({ running, now: now(), coinbase: coinbase.getStatus(), index: indexSource.getStatus() });

  const emitChanges = () => {
    const changedBars = bars.drainChanged();
    const changedIndex = index.drainChanged();
    if (!changedBars.length && !changedIndex.length && !statusChanged) return;
    statusChanged = false;
    try {
      io.to(ROOM).emit('btc-feed:update', { bars: changedBars, index: changedIndex, status: getStatus() });
    } catch (err) {
      logger.warn(`⚠️ [btc-feed] Update could not be sent: ${err.message}`, { error: err.message });
    }
  };

  const start = () => {
    if (running) return;
    running = true;
    for (const source of sources) source.open();
    timers = [
      setInterval(emitChanges, EMIT_INTERVAL_MS),
      setInterval(() => { for (const source of sources) source.check(); }, WATCHDOG_INTERVAL_MS),
    ];
    for (const timer of timers) timer.unref?.();
  };

  const stop = () => {
    if (!running) return;
    running = false;
    for (const timer of timers) clearInterval(timer);
    timers = [];
    for (const source of sources) source.close();
  };

  /** @param {number} seconds */
  const getWindow = (seconds) => ({ bars: bars.getBars(seconds), index: index.getValues(seconds), status: getStatus() });

  /** Accepted index values as they arrive. @returns {() => void} unsubscribe */
  const subscribeIndex = (fn) => {
    indexSubscribers.add(fn);
    return () => { indexSubscribers.delete(fn); };
  };

  const latest = (value, at) => (value === undefined || at === null ? null : { value, at });

  /** The last accepted price of each source and when it arrived, however old. */
  const getLatest = () => ({
    coinbase: latest(bars.getLastPrice(), bars.getLastAcceptedAt()),
    index: latest(index.getLastValue(), index.getLastAcceptedAt()),
  });

  return { start, stop, getStatus, getWindow, subscribeIndex, getLatest, pauseHistory: () => history.pause(), resumeHistory: () => history.resume() };
};

module.exports = { createBtcFeedService };
