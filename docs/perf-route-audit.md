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
listener recovery. The actual hooks use client-side listeners on a shared websocket, rather than room
subscriptions. The shell intentionally retains one regime consumer and one trade/toast consumer across tabs;
its five-second status and thirty-second summary refreshes, and global engine broadcasts, remain visible in
the measured idle traffic. These baseline costs are reported, not hidden or asserted to be zero. Synthetic
engine reads/feed do not exercise exchange APIs, order execution, realistic market timing or production latency.

Exit codes: **0 PASS**, **1 FAIL** for assertion failures, **2 UNVERIFIED** for a missing browser, missing or
incomplete fixture/session, navigation timeout or a shortened idle window. External/production URLs are
unsupported, so the runner cannot enroll, edit configuration or force reconnects on a live installation.
A PASS applies only to the isolated fixture and this machine; it is not a production performance claim.

The older `node scripts/perf-route-audit.js` command is a supplemental protocol replay. It accepts an
isolated miniature gateway or `CM_PERF_TOKEN` with `--base-url`, but does not render the shell or exercise
real engine IPC. Even when its assertions succeed it now reports **UNVERIFIED** for end-to-end performance.
Its HTTP response timing must not be interpreted as useful-content paint time.
