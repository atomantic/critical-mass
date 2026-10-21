# Gateway HTTP framework decision

Status: Accepted, 2026-10-20. Resolves [issue #1181](https://github.com/atomantic/critical-mass/issues/1181).

## Decision

Retain Express as the gateway HTTP framework. Accept its direct and transitive
dependency maintenance cost; do not commission an owned HTTP implementation
solely to reduce the package count. The root manifest and lockfile remain the
source of truth for the installed version.

The dependency-freedom audit identified supply-chain surface, without a
reproduced HTTP defect. Critical Mass's purpose is exchange accumulation and
position management. Reimplementing the existing HTTP contracts would add a
second maintenance responsibility without an evidenced improvement to that
purpose. This decision resolves the framework choice; it does not establish
that Express or its dependencies are free of vulnerabilities.

## Existing contracts

The gateway uses more than method-and-path dispatch:

| Contract | Current owner and evidence |
| --- | --- |
| Middleware ordering, exchange path parameters, API JSON 404s, static admin assets and SPA fallback | [`server.js`](../server.js) uses `app.use`, `app.param`, `express.static`, `res.sendFile` and wildcard routes. |
| JSON parsing and error propagation | `express.json()` feeds the shared [`route utilities`](../src/routes/route-utils.js) and [`JSON error boundary`](../src/error-middleware.js), including malformed bodies, rejected handlers and response headers. |
| Operator bootstrap and sessions | [`operator-auth.js`](../src/operator-auth.js) uses request header access, Origin/forwarded-header checks, cookie serialization and response helpers. Framework changes must preserve the application's own trust checks. |
| AI provider and run routes | [`ai-routes.js`](../src/routes/ai-routes.js) registers owned Express handlers over [`provider-store.js`](../src/ai/provider-store.js) and [`run-recorder.js`](../src/ai/run-recorder.js). Since [issue #1347](https://github.com/atomantic/critical-mass/issues/1347) no third-party router is mounted, so these routes follow the same path-matching rules as every other gateway route. |
| Shutdown and admitted mutations | [`gateway-shutdown.js`](../src/gateway-shutdown.js) and `server.js` wrap route registration and track handler promises so shutdown can drain accepted work. |

An owned replacement would need to preserve those observable behaviors,
including path matching and decoding, parser limits, cookie flags, static-file
responses and middleware/error ordering. A small router
alone would leave much of the compatibility work outstanding. Keeping Express
lets application work use the established boundary and its regression tests.

## Maintenance and transport scope

Continue reviewing manifest and lockfile updates, assessing dependency
advisories, and testing the HTTP boundary when upgrading Express.
Accepting the framework is not an exemption from security fixes or updates.

HTTP framework ownership and realtime transport ownership are separate choices.
The current engine/exchange WebSocket work already uses Node's built-in client
and the owned IPC server; Socket.IO still serves dashboard events. Neither that
completed WebSocket work nor a future Socket.IO change requires an Express
rewrite. Evaluate each remaining dependency against its own consumers before
coupling migrations.

## When to revisit

Reopen this decision for an evidenced need: an unmitigated framework security
issue, an unsupported runtime, measured HTTP overhead that blocks a product
requirement, or a concrete transport change that removes substantial framework
coupling. Compare an owned implementation with updating or replacing the
framework, including ongoing compatibility and maintenance costs.

Removing `portos-ai-toolkit` ([issue #1347](https://github.com/atomantic/critical-mass/issues/1347))
took away its Express peer dependency, so Express is now the gateway's only
runtime package dependency and a revisit weighs Express alone. That removal does
not by itself reopen this decision.

Before a replacement ships, exercise real HTTP requests against both
implementations and preserve the contracts above. Existing starting coverage
includes [`operator-auth.test.js`](../tests/operator-auth.test.js),
[`route-error-handling.test.js`](../tests/route-error-handling.test.js),
[`gateway-listen.test.js`](../tests/gateway-listen.test.js),
[`gateway-shutdown.test.js`](../tests/gateway-shutdown.test.js) and
[`route-utils.test.js`](../tests/route-utils.test.js). These suites are a starting
point, not a complete replacement-compatibility specification; static serving,
path matching and the AI routes ([`ai-routes.test.js`](../tests/ai-routes.test.js))
also need parity coverage.
