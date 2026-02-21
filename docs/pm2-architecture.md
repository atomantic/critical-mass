# PM2 Process Architecture

## Overview

Critical-mass runs as 6 PM2 processes: a thin API gateway and 4 isolated engine processes plus the admin UI.

```
┌──────────────────────────────────┐
│   critical-mass (:5563)          │  API gateway, Socket.IO hub, admin UI,
│   server.js                      │  DCA scheduler, backup, notifier, settings
└────────┬─────────┬───────────────┘
    IPC WS    HTTP proxy + IPC WS
         │         │
┌────────┴──┐  ┌───┴──────────────────┐
│ cm-coinbase│  │ cm-kalshi            │
│ IPC :5570  │  │ HTTP :5572, IPC :5573│
│            │  │                      │
│ Regime eng │  │ Kalshi sim engine    │
│ Market data│  │ Hedge engine         │
│ Chart buf  │  │ Own CB public WS     │
│ CB/Gem WS  │  │ Own CB adapter       │
└────────────┘  └──────────────────────┘

┌────────────┐  ┌────────────┐  ┌────────────┐
│ cm-gemini  │  │ cm-cryptocom│  │ cm-ui      │
│ IPC :5571  │  │ IPC :5574   │  │ Vite dev   │
└────────────┘  └─────────────┘  └────────────┘
```

## IPC Layer (`src/ipc/`)

| File | Purpose |
|---|---|
| `ipc-protocol.js` | Message types, serialization, UUID correlation |
| `ipc-server.js` | WS server for engine processes (request/response) |
| `ipc-client.js` | WS client for gateway (auto-reconnect, backoff) |
| `socket-io-proxy.js` | Drop-in `io` replacement forwarding over IPC |
| `http-proxy.js` | Lightweight HTTP reverse proxy (Node built-in) |

## Engine Processes (`engines/`)

| Engine | File | Env | IPC Port | Notes |
|---|---|---|---|---|
| Coinbase | `coinbase-engine.js` | `EXCHANGE_NAME=coinbase` | 5570 | Regime engine, market data, chart buffer |
| Gemini | `gemini-engine.js` | `EXCHANGE_NAME=gemini` | 5571 | Thin wrapper around coinbase-engine |
| Kalshi | `kalshi-engine.js` | — | 5573 | Own Express (:5572), Kalshi sim engine + hedge |
| Crypto.com | `cryptocom-engine.js` | `EXCHANGE_NAME=cryptocom` | 5574 | Thin wrapper around coinbase-engine |

## Gateway Routing

- `/api/kalshi/*` and `/api/hedge/*` → HTTP reverse proxy to Kalshi engine (:5572)
- Regime/exchange routes → IPC proxy via `exchangeIPCMap` (per-exchange routing)
- Settings backup/restore → sends `stop-all` to all engines in parallel
- Socket.IO events → forwarded via IPC clients

## PM2 Config

Defined in `ecosystem.config.cjs` with 6 processes: `critical-mass` (gateway), `critical-mass-kalshi`, `critical-mass-coinbase`, `critical-mass-gemini`, `critical-mass-cryptocom`, `critical-mass-ui`.
