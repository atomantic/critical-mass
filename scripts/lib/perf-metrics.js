'use strict';
// Aggregation for the route-load / idle-network audit (issue #935).
// Pure functions: no I/O, no raw bodies or credentials are ever stored.

const ID_SEGMENT = /^(?:[0-9a-f]{8,}|\d{4,}|[A-Za-z0-9_-]{20,})$/i;

/** Redact a request URL to a stable `METHOD /path?key&key` pattern (values dropped). */
function redactEndpoint(method, rawUrl) {
  const url = new URL(rawUrl, 'http://redacted.invalid');
  const parts = url.pathname.split('/').filter(Boolean).map((seg, i, all) => {
    if (all[0] === 'api' && i === 1) return ':exchange';
    return ID_SEGMENT.test(seg) ? ':id' : seg;
  });
  const keys = [...new Set(url.searchParams.keys())].sort();
  return `${method.toUpperCase()} /${parts.join('/')}${keys.length ? `?${keys.join('&')}` : ''}`;
}

/** Collects HTTP and websocket observations on a monotonic millisecond clock. */
function createCollector(now = () => performance.now()) {
  const http = [];
  const ws = [];
  return {
    http,
    ws,
    now,
    recordHttp({ method, url, start, end, status, wireBytes = null, decodedBytes = 0, phase }) {
      http.push({ endpoint: redactEndpoint(method, url), start, end, status, wireBytes, decodedBytes, phase });
    },
    recordWs({ event, at, bytes, direction = 'in', phase }) {
      ws.push({ event, at, bytes, direction, phase });
    },
  };
}

/** Maximum number of simultaneously in-flight requests for one endpoint. */
function maxOverlap(rows) {
  const edges = rows.flatMap(r => [[r.start, 1], [r.end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of edges) { cur += d; max = Math.max(max, cur); }
  return max;
}

/** Aggregate observations in `phase` per redacted endpoint / event. */
function aggregate(collector, phase, windowMs) {
  const perMinute = bytes => (windowMs > 0 ? Math.round(bytes * 60000 / windowMs) : null);
  const httpRows = collector.http.filter(r => r.phase === phase);
  const byEndpoint = {};
  for (const r of httpRows) (byEndpoint[r.endpoint] ||= []).push(r);
  const http = Object.fromEntries(Object.entries(byEndpoint).map(([endpoint, rows]) => {
    const wire = rows.every(r => r.wireBytes != null) ? rows.reduce((s, r) => s + r.wireBytes, 0) : null;
    const decoded = rows.reduce((s, r) => s + r.decodedBytes, 0);
    return [endpoint, {
      count: rows.length,
      wireBytes: wire,
      decodedBytes: decoded,
      maxOverlap: maxOverlap(rows),
      maxDecodedBytes: Math.max(...rows.map(r => r.decodedBytes)),
      decodedBytesPerMinute: perMinute(decoded),
    }];
  }));
  const wsRows = collector.ws.filter(r => r.phase === phase);
  const byEvent = {};
  for (const r of wsRows) (byEvent[`${r.direction} ${r.event}`] ||= []).push(r);
  const ws = Object.fromEntries(Object.entries(byEvent).map(([event, rows]) => {
    const bytes = rows.reduce((s, r) => s + r.bytes, 0);
    return [event, { count: rows.length, bytes, bytesPerMinute: perMinute(bytes) }];
  }));
  const totalBytes = [...Object.values(http).map(h => h.decodedBytes), ...Object.values(ws).map(w => w.bytes)]
    .reduce((s, n) => s + n, 0);
  return { phase, windowMs, http, ws, totalBytesPerMinute: perMinute(totalBytes) };
}

/** True when the endpoint pattern was requested at all during the phase. */
const requested = (summary, pattern) => Object.keys(summary.http).some(k => pattern.test(k));

/** Overall verdict: UNVERIFIED wins over PASS, FAIL wins over everything. */
function verdict(checks, unverifiedReasons = []) {
  if (checks.some(c => !c.ok)) return 'FAIL';
  return unverifiedReasons.length ? 'UNVERIFIED' : 'PASS';
}

module.exports = { redactEndpoint, createCollector, maxOverlap, aggregate, requested, verdict };
