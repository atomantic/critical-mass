const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Whole-tree static guards. Render tests (admin/tests/modal-dialog.test.jsx,
// fund-lifecycle-dialogs.test.jsx, regime-confirmation-dialogs.test.jsx) cover the
// dialog behaviour of issues #434/#699/#1370/#1989; these two checks cannot be
// expressed as a render test, so they stay as source scans.
const adminSrcDir = path.join(__dirname, '..', 'admin', 'src')

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

describe('Initial-focus wiring (issue #434)', () => {
  // jsdom/React do not emit the `autofocus` attribute that showModal() honours, so a
  // render test cannot prove the TP editor focuses its active input (not Cancel).
  it('TP editor marks both mode inputs autoFocus and ConfirmDialog marks Cancel autoFocus', () => {
    const read = (...p) => fs.readFileSync(path.join(adminSrcDir, ...p), 'utf8')
    const tp = read('components', 'regime', 'TpEditDialog.jsx')
    assert.equal((tp.match(/onKeyDown=\{\(e\) => e\.key === 'Enter' && onSubmit\('(pct|price)'\)\}\s*\n\s*autoFocus/g) || []).length, 2)
    assert.match(read('components', 'ui', 'ConfirmDialog.jsx'), /onClick=\{onClose\} disabled=\{busy\} autoFocus>/)
  })
})
