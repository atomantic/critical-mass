# PM2 Process Architecture

## Overview

Critical-mass runs as 5 PM2 processes: a thin API gateway and 3 isolated engine processes plus the admin UI.

```
┌──────────────────────────────────┐
│   critical-mass (:5570)          │  API gateway, Socket.IO hub, admin UI,
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
| `ipc-server.js` | WS server for engine processes (request/response) |
| `ipc-client.js` | WS client for gateway (auto-reconnect, backoff) |
| `socket-io-proxy.js` | Drop-in `io` replacement forwarding over IPC |

## Engine Processes (`engines/`)

| Engine | File | Env | IPC Port | Notes |
|---|---|---|---|---|
| Coinbase | `coinbase-engine.js` | `EXCHANGE_NAME=coinbase` | 5572 | Regime engine, market data, chart buffer |
| Gemini | `gemini-engine.js` | `EXCHANGE_NAME=gemini` | 5573 | Thin wrapper around coinbase-engine |
| Crypto.com | `cryptocom-engine.js` | `EXCHANGE_NAME=cryptocom` | 5574 | Thin wrapper around coinbase-engine |

## Gateway Routing

- Regime/exchange routes → IPC proxy via `exchangeIPCMap` (per-exchange routing)
- Settings backup/restore → sends `stop-all` to every **configured** engine in parallel and requires a positive `{ success: true, stopped: [...] }` acknowledgement from each before any file is overwritten. A rejection, IPC timeout, disconnected client, negative or malformed reply blocks the restore (HTTP 409, `code: writers-not-quiesced`) with zero destination writes; `POST` body `{ "force": true }` is the explicit operator override for an engine that is already dead. While a restore runs, `src/restore-maintenance.js` holds an exclusive lock that 503s every mutating `/api` request and skips the DCA scheduler, and the gateway's own UpDown writer is stopped before the copy and restarted after so it reloads the restored state.
- Socket.IO events → forwarded via IPC clients

## PM2 Config

Defined in `ecosystem.config.cjs` with 5 processes: `critical-mass` (gateway), `critical-mass-coinbase`, `critical-mass-gemini`, `critical-mass-cryptocom`, `critical-mass-ui`.

## Gateway shutdown grace period

The gateway handles SIGTERM and SIGINT through one drain coordinator. It stops
admitting HTTP requests and Socket.IO commands, cancels the DCA and backup timers,
and waits for accepted request handlers and scheduled DCA cycles before stopping
local producers. An aborted HTTP client does not cancel the handler's ownership.
IPC remains connected through that drain; queued and already-sending Telegram
notifications then settle before IPC, Socket.IO and every HTTP listener close.

The internal deadline is **30 seconds** (`SHUTDOWN_TIMEOUT_MS` in
`src/gateway-shutdown.js`). Deadline expiry or a teardown failure exits with code
1; it does not clear placement intents or other durable trading recovery state.
Repeated signals share the same drain and deadline. Normal completion exits 0.

The gateway's PM2 `kill_timeout` is **35000 ms** in `ecosystem.config.cjs`. Keep any
supervisor/container stop grace longer than that. The supplied Docker Compose
configuration uses `stop_grace_period: 40s`; standalone Docker runs need
`docker stop --time 40`. For an ordered whole-stack
restart, drain the gateway before stopping exchange engine processes so admitted
IPC operations can finish; stopping all engines simultaneously cannot provide
that dependency guarantee. The gateway deadline bounds its own lifetime even
when an exchange or transport hangs.
