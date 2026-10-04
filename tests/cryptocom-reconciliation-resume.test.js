// @ts-check
/**
 * Crypto.com reconciliation scans resume past the per-step page budget
 * (issue #966).
 *
 * `getReconciliationFills` used to share `getOrderFills`' one-shot 64-page
 * budget, so every history longer than 64 days failed (one request per day,
 * even when empty) and the periodic drift sweep restarted at the newest day
 * forever. These tests drive the real adapter with synthetic `private/get-trades`
 * responses on a virtual clock: pacing delays advance the clock instead of
 * sleeping, while every other timer (the request abort timeout) stays real.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createCryptocomAdapter } = require('../src/adapters/cryptocom/api');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-03T12:00:00.000Z');

let originalFetch;
let originalDateNow;
let originalSetTimeout;
let virtualNow;
let tempDir;

beforeEach(() => {
  originalFetch = global.fetch;
  originalDateNow = Date.now;
  originalSetTimeout = global.setTimeout;
  virtualNow = NOW;
  Date.now = () => virtualNow;
  // Pacing (200ms) and retry (750ms × n) waits advance the virtual clock and
  // resolve on the next tick; the 30s request-abort timer stays real.
  // @ts-ignore - test shim
  global.setTimeout = (fn, ms = 0, ...args) => {
    if (ms > 0 && ms <= 5000) {
      virtualNow += ms;
      return originalSetTimeout(fn, 0, ...args);
    }
    return originalSetTimeout(fn, ms, ...args);
  };
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-recon-resume-'));
});

afterEach(() => {
  global.fetch = originalFetch;
  Date.now = originalDateNow;
  global.setTimeout = originalSetTimeout;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const createAdapter = () => {
  const keysPath = path.join(tempDir, 'cryptocom.json');
  fs.writeFileSync(keysPath, JSON.stringify({ apiKey: 'test-api-key', apiSecret: 'test-api-secret' }));
  return createCryptocomAdapter(keysPath);
};

const ok = (data) => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ code: 0, result: { data } }) });

/**
 * Install a fake trade endpoint. `respond(window, index)` returns the rows
 * for one request (or throws / returns a Response-like object to fail).
 * @param {(w: {startNs: bigint, endNs: bigint, at: number}, index: number) => any} respond
 */
const installTrades = (respond) => {
  /** @type {{startNs: bigint, endNs: bigint, at: number}[]} */
  const requests = [];
  global.fetch = async (_url, options = {}) => {
    const body = JSON.parse(options.body);
    assert.equal(body.method, 'private/get-trades');
    const w = { startNs: BigInt(body.params.start_time), endNs: BigInt(body.params.end_time), at: virtualNow };
    requests.push(w);
    const out = await respond(w, requests.length - 1);
    if (out && typeof out.text === 'function') return out;
    return ok(out);
  };
  return requests;
};

const msToNs = (ms) => BigInt(ms) * 1_000_000n;

const trade = (id, ms) => ({
  trade_id: id, order_id: `order-${id}`, side: 'BUY', traded_price: '0.1', traded_quantity: '10',
  fees: '-0.01', fee_instrument_name: 'USDT', create_time: ms, taker_side: 'MAKER',
});

/** Assert the accepted windows tile [startNs, endNs] exactly — no gap, no overlap. */
const assertContiguous = (windows, startNs, endNs) => {
  let cursor = endNs;
  for (const w of windows) {
    assert.equal(w.endNs, cursor, 'each accepted window starts where the previous one ended');
    cursor = w.startNs;
  }
  assert.equal(cursor, startNs, 'the walk reaches the fixed lower bound');
};

describe('Crypto.com resumable reconciliation scan (issue #966)', () => {
  for (const days of [65, 252]) {
    it(`completes an empty ${days}-day history without the page-budget failure`, async () => {
      const requests = installTrades(() => []);
      const startMs = NOW - days * DAY_MS;
      const fills = await createAdapter().getReconciliationFills('CRO-USDT', startMs);
      assert.deepEqual(fills, []);
      assert.equal(requests.length, days, 'one paced request per daily window');
      assertContiguous(requests, msToNs(startMs), msToNs(NOW));
      for (let i = 1; i < requests.length; i++) {
        assert.ok(requests[i].at - requests[i - 1].at >= 200, 'every page stays paced, across step boundaries too');
      }
    });
  }

  it('includes a sparse fill older than 64 days exactly once', async () => {
    const oldMs = NOW - 200 * DAY_MS + 1234;
    const recentMs = NOW - 3 * DAY_MS;
    installTrades((w) => {
      const rows = [];
      // Inclusive bounds on both edges: return the row from any window that
      // touches it, so a boundary duplicate would show up without dedup.
      if (msToNs(oldMs) >= w.startNs && msToNs(oldMs) <= w.endNs) rows.push(trade('old-trade', oldMs));
      if (msToNs(recentMs) >= w.startNs && msToNs(recentMs) <= w.endNs) rows.push(trade('recent-trade', recentMs));
      return rows;
    });
    const fills = await createAdapter().getReconciliationFills('CRO-USDT', NOW - 252 * DAY_MS);
    assert.deepEqual(fills.map(f => f.tradeId).sort(), ['old-trade', 'recent-trade']);
    const old = fills.find(f => f.tradeId === 'old-trade');
    assert.equal(old.timestamp, oldMs);
    assert.equal(old.fee, 0.01);
  });

  it('splits a saturated bucket safely even when the split spans step boundaries', async () => {
    const denseDayEnd = NOW - 10 * DAY_MS;
    const denseDayStart = denseDayEnd - DAY_MS;
    const hourNs = msToNs(60 * 60 * 1000);
    const requests = installTrades((w) => {
      const inDense = w.startNs < msToNs(denseDayEnd) && w.endNs > msToNs(denseDayStart);
      if (inDense && w.endNs - w.startNs > hourNs) {
        return Array.from({ length: 100 }, (_, i) => trade(`sat-${w.startNs}-${i}`, Number(w.startNs / 1_000_000n)));
      }
      if (inDense) return [trade(`dense-${w.startNs}`, Number(w.startNs / 1_000_000n))];
      return [];
    });
    const progress = [];
    const fills = await createAdapter().getReconciliationFills('CRO-USDT', NOW - 20 * DAY_MS, {
      stepPages: 3,
      onProgress: (p) => progress.push(p),
    });
    const accepted = requests.filter((w, i) => !(requests[i + 1] && requests[i + 1].endNs === w.endNs));
    assertContiguous(accepted, msToNs(NOW - 20 * DAY_MS), msToNs(NOW));
    assert.ok(fills.length >= 24, 'the dense day is recovered through subdivided windows');
    assert.ok(fills.every(f => f.tradeId.startsWith('dense-')), 'saturated (capped) responses are never accepted');
    assert.equal(new Set(fills.map(f => f.tradeId)).size, fills.length);
    for (let i = 1; i < progress.length; i++) {
      assert.ok(progress[i].fraction >= progress[i - 1].fraction, 'progress never moves backwards');
    }
    assert.equal(progress.at(-1).fraction, 1);
    assert.equal(progress.at(-1).done, true);
  });

  it('retries a failed page in place: fixed bounds, same cursor, no skipped window', async () => {
    const startMs = NOW - 100 * DAY_MS;
    let failuresLeft = 2;
    const requests = installTrades((w, index) => {
      if (index === 70 && failuresLeft > 0) {
        failuresLeft--;
        throw new Error('socket hang up');
      }
      if (index === 71 && failuresLeft > 0) {
        failuresLeft--;
        return { ok: false, status: 503, statusText: 'Service Unavailable', text: async () => '{}' };
      }
      return [trade(`t-${w.startNs}`, Number(w.startNs / 1_000_000n))];
    });
    const fills = await createAdapter().getReconciliationFills('CRO-USDT', startMs);
    assert.equal(requests.length, 102, '100 windows plus two retried pages');
    assert.deepEqual(requests[71], { ...requests[70], at: requests[71].at }, 'the retry re-requests the same window');
    assert.deepEqual(requests[72], { ...requests[70], at: requests[72].at });
    const accepted = requests.filter((_, i) => i !== 70 && i !== 71);
    assertContiguous(accepted, msToNs(startMs), msToNs(NOW));
    assert.equal(fills.length, 100);
    assert.equal(requests.at(-1).startNs, msToNs(startMs), 'the lower bound never moves');
  });

  it('rejects (never returns a partial result) after too many consecutive failures', async () => {
    installTrades((_w, index) => {
      if (index >= 80) throw new Error('ECONNRESET');
      return [trade(`t-${index}`, NOW)];
    });
    await assert.rejects(
      createAdapter().getReconciliationFills('CRO-USDT', NOW - 120 * DAY_MS),
      /Crypto\.com API network: ECONNRESET/,
    );
  });

  it('keeps authentication rejections visible instead of retrying them', async () => {
    const requests = installTrades((_w, index) => {
      if (index === 66) return { ok: false, status: 401, statusText: 'Unauthorized', text: async () => '{}' };
      return [];
    });
    await assert.rejects(
      createAdapter().getReconciliationFills('CRO-USDT', NOW - 100 * DAY_MS),
      err => err.status === 401,
    );
    assert.equal(requests.length, 67);
  });

  it('still fails closed when a window is saturated at 1ns', async () => {
    installTrades((w) => Array.from({ length: 100 }, (_, i) => trade(`x-${w.startNs}-${i}`, NOW)));
    await assert.rejects(
      createAdapter().getReconciliationFills('CRO-USDT', NOW - 70 * DAY_MS),
      err => err.incompleteFills === true && /saturated at 1ns/.test(err.message),
    );
  });

  it('stops between requests when the caller aborts', async () => {
    const controller = new AbortController();
    const requests = installTrades((_w, index) => {
      if (index === 90) controller.abort();
      return [];
    });
    await assert.rejects(
      createAdapter().getReconciliationFills('CRO-USDT', NOW - 252 * DAY_MS, { signal: controller.signal }),
      err => err.name === 'AbortError',
    );
    assert.equal(requests.length, 91);
  });
});
