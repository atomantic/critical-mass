const assert = require('node:assert/strict')
const { describe, it } = require('node:test')

const parser = import('../admin/src/components/updown/tradeAmountExpression.js')

describe('trade amount expression parsing', () => {
  it('adds documented finite expressions', async () => {
    const { parseTradeAmountExpression } = await parser

    assert.equal(parseTradeAmountExpression('200+300'), 500)
    assert.equal(parseTradeAmountExpression(' 200.25 + 299.75 '), 500)
    assert.equal(parseTradeAmountExpression('.5+1.5'), 2)
  })

  it('rejects numeric prefixes and suffixes', async () => {
    const { parseTradeAmountExpression } = await parser

    for (const input of ['12abc', '500usd', '600USD', '$500', '12.5px']) {
      assert.equal(Number.isNaN(parseTradeAmountExpression(input)), true, input)
    }
  })

  it('rejects empty terms, malformed signs, and non-finite values', async () => {
    const { parseTradeAmountExpression } = await parser

    for (const input of ['', ' ', '1++2', '+1', '1+', '1+-2', 'Infinity', 'NaN', '1e309']) {
      assert.equal(Number.isNaN(parseTradeAmountExpression(input)), true, input)
    }
  })
})
