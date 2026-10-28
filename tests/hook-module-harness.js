// Helper for vm-based component tests that stub a hook module (e.g. useRealtimeRefresh).

/**
 * Wrap a hook so a stub resolves whether the bundler's CJS interop hands the
 * component the module object or its `default` (rolldown node-mode interop
 * makes `default` the whole module on some versions).
 */
function asHookModule(hook) {
  const fn = (...args) => hook(...args)
  fn.__esModule = true
  fn.default = fn
  return fn
}

module.exports = { asHookModule }
