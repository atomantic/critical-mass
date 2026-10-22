// Compiles the real admin usePolling hook (#1598) for vm-based component tests,
// so migrated components keep exercising the production interval behavior.
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')
const { createRequire } = require('node:module')

const adminRequire = createRequire(path.join(__dirname, '..', 'admin', 'package.json'))

async function compileUsePollingCode() {
  const { rolldown } = await import(pathToFileURL(adminRequire.resolve('rolldown')).href)
  const bundle = await rolldown({
    input: path.join(__dirname, '..', 'admin', 'src', 'hooks', 'usePolling.js'),
    external: () => true,
  })
  try { return (await bundle.generate({ format: 'cjs' })).output[0].code } finally { await bundle.close() }
}

/** Instantiate the compiled hook with the host's React and timer functions. */
function loadUsePolling(code, React, timers = { setInterval, clearInterval }) {
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require: () => React, ...timers })
  return asHookModule(mod.exports.default || mod.exports.usePolling)
}

/**
 * Wrap a hook so a stub resolves whether the bundler's CJS interop hands the
 * component the module object or its `default` (rolldown node-mode interop
 * makes `default` the whole module on some versions).
 */
function asHookModule(hook) {
  const fn = (...args) => hook(...args)
  fn.__esModule = true
  fn.default = fn
  fn.usePolling = fn
  return fn
}

module.exports = { compileUsePollingCode, loadUsePolling, asHookModule }
