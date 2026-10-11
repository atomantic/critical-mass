const { it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createRequire } = require('node:module')

const adminDir = path.join(__dirname, '..', 'admin')
const adminRequire = createRequire(path.join(adminDir, 'package.json'))

it('compiles the admin stylesheet with responsive layout and accessible control utilities', async () => {
  const postcss = adminRequire('postcss')
  const config = (await import('../admin/postcss.config.js')).default
  const plugins = Object.entries(config.plugins).map(([name, options]) =>
    adminRequire(name)({ ...options, base: adminDir, optimize: false }))
  const from = path.join(adminDir, 'src', 'index.css')
  const result = await postcss(plugins).process(await fs.readFile(from, 'utf8'), { from })
  const rules = []
  result.root.walkRules(rule => rules.push(rule))
  const findRule = selector => rules.find(rule => rule.selector === selector)
  const declaration = (rule, prop) => rule?.nodes.find(node => node.prop === prop)?.value

  assert.equal(declaration(findRule('body'), 'background-color'), 'var(--color-gray-900)')
  assert.equal(declaration(findRule('.min-h-11'), 'min-height'), 'calc(var(--spacing) * 11)')
  const wideLayout = findRule('.\\33 xl\\:max-w-\\[2000px\\]')
  assert.ok(wideLayout, 'the custom desktop breakpoint must generate its layout utility')
  assert.equal(wideLayout.parent.name, 'media')
  assert.match(wideLayout.parent.params, /width >= 120rem/)
  const focusOutline = findRule('.focus\\:outline-hidden:focus')
  assert.ok(focusOutline?.nodes.some(node => node.name === 'media' && node.params === '(forced-colors: active)'),
    'migrated focus controls retain a forced-colors outline')
  assert.ok(findRule('.rounded-sm'), 'migrated compact controls retain their border radius')
  assert.match(result.css, /prefers-reduced-motion: reduce/)
})
