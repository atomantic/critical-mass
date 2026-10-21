# Unreleased — Gateway security headers

## Bug Fixes

- The gateway now sends `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` on every response, so the operator control panel cannot be framed by another origin on the same site (for example another app on a different localhost port) to clickjack order placement or key entry.
- Express no longer advertises itself with an `X-Powered-By: Express` header.
