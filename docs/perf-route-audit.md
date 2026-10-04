# Route-load and idle-network audit

`scripts/perf-route-audit.js` measures the Transactions -> Config navigation and an idle window,
aggregated per redacted endpoint (`GET /api/:exchange/regime/fills?page&pageSize...`) and websocket event.

```
node scripts/perf-route-audit.js [--idle-seconds 60] [--poll-seconds 10] [--exchange coinbase] [--json]
CM_PERF_TOKEN=<operator password> node scripts/perf-route-audit.js --base-url http://127.0.0.1:5570
```

Default mode starts an isolated synthetic gateway (`scripts/lib/perf-fixture.js`) on an ephemeral loopback
port with a generated 30,000-fill ledger in a temp directory, served through the real paged read view
(`src/transactions-regime-query.js`). The directory and sockets are removed on exit; production services
and data are never touched. No credentials, records or response bodies are stored: only counts, bytes,
timings and redacted endpoint patterns.

Reported: time to useful content, wire bytes (when `content-length` is known), decoded bytes, request count,
max overlap, idle bytes/minute, and websocket events/bytes per event.

Checks: bounded page rows/bytes, no overlapping requests, no fill-history read on Config, Config's stable
read not repeated, no polling or websocket traffic after Transactions unmounts, and (fixture only) that a
reconnect restores exactly the fund view's subscription or Overview's all-exchange set.

Exit codes: 0 PASS, 1 FAIL, 2 UNVERIFIED (e.g. `--base-url` without `CM_PERF_TOKEN`).

Limits: this is a protocol-level replay using the UI's request shapes and cadence (guarded by a source
test), not a rendered browser pass; time to useful content is the fills response time, not paint time.
