// @ts-check
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '..')
const ADMIN_SRC = path.join(ROOT, 'admin', 'src')
const SHARED_DIR = path.join(ROOT, 'shared')

const IMPORT_RE = /\bimport\s+(?:type\s+)?(?:\{([^}]*)\}|\*\s+as\s+\w+|[\w$]+)\s+from\s+['"]([^'"]+)['"]/g
const SOURCE_EXTS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']

/**
 * @param {string} dir
 * @returns {string[]}
 */
function walkSourceFiles(dir) {
  /** @type {string[]} */
  const files = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) files.push(...walkSourceFiles(full))
    else if (SOURCE_EXTS.includes(path.extname(ent.name))) files.push(full)
  }
  return files
}

/**
 * @param {string} clause
 * @returns {string[]}
 */
function namedBindings(clause) {
  return clause
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && part !== 'type')
    .map((part) => part.replace(/^type\s+/, ''))
    .map((part) => {
      const match = part.match(/^(\w+)\s+as\s+\w+$/)
      return match ? match[1] : part
    })
    .filter((name) => /^\w+$/.test(name))
}

/**
 * @param {string} fromFile
 * @param {string} specifier
 * @returns {string|null}
 */
function resolveSharedImport(fromFile, specifier) {
  const resolved = path.resolve(path.dirname(fromFile), specifier)
  if (!resolved.startsWith(SHARED_DIR + path.sep) && resolved !== SHARED_DIR) return null
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved
  for (const ext of ['.mjs', '.js', '.cjs', '.json']) {
    const candidate = resolved + ext
    if (fs.existsSync(candidate)) return candidate
  }
  return resolved
}

function collectAdminSharedImports() {
  /** @type {Map<string, { names: Set<string>, importers: string[] }>} */
  const byFile = new Map()
  for (const file of walkSourceFiles(ADMIN_SRC)) {
    const source = fs.readFileSync(file, 'utf8')
    IMPORT_RE.lastIndex = 0
    let match
    while ((match = IMPORT_RE.exec(source))) {
      const specifier = match[2]
      if (!specifier.includes('/shared/')) continue
      const resolved = resolveSharedImport(file, specifier)
      assert.ok(resolved, `${path.relative(ROOT, file)} imports ${specifier} which does not resolve`)
      const rel = path.relative(ROOT, resolved)
      if (!byFile.has(rel)) byFile.set(rel, { names: new Set(), importers: [] })
      const entry = byFile.get(rel)
      entry.importers.push(path.relative(ROOT, file))
      for (const name of namedBindings(match[1] || '')) entry.names.add(name)
    }
  }
  return byFile
}

describe('shared modules imported by admin/src are ESM', () => {
  const imports = collectAdminSharedImports()

  it('finds the shared modules the admin client imports', () => {
    assert.ok(imports.size > 0, 'admin/src should import at least one shared/ module')
    const keys = [...imports.keys()].sort()
    assert.ok(
      keys.some((k) => k.endsWith('shared/signal-actions.mjs')),
      `expected signal-actions.mjs among ${keys.join(', ')}`,
    )
    assert.ok(
      keys.some((k) => k.endsWith('shared/indicator-config.mjs')),
      `expected indicator-config.mjs among ${keys.join(', ')}`,
    )
  })

  it('exposes named ESM bindings and is not CommonJS', async () => {
    for (const [rel, { names, importers }] of imports) {
      const abs = path.join(ROOT, rel)
      assert.ok(fs.existsSync(abs), `${rel} imported by ${importers.join(', ')} is missing`)
      if (rel.endsWith('.json')) continue

      const source = fs.readFileSync(abs, 'utf8')
      assert.doesNotMatch(
        source,
        /\bmodule\.exports\b/,
        `${rel} is imported by the Vite admin client and must not use module.exports`,
      )
      assert.match(source, /\bexport\b/, `${rel} must contain ESM export statements`)

      const mod = await import(pathToFileURL(abs).href)
      assert.ok(mod && typeof mod === 'object', `${rel} did not load as an ES module`)
      for (const name of names) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(mod, name),
          `${rel} is missing named export ${name} (imported from ${importers.join(', ')})`,
        )
      }
    }
  })
})
