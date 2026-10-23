# Issue #1719: Extract global configuration settings services

Notifications, aggressiveness presets, backups, and Sentinel settings now live in cohesive domain services behind the existing `config-utils` API. Explicit reader and writer dependencies preserve the shared config write lock, nested merges, bounds and defaults, sparse preset overrides, and diagnostics without introducing eager circular imports.
