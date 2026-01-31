# Changelog

All notable changes to this project will be documented in this file.

## [2.2.1] - 2026-01-31

### Fixed
- Hardcoded "BTC" in order consolidation logs now dynamically uses actual trading pair currency (e.g., CRO)

## [2.2.0] - 2025-01-31

### Fixed
- Crypto.com API big integer precision loss - order IDs exceeding JavaScript's MAX_SAFE_INTEGER are now preserved as strings
- Crypto.com order status parsing - corrected field access path for nested `order_info` response structure
- Crypto.com order field mappings updated to use `cumulative_quantity`, `cumulative_value`, and `cumulative_fee`

### Added
- Full timestamp support in transaction logs with automatic schema migration for existing data
- Transactions UI now displays full datetime (YYYY-MM-DD HH:MM:SS) when timestamp data is available

### Changed
- Force IPv4-first DNS resolution (`--dns-result-order=ipv4first`) for API stability
- TSV parser preserves Timestamp column as string alongside Date

### Chores
- Added `.playwright-mcp` to .gitignore

## [2.1.1] - 2025-01-25

### Fixed
- Add 1hour interval type to estimated end date calculation

## [2.1.0] - 2025-01-23

### Added
- Crypto.com exchange adapter
- Optimizer enhancements
- UI improvements

## [2.0.0] - 2025-01-22

### Added
- P&L metrics (unrealized $, unrealized %, realized)
