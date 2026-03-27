# Development Plan

For completed work, see [DONE.md](./DONE.md).

## Next Up

1. **Per-engine memory tuning** — Profile each PM2 process under load, set `max_memory_restart` per-engine in ecosystem.config.cjs (currently uniform 512M)
3. **Sentinel service test coverage** — Unit tests for classifier and feed-poller to catch parsing edge cases

## Backlog

- [ ] Upgrade Vite build toolchain (5.4 -> 8.x) and `@vitejs/plugin-react` (4.7 -> 6.x)
- [ ] Complete `src/paths.js` adoption — file exists but is not imported in most modules (15+ `path.join(__dirname, ...)` remain)
- [ ] Complete `src/routes/async-handler.js` adoption — file exists but is not imported in any route

## Future / Ideas

- Split `regime-engine.js` (4,095 lines) into orchestrator + specialized modules
- Split `config-utils.js` (1,012 lines) into domain-specific config services
- Extract sub-components from `RegimeDashboard.jsx` (2,983 lines)
- Extract shared base from `order-executor.js` / `dry-run-executor.js`
- Split `state-tracker.js` persistence from domain logic

## Documentation

- [PM2 Architecture](./docs/pm2-architecture.md)
- [Fill Ledger Sell Linkage](./docs/fill-ledger-sell-linkage.md)
- [UpDown Evaluation](./docs/UPDOWN-EVALUATION.md)
- [Cryptofeed Evaluation](./docs/cryptofeed-evaluation.md)
