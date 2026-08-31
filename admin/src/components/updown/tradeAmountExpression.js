const FIRST_TERM = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/
const ADDED_TERM = /^(?:\d+(?:\.\d*)?|\.\d+)$/

export function parseTradeAmountExpression(input) {
  if (typeof input !== 'string' || input.trim() === '') return NaN

  const terms = input.split('+').map(term => term.trim())
  if (!FIRST_TERM.test(terms[0]) || terms.slice(1).some(term => !ADDED_TERM.test(term))) {
    return NaN
  }

  const total = terms.reduce((sum, term) => sum + Number(term), 0)
  return Number.isFinite(total) ? total : NaN
}
