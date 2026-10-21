## Fixes

- **[issue-1517] pm2-stack tests no longer time out on a loaded host** — Each `npm` lifecycle scenario in `tests/pm2-stack.test.js` now gets a 120s spawn budget (was 15s, which a slow Node startup exceeded across roughly ten stub calls) and each test a 300s budget. A real timeout now fails with `pm2-stack "<command>" (scenario …) timed out after …ms` instead of `null !== 0`. Assertions are unchanged.
