// Presentation helpers for profit/loss values. Zero counts as non-negative (green, '+').
export const pnlColorClass = (n) => (n >= 0 ? 'text-green-400' : 'text-red-400')

export const signedPrefix = (n) => (n >= 0 ? '+' : '')
