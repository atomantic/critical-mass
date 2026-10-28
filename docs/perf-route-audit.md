# Authenticated route-load and idle-network audit

Run the rendered protected shell against a disposable synthetic installation:

```sh
node scripts/perf-browser-audit.js --json > /tmp/cm-browser-performance.json
```

Requires installed root/admin dependencies and Chrome or Chromium. The runner finds common macOS/Linux
executables; set `CM_PERF_CHROME` to another installed executable. It never installs dependencies or downloads
a browser. Worktree dependency links are supported. A quick `--idle-seconds 1` run exercises navigation but
always reports **UNVERIFIED** rather than passing the 60-second performance requirement.

The runner builds a temporary copy of the actual UI, starts the actual gateway on an ephemeral loopback
port, and connects three real engine IPC servers with synthetic read handlers and telemetry. It generates
30,000 schema-valid fills per fund, including unique trade IDs, numeric timestamps and oversized detail
metadata, loaded by the real ledger reader from each temporary fund namespace, and four funds (including two on one exchange). Files,
auth hashes and the dedicated Chrome profile live in external OS temporary storage. No source configuration,
keys, operator browser profiles, live services or production state are used. The gateway child receives an
allowlist of environment variables and a generated fixture-only IPC secret, no caller credentials; public candle seeding and prediction startup are disabled,
and outbound gateway HTTP is refused except its fixture IPC ports. Only fixture processes are stopped, with
a bounded forced termination fallback, and storage is removed on success or failure.

Enrollment consumes only the bootstrap credential generated in the temporary installation; no bootstrap
secret or password is inherited from the caller. Aggregate reads use the actual fill aggregate view.

The browser uses the real operator sign-in form with a randomly generated fixture-only password. After
sign-in, a cache-disabled cold Transactions navigation measures time until 100 real DOM rows and pagination
are ready, followed by two animation frames. The production ten-second polling interval runs at least once.
The scenario then clicks Config, settles its initial reads, and records at least 60 seconds of idle activity.
It tests the oversized server page cap, edits synthetic config through the authenticated API and checks a
remount reads the new value. It then visits a fund dashboard and Overview, forces a transport reconnect in
each, verifies listener counts and visible telemetry, and checks Overview removes its consumer on unmount.

Reports contain only aggregate redacted fetch/XHR endpoint patterns and websocket event patterns, request
counts/overlap, encoded/decoded response bytes, useful-content timing and idle bytes/minute. HTTP encoded
bytes come from CDP `encodedDataLength` (including response headers); decoded bytes come from `dataLength`.
Websocket bytes are **frame payload bytes**, split by inbound/outbound event or protocol traffic. Websocket
framing, compression and TCP/TLS wire overhead are unavailable and are not claimed as measured. No headers,
cookies, passwords, personal records, screenshots, traces or raw bodies are saved in artifacts. Temporary
response parsing retains only page counts, projection checks and config-invalidation booleans.

Assertions cover bounded page/DOM rows and compact projection, no eager detail transfer, no fill-history
hydration or Transactions polling after Config navigation, stable reference reads, and exact visible consumer
listener recovery. The current admin uses client-side listeners and subscribes to per-fund or all-fund
status rooms on the shared websocket. Transactions and Config have no status listeners and receive no
unneeded status frames in the fixture; Dashboard and Overview each have one visible status listener and
its corresponding subscription, including after reconnect. The shell no longer polls `/regime/status`:
the gateway sends a compact `regime:state` frame (running, dry-run, lifecycle) to every socket only when
a fund's state changes, and the shell re-reads status once per fund, on socket reconnect and when the tab
becomes visible. The Config idle window asserts no status requests and at most one small state frame.
Other events, protocol frames and the remaining HTTP polling can still contribute to idle traffic. Legacy clients that do not opt into scoped status continue
to receive global status broadcasts. Synthetic engine reads/feed do not exercise exchange APIs, order
execution, realistic market timing or production latency.

Exit codes: **0 PASS**, **1 FAIL** for assertion failures, **2 UNVERIFIED** for a missing browser, missing or
incomplete fixture/session, navigation timeout or a shortened idle window. External/production URLs are
unsupported, so the runner cannot enroll, edit configuration or force reconnects on a live installation.
A PASS applies only to the isolated fixture and this machine; it is not a production performance claim.

## Read-only measurement in an existing operator session

Live measurements require an already authorized operator session for the installation under study. Use the operator's existing browser tab and its built-in Network and Performance panels; do not sign in through the fixture runner, enroll an installation, edit configuration, or force a reconnect. If no authorized session is available, leave the live results **UNVERIFIED**. Do not attempt to obtain one by reusing credentials or changing the installation.

1. In DevTools Network, enable **Preserve log** and **Disable cache**, clear the request list, then navigate to Transactions once. Start timing at navigation and stop when the useful content is visible and stable: record the first moment the transaction rows and their controls can be used. Do not include account-specific values in notes.
2. Record request count and total transferred and decoded response bytes, grouped by redacted endpoint pattern and resource type. Replace identifiers and query values with placeholders (for example, `/api/funds/{id}/fills?page={n}`). Record overlapping requests as the maximum number in flight and the longest overlap interval. Use the Network summary for transfer size; use response sizes only as decoded-byte estimates when DevTools does not expose decoded totals.
3. Navigate to Config and let its initial requests settle. Keep the session idle for at least 60 seconds. Record the same HTTP aggregates for the idle interval.
4. For websocket traffic, record only frame direction/event pattern and aggregate payload bytes and frame counts during the idle interval. DevTools' websocket Messages view can be sampled manually; do not copy message contents. Separate inbound, outbound, and protocol/control frames where visible. Do not describe payload totals as wire bytes: framing, compression, and transport overhead are not included.
5. Report the browser/version, date, route sequence, idle duration, cache setting, request counts, transfer/decoded totals by redacted endpoint pattern, maximum overlap, useful-content time, and websocket aggregate totals. Note missing metrics as **UNVERIFIED** and distinguish estimates from directly displayed totals. Never save or share HAR files, request/response bodies, headers, cookies, screenshots, or traces because they may contain credentials or private records.

This procedure reports observations from one existing session; it does not make live changes or establish a production-wide baseline. The fixture runner above remains synthetic and cannot produce these live measurements. Recheck route and listener behavior before comparing measurements across revisions.

The older `node scripts/perf-route-audit.js` command is a supplemental protocol replay. It accepts an
isolated miniature gateway or `CM_PERF_TOKEN` with `--base-url`, but does not render the shell or exercise
real engine IPC. Even when its assertions succeed it now reports **UNVERIFIED** for end-to-end performance.
Its HTTP response timing must not be interpreted as useful-content paint time.
