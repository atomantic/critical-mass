# PM2 Process Architecture

## Overview

Critical-mass runs as 5 PM2 processes: a thin API gateway and 3 isolated engine processes plus the admin UI.

```
┌──────────────────────────────────┐
│   critical-mass (:5570)          │  API gateway, realtime hub, admin UI,
│   server.js                      │  DCA scheduler, backup, notifier, settings
└────────┬─────────┬───────────────┘
    IPC WS    IPC WS
         │         │
┌────────┴──┐  ┌───┴────────────┐
│ cm-coinbase│  │ cm-gemini      │
│ IPC :5572  │  │ IPC :5573      │
│            │  │                │
│ Regime eng │  │ Thin wrapper   │
│ Market data│  │ around coinbase│
│ Chart buf  │  │                │
│ CB/Gem WS  │  │                │
└────────────┘  └────────────────┘

┌────────────┐  ┌────────────┐
│ cm-cryptocom│  │ cm-ui      │
│ IPC :5574   │  │ Vite dev   │
└─────────────┘  └────────────┘
```

## IPC Layer (`src/ipc/`)

| File | Purpose |
|---|---|
| `ipc-protocol.js` | Message types, serialization, UUID correlation |
| `ws-server.js` | Owned RFC 6455 loopback WebSocket server (handshake, framing, close handshake, Origin refusal) |
| `ipc-server.js` | WS server for engine processes (request/response) |
| `ipc-client.js` | WS client for gateway (auto-reconnect, backoff) over Node's global `WebSocket` |
| `realtime-proxy.js` | Engine-side stand-in for the gateway realtime bus, forwarding over IPC |

IPC listens only on loopback and accepts process clients only. Every WebSocket
upgrade containing an `Origin` header is rejected before connection admission,
including same-origin, `null`, and empty values. The gateway IPC client sends no
Origin header. All three engine wrappers use this shared server gate; loopback
binding alone does not prevent browser access.

## Admin realtime bus (`src/realtime-bus.js`)

The admin UI receives live events over one WebSocket per tab at `/realtime` on
every gateway listener (primary, extra hosts and late Tailscale binds), using the
same RFC 6455 code as IPC. The upgrade is refused with 401 unless it carries an
operator session cookie or bearer password and, when an `Origin` header is
present, that origin is the gateway itself (same rule as session-cookie
mutations); it is refused with 503 while the gateway drains. Frames are JSON:
the server sends `{t:'open', id, pingInterval, pingTimeout}` and then
`{t:'event', e, p}` and `{t:'ping'}`; the client sends `{t:'sub'|'unsub', r}`
for the `coinbase`/`gemini`/`cryptocom`/`updown`/`sentinel` rooms,
`{t:'event', e, p}` for PM2 log commands, and `{t:'pong'}`. A client that misses
a heartbeat for 20 seconds is dropped. A password change closes every
connection; shutdown closes them with 1001. `admin/src/lib/realtime.js` is the
client: shared subscriptions re-sent after every reconnect, events queued while
disconnected, and 1–30 second exponential backoff.

## Engine Processes (`engines/`)

| Engine | File | Env | IPC Port | Notes |
|---|---|---|---|---|
| Coinbase | `coinbase-engine.js` | `EXCHANGE_NAME=coinbase` | 5572 | Regime engine, market data, chart buffer |
| Gemini | `gemini-engine.js` | `EXCHANGE_NAME=gemini` | 5573 | Thin wrapper around coinbase-engine |
| Crypto.com | `cryptocom-engine.js` | `EXCHANGE_NAME=cryptocom` | 5574 | Thin wrapper around coinbase-engine |

## Gateway Routing

- Regime/exchange routes → IPC proxy via `exchangeIPCMap` (per-exchange routing)
- Manual and scheduled backups → share `runBackup` and the restore maintenance lock. Engines pause and flush their writers, gateway services stop, and accepted writes drain before an archive is copied. Failure to confirm quiescence refuses the backup without pruning existing archives. The coordinator then resumes the previous writers; the manual backup UI reports any restart warnings alongside the created archive. A pause is never left ownerless: if the gateway's IPC connection closes, or its maintenance window expires, before `engine:backup-resume` arrives (a gateway crash, memory restart or drain-deadline exit mid-backup), the engine runs the same resume path itself, retrying while writers drain, so captured funds do not stay stopped until the engine process restarts (`src/engine-backup-window.js`). Backup and restore handlers remain tracked for gateway shutdown but are excluded from their own pending-write drain. Full archives and hourly fund-state snapshots flush their copied bytes (including manifests) and publication directories before reporting success or pruning older recovery points. A flush failure refuses publication and preserves older backups; directory flushes use the shared platform compatibility policy in `fsync-dir.js`.
- Settings restore → opens restore maintenance and sends `stop-all` to every **configured** engine in parallel. Each engine joins accepted IPC commands, cancels automatic starts, fences standalone market-data consumers, stops regime producers, and joins every tracked writer before its final state/ledger flush and cache invalidation. Chart-buffer save timers and cached histories are retired before acknowledgement too. Reads and config updates are refused during restore so they cannot reload stale in-memory ledgers; restored funds remain stopped in this process until explicitly started. A drain timeout returns a negative acknowledgement while engine cleanup continues; closing the gateway window cannot reopen intake until the accepted writers settle, final snapshots flush, and caches retire. The gateway requires a positive `{ success: true, stopped: [...] }` acknowledgement from each before any file is overwritten. A rejection, IPC timeout, disconnected client, negative or malformed reply blocks the restore (HTTP 409, `code: writers-not-quiesced`) with zero destination writes; `POST` body `{ "force": true }` is the explicit operator override for an engine that is already dead. While a restore runs, `src/restore-maintenance.js` holds an exclusive lock that 503s every mutating `/api` request and skips the DCA scheduler, and the gateway's own UpDown writer is stopped before the copy and restarted after so it reloads the restored state.
- Realtime bus events → forwarded via IPC clients

## Gateway health (`GET /api/health`)

Aggregation lives in `src/runtime-health.js`. The gateway enumerates `getConfiguredFunds()` and sends an explicit pair-scoped `regime:status` request (3 s timeout) per fund, unwraps the `{ success, running, status }` envelope and reads `status.health.mode`. The response keeps `engines.<name>` summaries and adds `funds.<exchange>.<pair>` (`status`, `mode`, `reason`, `isRunning`, `enabled`).

| Fund status | Source | Roll-up |
|---|---|---|
| `ok` | mode `ACTIVE` | healthy |
| `paused` / `stopped` | mode `PAUSED` / `STOPPED` | visible, **not** an outage |
| `safe` / `auth_denied` | mode `SAFE` / `AUTH_DENIED` | `degraded` |
| `error` | `success:false`, missing `status`, malformed reply, unknown mode, IPC rejection, startup `starting` / `retrying` / `blocked` | `degraded` |
| `timeout` / `unreachable` | probe timeout / IPC not connected | `degraded` |

An exchange summary shows its worst enabled fund (failure > paused > ok > stopped). Failures of disabled funds, exchanges with no configured funds (`unconfigured`) and exchanges with no enabled fund do not degrade the roll-up. UpDown is `ok` when running with a fresh price, `degraded` when running with `priceFresh:false` (`priceAgeMs` is exposed), `stopped` otherwise (optional). Sentinel is `degraded` on `unavailable`/`degraded` feeds. Overall `status` is `degraded` if any required service fails and `critical` when every required service is down or stopped and at least one failed.

Fund health and the selected exchange summary retain `startup` (`state`, `error`, `nextRetryAt`), or `null` when supervision is unavailable. A pending or failed start reports `error` with a startup reason and `isRunning:false`, even when the engine synthesizes `STOPPED` health or exposes an `ACTIVE` object before initialization finishes. This keeps auto-resume failures visible until a successful retry or an intentional stop; normal supervised `running` / `stopped` states still follow the engine's health mode.

## PM2 Config

Defined in `ecosystem.config.cjs` with 5 processes: `critical-mass` (gateway), `critical-mass-coinbase`, `critical-mass-gemini`, `critical-mass-cryptocom`, `critical-mass-ui`.

Native npm lifecycle commands use `scripts/pm2-stack.js`. They wait for the
gateway stop command and verify its stopped state before stopping any engine.
Start/restart recreates the stack to refresh environment settings, submits engine
starts before the gateway/UI, and saves only when all five report online. This
PM2 status check is not a fund-readiness or migration check; upgrades still use
the explicit procedure in [UPGRADE.md](../UPGRADE.md). Stop failures abort the
sequence, and unrelated PM2 processes are left untouched. In Docker,
`pm2-runtime` runs as a child of `docker-entrypoint.sh`; see
[Docker ordered stop](#docker-ordered-stop).

## Development topology

`npm run dev` (`scripts/dev.js`) supervises only two children: the gateway (`server.js`) and the Vite UI. The engines are separate PM2 processes that the gateway connects to as IPC clients; with none running, regime commands return HTTP 503 (`Engine unavailable: IPC not connected`). Start them first with `pm2 start ecosystem.config.cjs --only critical-mass-coinbase,critical-mass-gemini,critical-mass-cryptocom` and remove them with `pm2 delete` on the same names. Do not run the production `critical-mass`/`critical-mass-ui` processes at the same time (port conflict). Engines auto-resume configured funds, so use a separate development configuration with disabled or dry-run funds.

## Gateway startup order

The gateway binds every HTTP listener (`bindGatewayListeners` in
`src/gateway-listen.js`) before it starts anything with side effects: engine
IPC connections, the UpDown and Sentinel writers, the notifier, the backup and
DCA schedulers and the immediate DCA check. A port another gateway already owns
therefore exits with code 1 and a single `failed to bind` log line, with no
state file rewritten, no engine attached, no scheduled buy and no notification
sent — the gateway-side counterpart of the engines' IPC-bind-first rule
(issue #816). Routes and services are constructed before the bind so a request
admitted immediately afterwards finds them. `tests/gateway-startup-order.test.js`
runs the production start block against that contract.

## Gateway shutdown grace period

The gateway handles SIGTERM and SIGINT through one drain coordinator. It stops
admitting HTTP requests and realtime client commands, cancels the DCA and backup timers,
and stops the local producers (UpDown, Sentinel, log tails), which save their own
state, before it waits for accepted request handlers and scheduled DCA cycles. A
deadline exit therefore never skips the producers' final save, and UpDown's startup
lock wait, which only its stop cancels, cannot hold the drain. Producers are stopped
again after the drain in case drained work restarted one. A failed teardown step
(a producer that cannot persist, an IPC disconnect) is reported and exits 1, but
every later step, the drain and the notifier included, still runs. While a restore
holds the maintenance lock it owns UpDown and Sentinel (and keeps them stopped after
an incomplete rollback), so shutdown leaves them alone rather than persisting
pre-restore memory over restored files. An aborted HTTP client does not cancel the
handler's ownership.
IPC remains connected through that drain; queued and already-sending Telegram
notifications then settle before IPC, the realtime bus and every HTTP listener close.

The internal deadline is **30 seconds** (`SHUTDOWN_TIMEOUT_MS` in
`src/gateway-shutdown.js`). Deadline expiry or a teardown failure exits with code
1; it does not clear placement intents or other durable trading recovery state.
Repeated signals share the same drain and deadline. Normal completion exits 0.

The gateway's PM2 `kill_timeout` is **35000 ms** in `ecosystem.config.cjs`. Keep any
supervisor/container stop grace longer than that. The supplied Docker Compose
configuration uses `stop_grace_period: 70s` (see
[Docker ordered stop](#docker-ordered-stop)); standalone Docker runs need
`docker stop --time 70`. For an ordered whole-stack
restart, drain the gateway before stopping exchange engine processes so admitted
IPC operations can finish; stopping all engines simultaneously cannot provide
that dependency guarantee. The exchange engines (`critical-mass-coinbase`, `-gemini`, `-cryptocom`) set
`kill_timeout: 25000` (`ENGINE_KILL_TIMEOUT_MS`), above their 15 s in-process
force-exit watchdog (`SHUTDOWN_WATCHDOG_MS` in `engines/coinbase-engine.js`), which in
turn outlasts the 10 s bounded wait for in-flight fill handlers that
`regime-engine` `stop()` performs before saving state (`FILL_DRAIN_MS` in `src/engine-locks.js`).
PM2's 1600 ms default would SIGKILL an engine mid state-save. Required ordering:
in-process deadline < PM2 `kill_timeout`, and Docker `stop_grace_period` (70 s)
> gateway `kill_timeout` + engine `kill_timeout` (35 s + 25 s, the ordered
worst case, plus margin). `tests/pm2-kill-timeout.test.js` enforces it.

### Docker ordered stop

`pm2-runtime`'s own SIGTERM handler deletes every app concurrently, which would
signal the gateway and all engines in the same tick and refuse an admitted
command with `engine-shutting-down`. `docker-entrypoint.sh` therefore runs
`pm2-runtime` as a child (not `exec`) and traps SIGTERM/SIGINT. On the signal it
runs `node scripts/pm2-stack.js stop` (gateway stop, verified stopped, then the
engines, using the in-container `pm2` CLI) and only then signals `pm2-runtime`
and waits for it. If the ordered stop fails, `pm2-runtime` is still signaled so
the container does not hang. The image copies `scripts/pm2-stack.js` for this
purpose. The worst case is 35 s + 25 s = 60 s, hence the 70 s grace; Umbrel
deployments should likewise use at least `70s`.

`scripts/docker-stop-order-smoke-test.sh` verifies this order with a Docker
engine: it runs the real entrypoint against stub `pm2-runtime`/`pm2-stack.js`,
`docker stop`s it, and asserts gateway stopped → engines stopped → `pm2-runtime`
SIGTERM with exit code 0 (it fails if the entrypoint reverts to `exec pm2-runtime`).

The gateway deadline bounds its own lifetime even
when an exchange or transport hangs.
