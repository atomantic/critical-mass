// "1 sell" / "2 sells" / "0 sells". Pass an explicit plural for irregular nouns: plural(2, 'entry', 'entries').
export const plural = (n, singular, pluralForm = `${singular}s`) =>
  `${n} ${n === 1 ? singular : pluralForm}`
