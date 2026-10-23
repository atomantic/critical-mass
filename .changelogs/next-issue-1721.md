# Unreleased — Separate state persistence from position rules

## Improvements

- Extract DCA/regime file storage, placement intent persistence and locking, and corrupt-file quarantine from the compatible state-tracker facade; keep domain initialization and migrations in domain code.
- Preserve stored schemas, call-time fund paths, atomic writes, protected-field version fencing, and one shared owner for intent identity, retained IDs and deferred removals.
- Add regression coverage for facade exports and shared persistence ownership across direct storage imports and facade reloads.
