const test = require('node:test')
const assert = require('node:assert/strict')

test('inactive and empty BTC tooltip payloads render no content', async () => {
  const React = await import('../admin/node_modules/react/index.js')
  const ReactDOMServer = await import('../admin/node_modules/react-dom/server.js')
  const { default: InactiveSafeTooltipContent, hasVisibleTooltipPayload } = await import('../admin/src/components/charts/InactiveSafeTooltipContent.js')
  const render = props => ReactDOMServer.renderToStaticMarkup(React.createElement(InactiveSafeTooltipContent, props))

  assert.equal(hasVisibleTooltipPayload({ active: false, payload: [{ value: 42000 }] }), false)
  assert.equal(render({ active: false, payload: [{ value: 42000 }] }), '')
  assert.equal(render({ active: true, payload: [] }), '')
  assert.equal(render({ active: true, payload: [{ value: null }] }), '')
})

test('active BTC tooltip delegates to Recharts default content and formatting', async () => {
  const React = await import('../admin/node_modules/react/index.js')
  const ReactDOMServer = await import('../admin/node_modules/react-dom/server.js')
  const { default: InactiveSafeTooltipContent } = await import('../admin/src/components/charts/InactiveSafeTooltipContent.js')
  const html = ReactDOMServer.renderToStaticMarkup(React.createElement(InactiveSafeTooltipContent, {
    active: true,
    label: '12:00',
    payload: [{ dataKey: 'price', name: 'price', value: 42000, color: '#f00' }],
    contentStyle: { backgroundColor: '#111827' },
    labelStyle: { color: '#9ca3af' },
    formatter: value => [`$${value.toLocaleString()}`, 'Price'],
  }))

  assert.match(html, /12:00/)
  assert.match(html, /\$42,000/)
  assert.match(html, /Price/)
  assert.match(html, /#111827/)
})
