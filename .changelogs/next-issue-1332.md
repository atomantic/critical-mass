# Unreleased — findMergeTarget options object

## Changes

- `findMergeTarget` now takes a single options object (`{ maxUsdcDeployed, candidateTpPrice, maxBodies, pendingOrderCount, maxOpenOrders, proximityScale }`) instead of eight positional parameters, so swapped numeric arguments can no longer silently misroute a merge. No logic change.
