// Structural sharing for JSON-shaped data: returns `prev` (the same reference)
// for every subtree that is deeply equal to the matching subtree of `next`, so
// React.memo / useMemo consumers see unchanged inputs as unchanged identities
// even though each socket push deserialises brand-new objects.
const isPlain = (v) => v !== null && typeof v === 'object' && (Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype)

export function shareStructure(prev, next) {
  if (Object.is(prev, next)) return prev
  if (!isPlain(prev) || !isPlain(next) || Array.isArray(prev) !== Array.isArray(next)) return next
  if (Array.isArray(next)) {
    let same = prev.length === next.length
    const out = next.map((item, i) => {
      const shared = shareStructure(prev[i], item)
      if (shared !== prev[i]) same = false
      return shared
    })
    return same ? prev : out
  }
  const keys = Object.keys(next)
  let same = Object.keys(prev).length === keys.length
  const out = {}
  for (const key of keys) {
    const shared = key in prev ? shareStructure(prev[key], next[key]) : next[key]
    if (!(key in prev) || shared !== prev[key]) same = false
    out[key] = shared
  }
  return same ? prev : out
}
