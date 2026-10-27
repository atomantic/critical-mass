const { describe, it, before } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

// Issue #1812: the preview camera was fixed at [0, 8, 12], so valid nested tier
// chains (five tiers, a satellite four orbits deep) reached outside the frustum.
// These cover the pure framing math; the browser smoke projects the real scene.

const celestialDir = path.join(__dirname, '..', 'admin', 'src', 'components', 'celestial')
let getSystemBounds, sortCelestialBodies, splitOrbitChain, getSiblingOrbitRadius
let fitCameraToBounds, DEFAULT_CAMERA_DIRECTION
let getHierarchicalSpeed, getHierarchicalRadius, getBodyVisualExtent, TIER_ORDER

before(async () => {
  ;({ getSystemBounds, sortCelestialBodies, splitOrbitChain, getSiblingOrbitRadius } = await import(pathToFileURL(path.join(celestialDir, 'orbitLayout.js')).href))
  ;({ fitCameraToBounds, DEFAULT_CAMERA_DIRECTION } = await import(pathToFileURL(path.join(celestialDir, 'cameraFit.js')).href))
  ;({ getHierarchicalSpeed, getHierarchicalRadius, getBodyVisualExtent, TIER_ORDER } = await import(pathToFileURL(path.join(celestialDir, 'celestialConstants.js')).href))
})

const MAX = 10000
const body = (tier, costBasis, id = `${tier}-${costBasis}`) => ({ id, tier, costBasis })
// The issue's tier-valid reproduction: 20% / 8% / 3% / 1.5% / 0.5% of capital.
const FIVE_TIERS = [body('sun', 2000), body('planet', 800), body('moon', 300), body('asteroid', 150), body('satellite', 50)]

// Mirrors HierarchicalOrbit: world positions of every body at time t.
function worldPositions(bodies, t, maxUsdc = MAX) {
  const out = []
  const walk = (chain, depth, parentPos, parentRadius, angleOffset) => {
    const { current, siblings, descendants } = splitOrbitChain(chain)
    const radius = parentRadius ?? getHierarchicalRadius(depth)
    const angle = t * getHierarchicalSpeed(depth) + angleOffset
    const pos = radius === 0 ? parentPos : [parentPos[0] + Math.cos(angle) * radius, 0, parentPos[2] + Math.sin(angle) * radius]
    out.push({ body: current, pos })
    const childRadius = getSiblingOrbitRadius(depth, current, siblings, maxUsdc)
    siblings.forEach((child, i) => walk(i === 0 ? [child, ...descendants] : [child], depth + 1, pos, childRadius, (i / siblings.length) * Math.PI * 2))
  }
  const sorted = sortCelestialBodies(bodies)
  if (sorted.length) walk(sorted, 0, [0, 0, 0], undefined, 0)
  return out
}

// Project a world point through a camera placed by fitCameraToBounds.
function project(fit, point, aspect, fov = 45) {
  const dir = fit.position.map(c => c / fit.distance)
  const fwd = dir.map(c => -c)
  const rightRaw = [fwd[1] * 0 - fwd[2] * 1, fwd[2] * 0 - fwd[0] * 0, fwd[0] * 1 - fwd[1] * 0]
  const rl = Math.hypot(...rightRaw)
  const right = rightRaw.map(c => c / rl)
  const up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]]
  const v = point.map((c, i) => c - fit.position[i])
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const depth = dot(v, fwd)
  const tanV = Math.tan((fov * Math.PI) / 360)
  return { x: dot(v, right) / (depth * tanV * aspect), y: dot(v, up) / (depth * tanV), depth }
}

const ASPECTS = [16 / 10, 390 / 844, 2.4, 1]

describe('getSystemBounds (issue #1812)', () => {
  it('is zero for an empty system', () => {
    assert.deepEqual(getSystemBounds([], MAX), { radius: 0, height: 0 })
  })

  it('a lone body reaches only its own visual extent', () => {
    const { radius } = getSystemBounds([body('planet', 800)], MAX)
    assert.equal(radius, getBodyVisualExtent(body('planet', 800), MAX))
  })

  it('accumulates orbit radii along the nested chain', () => {
    const one = getSystemBounds(FIVE_TIERS.slice(0, 2), MAX).radius
    const five = getSystemBounds(FIVE_TIERS, MAX).radius
    assert.ok(five > one + 4, `nested reach ${five} must exceed the first orbit ${one}`)
  })

  it('same-tier siblings share one orbit (reach does not chain through siblings)', () => {
    const solo = getSystemBounds([body('sun', 2000), body('moon', 300, 'a')], MAX).radius
    const trio = getSystemBounds([body('sun', 2000), body('moon', 300, 'a'), body('moon', 300, 'b'), body('moon', 300, 'c')], MAX).radius
    assert.equal(trio, solo)
  })

  it('bounds every body at every orbital phase', () => {
    const cases = [FIVE_TIERS, TIER_ORDER.map((tier, i) => body(tier, MAX / (i + 1.5))), [body('sun', 2000), body('moon', 300, 'a'), body('moon', 300, 'b'), body('satellite', 50)]]
    for (const bodies of cases) {
      const { radius } = getSystemBounds(bodies, MAX)
      for (let t = 0; t < 4000; t += 7.3) {
        for (const { body: b, pos } of worldPositions(bodies, t)) {
          assert.ok(Math.hypot(pos[0], pos[2]) + getBodyVisualExtent(b, MAX) <= radius + 1e-9, `${b.id} escapes the envelope at t=${t}`)
        }
      }
    }
  })
})

describe('fitCameraToBounds (issue #1812)', () => {
  it('keeps the original viewing direction', () => {
    const fit = fitCameraToBounds(getSystemBounds(FIVE_TIERS, MAX), { aspect: 1.6, fov: 45 })
    const len = Math.hypot(...DEFAULT_CAMERA_DIRECTION)
    DEFAULT_CAMERA_DIRECTION.forEach((c, i) => assert.ok(Math.abs(fit.position[i] / fit.distance - c / len) < 1e-9))
  })

  it('puts every body of the five-tier reproduction on screen at any phase, aspect and with padding', () => {
    const bounds = getSystemBounds(FIVE_TIERS, MAX)
    for (const aspect of ASPECTS) {
      const fit = fitCameraToBounds(bounds, { aspect, fov: 45 })
      for (let t = 0; t < 2000; t += 11) {
        for (const { body: b, pos } of worldPositions(FIVE_TIERS, t)) {
          const e = getBodyVisualExtent(b, MAX)
          // Conservative screen-space extent: the body's sphere along the view-aligned axes.
          const near = project(fit, pos, aspect)
          const edge = Math.max(e / (near.depth * Math.tan(Math.PI * 45 / 360) * Math.min(aspect, 1)), 0)
          assert.ok(Math.abs(near.x) + edge <= 1, `${b.id} x off-screen at aspect ${aspect}, t=${t}`)
          assert.ok(Math.abs(near.y) + edge <= 1, `${b.id} y off-screen at aspect ${aspect}, t=${t}`)
        }
      }
    }
  })

  it('the original fixed camera does NOT contain the same system (regression guard)', () => {
    const oldCamera = { position: [0, 8, 12], distance: Math.hypot(8, 12) }
    const escapes = Array.from({ length: 200 }, (_, i) => i * 13).some(t =>
      worldPositions(FIVE_TIERS, t).some(({ pos }) => {
        const p = project(oldCamera, pos, 16 / 10)
        return Math.abs(p.x) > 1 || Math.abs(p.y) > 1
      }))
    assert.ok(escapes, 'the five-tier fixture must escape the old fixed frustum at some orbital phase')
  })

  it('handles one body, same-tier siblings, a full nine-tier stack and the empty system with finite values', () => {
    const systems = {
      empty: [],
      one: [body('black_hole', 9000)],
      siblings: [body('sun', 2000), body('moon', 300, 'a'), body('moon', 300, 'b'), body('moon', 300, 'c')],
      all: TIER_ORDER.map((tier, i) => body(tier, MAX / (i + 1.5))),
    }
    for (const [name, bodies] of Object.entries(systems)) {
      for (const aspect of [...ASPECTS, NaN, 0, undefined]) {
        const fit = fitCameraToBounds(getSystemBounds(bodies, MAX), { aspect, fov: 45 })
        for (const v of [fit.distance, ...fit.position, ...fit.target, fit.minDistance, fit.maxDistance, fit.far, fit.fogNear, fit.fogFar]) {
          assert.ok(Number.isFinite(v), `${name}/${aspect}: non-finite camera value`)
        }
        assert.ok(fit.minDistance > 0 && fit.minDistance < fit.distance && fit.distance < fit.maxDistance, `${name}: controls range must contain the fitted distance`)
        assert.ok(fit.far > fit.distance + getSystemBounds(bodies, MAX).radius, `${name}: far plane must clear the system`)
      }
    }
  })

  it('degrades to finite values for non-finite bounds', () => {
    const fit = fitCameraToBounds({ radius: NaN, height: Infinity }, { aspect: 1.6, fov: 45 })
    assert.ok(Number.isFinite(fit.distance) && fit.distance > 0)
  })

  it('pulls back further for narrower viewports', () => {
    const bounds = getSystemBounds(FIVE_TIERS, MAX)
    assert.ok(fitCameraToBounds(bounds, { aspect: 0.5, fov: 45 }).distance > fitCameraToBounds(bounds, { aspect: 2, fov: 45 }).distance)
  })
})
