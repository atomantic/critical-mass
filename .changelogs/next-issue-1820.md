# Unreleased — Merge delayed chart cache loads with newer live samples

## Bug Fixes

- Merge delayed chart cache responses in `useChartDataBuffer` with live accumulated samples in timestamp order, ensuring samples received during hydration are preserved for price, ATR, and regime history.
- Give live samples deterministic priority on equal timestamps and deduplicate adjacent identical regime modes while preserving boundary changes.
- Ensure empty cache arrays do not discard live data, expired data older than retention window is filtered out, and entries are bounded by `MAX_POINTS`.
- Preserve stable callback identity for `initializeFromCache` to prevent re-triggering caller load effects.
