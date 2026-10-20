## Fixes

- Preserve operator-effective base settings across image upgrades by recording a private baseline and pinning changed defaults before gateway/engine startup. Pins survive subsequent settings saves; concurrent writers serialize and corrupt configuration fails closed.
- Keep portable backups free of raw base secrets and restore the destination baseline alongside its reconstructed override. See `UPGRADE.md` for first-upgrade limits, adopting new defaults, and interrupted-write recovery.
