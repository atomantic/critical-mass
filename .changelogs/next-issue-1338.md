# Remove dead code in adapters, chart buffer, size optimizer and backtest engine

Deleted symbols with no readers anywhere in src, engines, shared, scripts, tests or admin: the unused Gemini WebSocket URL constants and never-read socket state, `getBaseCurrency` in the Crypto.com adapter, `clearAdapterCache`, `clearChartDataBuffer`, the backtest `netFeePercent` local, and the identity `calculateTotalStepMultiplier` helper (its call sites now use the step count directly). No behavior change.
