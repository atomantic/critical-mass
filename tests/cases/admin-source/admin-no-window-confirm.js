const TEST_DIR = require('node:path').resolve(__dirname, '../..');
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Scan every admin component for uses of window.confirm.
const adminSrcDir = path.join(TEST_DIR, '..', 'admin', 'src')

describe('No window.confirm in admin/src (issue #699)', () => {
  it('admin/src contains no window.confirm calls', () => {
    const getAllJsxFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) return getAllJsxFiles(fullPath)
      return entry.isFile() && (entry.name.endsWith('.jsx') || entry.name.endsWith('.js')) ? [fullPath] : []
    })
    for (const file of getAllJsxFiles(adminSrcDir)) {
      assert.doesNotMatch(
        fs.readFileSync(file, 'utf8'),
        /window\.confirm\s*\(/,
        `Found window.confirm in ${path.relative(adminSrcDir, file)} — use ConfirmDialog instead (issue #699)`,
      )
    }
  })
})
