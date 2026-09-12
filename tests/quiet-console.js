// @ts-check
/**
 * Preloaded into every test process (see the `test` script's NODE_OPTIONS).
 *
 * Node's test runner multiplexes its parent<->child protocol and the child's
 * raw stdout onto the same pipe. The suite writes tens of thousands of
 * application log lines to stdout, and often enough one of them desyncs the
 * parent's framing — it reports `Unable to deserialize cloned data due to
 * invalid or unsupported version.`, fails whole files that actually passed,
 * and every later file dies with `Promise resolution is still pending but the
 * event loop has already resolved`. Which files are hit changes run to run,
 * so it reads as a flake but scales with output volume.
 *
 * Only stdout carries the protocol, so silencing `console.log` is enough;
 * `console.warn` / `console.error` go to stderr and stay visible. Tests that
 * assert on log output stub `console.log` themselves, which replaces this
 * no-op, so their captures are unaffected.
 *
 * Set TEST_CONSOLE=1 to restore application logging while debugging.
 */
if (!process.env.TEST_CONSOLE) {
  console.log = () => {};
}
