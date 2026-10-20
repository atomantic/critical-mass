# Retire destructive stale operator scripts

Removed `restore-state.js`, which could replace the complete fill ledger with only today's filled buys, and `rename-btc-to-asset.js`, whose one-shot rewrite is obsolete. The historical audit marks the restore script as retired.
