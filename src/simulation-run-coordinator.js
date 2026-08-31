// @ts-check
/**
 * Owns lifecycle admission for expensive read-only simulation jobs.
 *
 * A resource key identifies a fund, while a request key records the normalized
 * request that owns it. Keeping both makes duplicate/busy responses stable and
 * guarantees cleanup on fulfilled and rejected promises.
 */

class SimulationRunCoordinator {
  constructor({ maxActive = 2, refreshCooldownMs = 30_000, now = () => Date.now() } = {}) {
    this.maxActive = maxActive;
    this.refreshCooldownMs = refreshCooldownMs;
    this.now = now;
    this.active = new Map();
    this.lastRefresh = new Map();
  }

  start({ resourceKey, requestKey, forceRefresh = false }, run) {
    const active = this.active.get(resourceKey);
    if (active) {
      return {
        accepted: false,
        status: 409,
        code: 'SIMULATION_ALREADY_RUNNING',
        error: 'A simulation is already running for this fund',
        retryAfter: 1,
        activeRequestKey: active.requestKey,
      };
    }
    if (this.active.size >= this.maxActive) {
      return {
        accepted: false,
        status: 429,
        code: 'SIMULATION_CAPACITY_REACHED',
        error: 'Simulation capacity is currently full',
        retryAfter: 1,
      };
    }
    const now = this.now();
    const lastRefresh = this.lastRefresh.get(resourceKey);
    if (forceRefresh && lastRefresh !== undefined && now - lastRefresh < this.refreshCooldownMs) {
      return {
        accepted: false,
        status: 429,
        code: 'SIMULATION_REFRESH_COOLDOWN',
        error: 'A fresh market-data simulation was requested too recently',
        retryAfter: Math.max(1, Math.ceil((this.refreshCooldownMs - (now - lastRefresh)) / 1000)),
      };
    }
    if (forceRefresh) this.lastRefresh.set(resourceKey, now);

    const promise = Promise.resolve().then(run);
    this.active.set(resourceKey, { requestKey, startedAt: now });
    const cleanup = () => this.active.delete(resourceKey);
    promise.then(cleanup, cleanup);
    return { accepted: true, promise, requestKey };
  }

  status(resourceKey) {
    return this.active.get(resourceKey) || null;
  }
}

module.exports = { SimulationRunCoordinator };
