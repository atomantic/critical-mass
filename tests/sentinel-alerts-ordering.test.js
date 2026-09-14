// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { createSentinelService } = require('../src/sentinel/sentinel-service');

/**
 * Seed alerts via persisted state so getAlerts is exercised without polling.
 * Insertion order here is deliberately not publication order.
 */
const makeServiceWithAlerts = (seedAlerts) => {
  const io = { to: () => ({ emit: () => {} }) };
  const dir = path.join(os.tmpdir(), `cm-sentinel-order-${process.pid}`);
  const service = createSentinelService(io, {
    readJSON: (file) => (path.basename(file) === 'sentinel-state.json' ? { alerts: seedAlerts } : null),
    writeJSON: () => {},
    DATA_DIR: dir,
    getSentinelConfig: () => ({
      enabled: false,
      pollIntervalMs: 60_000,
      feeds: [],
      keywords: { critical: [], warning: [], info: [] },
      aiClassification: { enabled: false },
    }),
    fetchAllFeeds: async () => [],
  });
  return service;
};

describe('Sentinel getAlerts ordering', () => {
  it('returns alerts newest-first by publishedAt despite out-of-order insertion', () => {
    const service = makeServiceWithAlerts([
      {
        id: 'oldest',
        severity: 'info',
        publishedAt: '2026-08-12T14:04:06Z',
        detectedAt: '2026-09-14T10:00:00Z',
      },
      {
        id: 'newest',
        severity: 'warning',
        publishedAt: '2026-09-14T18:50:32Z',
        detectedAt: '2026-09-14T19:00:00Z',
      },
      {
        id: 'mid',
        severity: 'critical',
        publishedAt: '2026-08-26T13:35:50Z',
        detectedAt: '2026-09-14T11:00:00Z',
      },
      {
        id: 'missing-pub',
        severity: 'info',
        // no publishedAt — falls back to detectedAt (older than newest)
        detectedAt: '2026-09-01T12:00:00Z',
      },
      {
        id: 'bad-pub',
        severity: 'warning',
        publishedAt: 'not-a-date',
        detectedAt: 'also-bad',
      },
    ]);

    const ids = service.getAlerts().map((a) => a.id);
    assert.deepEqual(ids, ['newest', 'missing-pub', 'mid', 'oldest', 'bad-pub']);

    // Adjacent pairs must be non-increasing by publishedAt||detectedAt
    const alerts = service.getAlerts();
    for (let i = 0; i < alerts.length - 1; i++) {
      const a = alerts[i];
      const b = alerts[i + 1];
      const aMs = new Date(a.publishedAt || a.detectedAt).getTime();
      const bMs = new Date(b.publishedAt || b.detectedAt).getTime();
      const aKey = Number.isFinite(aMs) ? aMs : Number.NEGATIVE_INFINITY;
      const bKey = Number.isFinite(bMs) ? bMs : Number.NEGATIVE_INFINITY;
      assert.ok(aKey >= bKey, `expected ${a.id} (>=${aKey}) before ${b.id} (${bKey})`);
    }
  });

  it('preserves newest-first order when filtering by severity', () => {
    const service = makeServiceWithAlerts([
      {
        id: 'crit-old',
        severity: 'critical',
        publishedAt: '2026-08-01T00:00:00Z',
        detectedAt: '2026-09-01T00:00:00Z',
      },
      {
        id: 'warn',
        severity: 'warning',
        publishedAt: '2026-09-10T00:00:00Z',
        detectedAt: '2026-09-10T01:00:00Z',
      },
      {
        id: 'crit-new',
        severity: 'critical',
        publishedAt: '2026-09-14T00:00:00Z',
        detectedAt: '2026-09-14T01:00:00Z',
      },
      {
        id: 'crit-bad-date',
        severity: 'critical',
        publishedAt: 'garbage',
        detectedAt: null,
      },
    ]);

    const critical = service.getAlerts({ severity: 'critical' });
    assert.deepEqual(critical.map((a) => a.id), ['crit-new', 'crit-old', 'crit-bad-date']);
    assert.ok(critical.every((a) => a.severity === 'critical'));
  });
});
