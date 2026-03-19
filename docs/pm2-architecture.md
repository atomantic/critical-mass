# PM2 Process Architecture

## Overview

Critical-mass runs as 5 PM2 processes: a thin API gateway and 3 isolated engine processes plus the admin UI.

```
┌──────────────────────────────────┐
│   critical-mass (:5563)          │  API gateway, Socket.IO hub, admin UI,
│   server.js                      │  DCA scheduler, backup, notifier, settings
└────────┬─────────┬───────────────┘
    IPC WS    IPC WS
         │         │
┌────────┴──┐  ┌───┴────────────┐
│ cm-coinbase│  │ cm-gemini      │
│ IPC :5570  │  │ IPC :5571      │
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
| Coinbase | `coinbase-engine.js` | `EXCHANGE_NAME=coinbase` | 5570 | Regime engine, market data, chart buffer |
| Gemini | `gemini-engine.js` | `EXCHANGE_NAME=gemini` | 5571 | Thin wrapper around coinbase-engine |
| Crypto.com | `cryptocom-engine.js` | `EXCHANGE_NAME=cryptocom` | 5574 | Thin wrapper around coinbase-engine |

## Gateway Routing

- Regime/exchange routes → IPC proxy via `exchangeIPCMap` (per-exchange routing)
- Settings backup/restore → sends `stop-all` to all engines in parallel
- Socket.IO events → forwarded via IPC clients

## PM2 Config

Defined in `ecosystem.config.cjs` with 5 processes: `critical-mass` (gateway), `critical-mass-coinbase`, `critical-mass-gemini`, `critical-mass-cryptocom`, `critical-mass-ui`.
