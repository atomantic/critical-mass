const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const labelsModule = import('../admin/src/utils/candleLabels.mjs')
const context = { exchange: 'coinbase', bucketMs: 60_000, timeZone: 'UTC' }
const entries = keys => keys.map(time => [time, { time, price: 10 }])

test('formats only new displayed keys and bounds retention through reloads and range changes', async () => {
  const { createCandleLabelCache } = await labelsModule
  let calls = 0
  const cache = createCandleLabelCache(key => `${key}:${++calls}`)
  const initial = entries([0, 60_000, 120_000])
  const first = cache.sync(initial, context)
  for (let i = 0; i < 12; i++) assert.deepEqual(cache.sync(initial, context), first)
  assert.equal(calls, 3)
  cache.sync(entries([0, 60_000, 120_000, 180_000]), context)
  assert.equal(calls, 4)
  cache.sync(entries([120_000, 180_000]), context)
  assert.equal(cache.size, 2)
  cache.sync(entries([600_000]), context)
  assert.equal(cache.size, 1)
  assert.equal(calls, 5)
  cache.sync([], context)
  assert.equal(cache.size, 0)
  cache.sync(initial, context)
  assert.equal(calls, 8)
})

test('invalidates for exchange, duration, resolved time zone, and lifecycle reset', async () => {
  const { createCandleLabelCache } = await labelsModule
  let calls = 0
  const cache = createCandleLabelCache(() => String(++calls))
  for (const next of [context, { ...context, exchange: 'gemini' },
    { ...context, bucketMs: 3_600_000 }, { ...context, timeZone: 'America/New_York' }]) {
    cache.sync(entries([0]), next)
  }
  assert.equal(calls, 4)
  cache.clear()
  assert.equal(cache.size, 0)
  cache.sync(entries([0]), { ...context, timeZone: 'America/New_York' })
  assert.equal(calls, 5)
  const other = createCandleLabelCache(() => String(++calls))
  other.sync(entries([0]), context)
  assert.equal(calls, 6)
})

test('preserves en-US local labels across date and DST boundaries and detects zone changes', async () => {
  const { createCandleLabelCache, formatBucketLabel } = await labelsModule
  const previousZone = process.env.TZ
  try {
    process.env.TZ = 'America/New_York'
    const before = Date.parse('2026-03-08T06:59:00Z')
    const after = Date.parse('2026-03-08T07:00:00Z')
    assert.equal(formatBucketLabel(before, 60_000), '1:59 AM')
    assert.equal(formatBucketLabel(after, 60_000), '3:00 AM')
    assert.equal(formatBucketLabel(after, 3_600_000), 'Mar 8 3 AM')
    const midnight = Date.parse('2026-01-01T02:00:00Z')
    assert.equal(formatBucketLabel(midnight, 86_400_000), 'Dec 31')
    assert.equal(formatBucketLabel(midnight, 604_800_000), 'Dec 31')
    for (const timestamp of ['2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z']) {
      assert.equal(formatBucketLabel(Date.parse(timestamp), 60_000), '1:30 AM')
    }
    let calls = 0
    const cache = createCandleLabelCache((...args) => { calls++; return formatBucketLabel(...args) })
    const localContext = { exchange: 'coinbase', bucketMs: 60_000 }
    assert.equal(cache.sync(entries([after]), localContext)[0].label, '3:00 AM')
    cache.sync(entries([after]), localContext)
    assert.equal(calls, 1)
    process.env.TZ = 'UTC'
    assert.equal(cache.sync(entries([after]), localContext)[0].label, '7:00 AM')
    assert.equal(calls, 2)
  } finally {
    if (previousZone === undefined) delete process.env.TZ
    else process.env.TZ = previousZone
  }
})

test('UpDown sync callbacks keep updating OHLC, indicators and annotations without reformatting 640 stable labels', async () => {
  const { createCandleLabelCache } = await labelsModule
  const source = readFileSync(path.join(__dirname, '../admin/src/hooks/useCandleData.js'), 'utf8')
  const annotations = source.slice(source.indexOf('const SIGNAL_PRIORITY'), source.indexOf('export default function'))
  const sync = source.slice(source.indexOf('  const syncChart ='), source.indexOf('\n  /**\n   * Compute HA'))
  let calls = 0
  const views = [[60, 60000], [60, 180000], [72, 300000], [72, 600000], [96, 900000],
    [48, 1800000], [72, 3600000], [36, 7200000], [42, 14400000], [30, 86400000], [52, 604800000]]
  for (const [maxBuckets, bucketMs] of views) {
    const bucketsRef = { current: new Map(entries(Array.from({ length: maxBuckets }, (_, i) => i * bucketMs))) }
    const signalAnnotationsRef = { current: null }
    let snapshot
    const labelCacheRef = { current: createCandleLabelCache(key => { calls++; return String(key) }) }
    const syncChart = vm.runInNewContext(`${annotations}\n${sync}\nsyncChart`, {
      bucketsRef, signalAnnotationsRef, labelCacheRef, bucketMs, maxBuckets, exchange: 'coinbase',
      useCallback: fn => fn, setChartData: value => { snapshot = value },
    })
    syncChart()
    const initialCalls = calls
    const previous = snapshot
    const bucket = bucketsRef.current.get(0)
    Object.assign(bucket, { open: 9, price: 12, high: 14, low: 8, haClose: 11, rsi: 62 })
    signalAnnotationsRef.current = [{ timestamp: 0, type: 'BUY', score: 40 }]
    for (let i = 0; i < 12; i++) syncChart()
    assert.equal(calls, initialCalls)
    assert.notEqual(snapshot, previous)
    assert.equal(previous[0].price, 10)
    for (const key of ['open', 'price', 'high', 'low', 'haClose', 'rsi']) assert.equal(snapshot[0][key], bucket[key])
    assert.equal(snapshot[0].signalChange.type, 'BUY')
    signalAnnotationsRef.current = null
    syncChart()
    assert.equal(snapshot[0].signalChange, null)
    assert.equal(labelCacheRef.current.size, maxBuckets)
  }
  assert.equal(calls, 640)
})
