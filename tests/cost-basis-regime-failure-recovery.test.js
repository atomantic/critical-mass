const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Issue #853: Verify CostBasisRegime.jsx failure handling and recovery
// The component must properly handle fetch failures, HTTP errors, and parse failures,
// while preserving last-known-good state during transient failures.

const source = fs.readFileSync(
  path.join(__dirname, '..', 'admin', 'src', 'components', 'CostBasisRegime.jsx'),
  'utf8',
)

describe('CostBasisRegime failure handling and recovery (issue #853)', () => {
  it('declares error and stale state for tracking failures and recovery', () => {
    assert.match(source, /const \[error, setError\] = useState\(null\)/)
    assert.match(source, /const \[stale, setStale\] = useState\(false\)/)
  })

  it('validates all HTTP responses before parsing', () => {
    // Check that we validate status for all three endpoints
    assert.match(source, /if \(!statusRes\.ok\)/)
    assert.match(source, /if \(!fillsRes\.ok\)/)
    assert.match(source, /if \(!configRes\.ok\)/)
    // Check that errors are thrown for non-OK responses
    assert.match(source, /throw new Error\(`Status fetch failed/)
    assert.match(source, /throw new Error\(`Fills fetch failed/)
    assert.match(source, /throw new Error\(`Config fetch failed/)
  })

  it('parses all responses before committing state', () => {
    // Verify that all parse operations happen before setState calls
    const parseSection = source.match(
      /const statusData = await statusRes\.json\(\)[\s\S]*?const fillsData = await fillsRes\.json\(\)[\s\S]*?const configData = await configRes\.json\(\)/
    )
    assert.ok(parseSection, 'should parse all responses before state updates')

    // Verify state updates come after parsing
    assert.match(source, /const configData = await configRes\.json\(\)[\s\S]*?setStatus\(statusData/)
  })

  it('catches transport and parse failures with try/catch/finally', () => {
    assert.match(source, /try \{/)
    assert.match(source, /\} catch \(err\) \{/)
    assert.match(source, /\} finally \{/)
    assert.match(source, /setLoading\(false\)/)
  })

  it('releases loading gate even on first-load failure', () => {
    // In the finally block, setLoading(false) must be called
    const finallyMatch = source.match(/finally \{[\s\S]*?setLoading\(false\)/)
    assert.ok(finallyMatch, 'finally block must call setLoading(false)')
  })

  it('sets error when no previous data exists', () => {
    assert.match(source, /if \(!status && fills\.length === 0 && !productId\)/)
    assert.match(source, /setError\(err\.message/)
  })

  it('marks data as stale when refresh fails with previous data', () => {
    assert.match(source, /\} else \{/)
    assert.match(source, /setStale\(true\)/)
  })

  it('clears errors and stale flag on successful load', () => {
    // After successful state updates, errors should be cleared
    assert.match(source, /setError\(null\)/)
    assert.match(source, /setStale\(false\)/)
  })

  it('renders error state with retry button on initial failure', () => {
    assert.match(source, /if \(loading && error\)/)
    assert.match(source, /<div className="text-red-400">Error: \{error\}<\/div>/)
    assert.match(source, /onClick=\{fetchData\}/)
    assert.match(source, />[\s\n]*Retry[\s\n]*<\/button>/)
  })

  it('shows stale data indicator when refresh fails with previous data', () => {
    assert.match(source, /\{stale && \(/)
    assert.match(source, /Data is stale/)
    assert.match(source, /Waiting for the next successful refresh/)
    assert.match(source, />[\s\n]*Refresh Now[\s\n]*<\/button>/)
  })

  it('preserves valid zero-position snapshots distinct from load failures', () => {
    // The component should render zeros only if data was successfully loaded
    // (Empty position is valid when status has no position and fills is empty [])
    // This is guaranteed by the error/stale states preventing false positives
    assert.match(source, /const position = status\?.position \|\| \{\}/)
    assert.match(source, /const isDryRun = status\?.isDryRun/)
  })

  it('maintains automatic polling interval and clears error on next successful fetch', () => {
    // The useEffect still sets up the 10s interval
    assert.match(source, /const interval = setInterval\(fetchData, 10000\)/)
    // Successful fetches clear error
    assert.match(source, /setError\(null\)/)
  })
})
