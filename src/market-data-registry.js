// @ts-check
/**
 * Market data service registry
 *
 * One standalone market data service per fund, keyed by `${exchange}::${pair}`,
 * plus the start / stop / fence lifecycle around it. Moved verbatim out of
 * market-data-service (issue #1975), which builds the one registry and
 * re-exports its functions, so callers keep importing them from there.
 *
 * The start de-dup map, the per-key stop generation and the retiring set
 * exist so that two fill-ledger writers never run on one fund: each service
 * persists its whole in-memory ledger, so a second writer erases the first
 * one's fills.
 *
 * A factory rather than module state: it takes the service factory and
 * `isSupported` from market-data-service instead of requiring them, which
 * keeps the two modules acyclic and gives every load of market-data-service
 * its own registry, bound to that load's collaborators.
 */

/**
 * @param {Object} deps
 * @param {(exchange: string, pair?: string) => any} deps.createMarketDataService
 * @param {(exchange: string) => boolean} deps.isSupported
 * @param {(exchange: string, pair?: string) => string} deps.serviceKey
 */
const createMarketDataRegistry = ({ createMarketDataService, isSupported, serviceKey }) => {
  // Store active market data services keyed by `${exchange}::${pair}`
  const marketDataServices = new Map();

  // In-flight start() promises keyed the same way. startMarketDataService does a
  // check-then-await-then-set, so two overlapping calls (e.g. the engine startup
  // loop's fire-and-forget start vs the regime:stop handler's start) could both
  // pass the has() check and both create a service — the loser overwritten in the
  // map and leaked forever (live WS feed + 60s interval + a second fillLedger
  // whose persist() fights the winner). De-duping on this map closes the gap.
  const startingMarketDataServices = new Map();

  // Monotonic per-key cancellation counter (issue #415). stopMarketDataService /
  // stopAllMarketDataServices are synchronous — their callers (the engine's
  // lifecycle-close callback, the regime:start handover, the SIGTERM path) can't
  // await — so they cannot wait for an in-flight start to settle. Instead they
  // bump the generation for the key; a start that finds the generation moved
  // since it began knows a stop raced it, tears its own service down and never
  // registers it. Without this, a stop issued inside the seconds-long start()
  // window (WS connect + REST candle fetch) is a silent no-op and the fund ends
  // up with two fill-ledger writers on the same file, each persist() erasing the
  // other's ingested fills. Never deleted: resetting a key's generation could
  // un-cancel a start still in flight, and the key set is bounded by fund count.
  const stopGenerations = new Map();

  /**
   * Cancel any in-flight start for this key.
   * @param {string} key
   */
  const bumpStopGeneration = (key) => {
    stopGenerations.set(key, (stopGenerations.get(key) || 0) + 1);
  };

  // Stopped services whose accepted order work may still be finishing, keyed
  // the same way (issue #1008). stop() fences new ledger writes immediately,
  // but a REST fetch already in flight settles later; fenceMarketDataService
  // joins these before a replacement writer may load the ledger.
  const retiringServices = new Map();

  /**
   * Stop a service and keep it joinable until its order work has drained.
   * @param {string} key
   * @param {Object} service
   */
  const retireService = (key, service) => {
    service.stop?.();
    if (!service.whenIdle) return;
    if (!retiringServices.has(key)) retiringServices.set(key, new Set());
    const retiring = retiringServices.get(key);
    retiring.add(service);
    service.whenIdle().finally(() => {
      retiring.delete(service);
      if (!retiring.size && retiringServices.get(key) === retiring) retiringServices.delete(key);
    });
  };

  /** Default bound for a writer-handover join; matches the engine write drain. */
  const FENCE_TIMEOUT_MS = 30_000;

  /**
   * Start market data service for a fund (exchange + pair).
   * @param {string} exchange
   * @param {string} [pair] - Pair name; defaults to the exchange's default pair
   */
  const startMarketDataService = async (exchange, pair) => {
    // Only supported for certain exchanges
    if (!isSupported(exchange)) {
      return { success: false, error: `Market data service not supported for ${exchange}` };
    }

    const key = serviceKey(exchange, pair);
    if (marketDataServices.has(key)) {
      return { success: true, message: 'Already running' };
    }
    // Generation this start is bound to. If a stop bumps it before start()
    // settles, the service below is torn down instead of registered.
    const gen = stopGenerations.get(key) || 0;
    // Coalesce concurrent starts onto a single in-flight promise so the
    // check-then-act window can't spawn two services for the same fund — but
    // never onto a start a stop has already cancelled: that one resolves
    // {success:false} and registers nothing, so coalescing onto it would leave
    // the fund with no market data service at all (the regime:stop → start
    // handover does exactly stop-then-start on one key). Starting fresh is safe
    // because the cancelled start stops its own service and never publishes it.
    const inFlight = startingMarketDataServices.get(key);
    if (inFlight && inFlight.gen === gen) {
      return inFlight.promise;
    }

    // service.start() → createFillLedger → load() can throw on cold-start
    // corruption. The throw happens inside start(), not the factory — so
    // the wrap inside start() converts it to a {success:false} return
    // (see "Create fill ledger" in start()). Callers (notably the
    // regime:stop IPC handler that starts a standalone service for
    // handover) get a graceful failure they can decide on instead of an
    // unhandled rejection that aborts their flow.
    const service = createMarketDataService(exchange, pair);
    const startPromise = (async () => {
      const result = await service.start();
      if (!result.success) {
        // Failed start must not leak its WS feed / interval timers.
        retireService(key, service);
        return result;
      }
      if ((stopGenerations.get(key) || 0) !== gen) {
        // A stop landed while we were connecting. Tear this service down and
        // leave the settled map untouched — publishing it now would hand the
        // fund a second fill-ledger writer nothing can reach to stop again.
        retireService(key, service);
        return { success: false, error: 'stopped during start' };
      }
      marketDataServices.set(key, service);
      return result;
    })().finally(() => {
      // Only clear our own entry: a cancelled start can be superseded by a
      // newer one for the same key while it is still settling.
      if (startingMarketDataServices.get(key)?.promise === startPromise) {
        startingMarketDataServices.delete(key);
      }
    });

    startingMarketDataServices.set(key, { promise: startPromise, gen, service });
    return startPromise;
  };

  /**
   * Stop market data service for a fund (exchange + pair). Also cancels a start
   * still in flight for that fund, so the service it is building is torn down
   * rather than registered after this returns (issue #415).
   */
  const stopMarketDataService = (exchange, pair) => {
    const key = serviceKey(exchange, pair);
    // Bump unconditionally: the settled map can be empty while a start is still
    // connecting, and the generation is the only way that start learns it lost.
    bumpStopGeneration(key);
    // Stop a still-connecting service now rather than when its start settles:
    // start() keeps ingesting (handover gap recovery) after its last await.
    const starting = startingMarketDataServices.get(key);
    if (starting?.service) retireService(key, starting.service);
    const service = marketDataServices.get(key);
    if (service) {
      retireService(key, service);
      marketDataServices.delete(key);
    }
  };

  /**
   * Stop a fund's standalone service and wait until it can no longer write its
   * fill ledger (issue #1008): every start still in flight has settled and every
   * order handler it accepted has finished. Only then may a replacement owner
   * (the regime engine) load the ledger — each instance persists its whole
   * in-memory Map, so a writer that outlives the handover erases the
   * replacement's fills on its next persist.
   * @param {string} exchange
   * @param {string} [pair]
   * @param {number} [timeoutMs]
   * @returns {Promise<{drained: boolean}>} drained:false when the join timed out
   */
  const fenceMarketDataService = async (exchange, pair, timeoutMs = FENCE_TIMEOUT_MS) => {
    const key = serviceKey(exchange, pair);
    const starting = startingMarketDataServices.get(key)?.promise;
    stopMarketDataService(exchange, pair);
    const joined = (async () => {
      // The fenced start may still be mid-await (candles, gap recovery); let it
      // observe the stop and settle before joining the order work it queued.
      await starting?.catch(() => {});
      await Promise.allSettled([...(retiringServices.get(key) || [])].map((service) => service.whenIdle()));
      return true;
    })();
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const expired = new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
    const drained = await Promise.race([joined, expired]);
    clearTimeout(timer);
    return { drained: drained === true };
  };

  /**
   * Get market data service for a fund (exchange + pair).
   */
  const getMarketDataService = (exchange, pair) => {
    return marketDataServices.get(serviceKey(exchange, pair));
  };

  /**
   * Stop all market data services, including any whose start is still in flight.
   */
  const stopAllMarketDataServices = () => {
    // Cancel in-flight starts too, so SIGTERM can't leave a WS feed and a 60s
    // metrics interval behind holding the event loop open after shutdown.
    for (const key of new Set([...marketDataServices.keys(), ...startingMarketDataServices.keys()])) {
      bumpStopGeneration(key);
    }
    for (const [key, { service }] of startingMarketDataServices) {
      if (service) retireService(key, service);
    }
    for (const [key, service] of marketDataServices) {
      retireService(key, service);
    }
    marketDataServices.clear();
  };

  return {
    getActiveMarketDataFunds: () => [...new Set([...marketDataServices.keys(), ...startingMarketDataServices.keys()])]
      .map((key) => { const [exchange, pair] = key.split('::'); return { exchange, pair }; }),
    drainMarketDataStarts: () => Promise.allSettled([...startingMarketDataServices.values()].map((entry) => entry.promise)),
    startMarketDataService,
    stopMarketDataService,
    fenceMarketDataService,
    getMarketDataService,
    stopAllMarketDataServices,
  };
};

module.exports = { createMarketDataRegistry };
