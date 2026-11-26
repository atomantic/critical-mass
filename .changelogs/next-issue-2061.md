## Bug Fixes

- Concurrent operator API requests using a Bearer password can wait for verification without blocking other gateway requests.
- Admin realtime reconnects immediately after signing in again.
- Resetting the operator password asks for confirmation, ends existing sessions, and keeps a loopback-only gateway running.

## Improvements

- The admin starts loading the requested page bundle while checking the operator session when the route is known.
