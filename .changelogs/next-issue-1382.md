## Fixes

- Recover the Coinbase user channel when its subscription fails (JWT signing error or a Coinbase `error` frame): the feed retries the subscription on the same socket with capped backoff (30s doubling, up to 10 minutes) and reconnects after three failed retries, instead of silently running without real-time fill detection. The feed status and market-data health state now report `userChannel: 'subscribed' | 'degraded'`.
