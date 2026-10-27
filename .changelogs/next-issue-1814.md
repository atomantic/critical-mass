## Improvements

- Bound queued DCA operations before accepting more work in gateway (issue #1814).
- Limit admitted work to at most 8 operations per fund and 32 across the gateway, returning HTTP 503 `dca-busy` with `Retry-After: 1` before pending-write registration or lock chaining.
- Preserve scheduled within-interval retry eligibility without spending intervals on capacity refusals.
