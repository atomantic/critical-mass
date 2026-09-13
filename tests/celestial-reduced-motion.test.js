const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Issue #539: nothing in the admin UI read the operator's OS-level
// prefers-reduced-motion preference, and the celestial 3D visualization
// (CelestialScene.jsx / CelestialVisualization.jsx) auto-rotated, drifted
// starfields, and repainted every frame (frameloop="always") with no
// in-app control to stop it and no accessible name on the <canvas>.
//
// This repo has no jsdom/React rendering harness (see
// admin-route-code-splitting.test.js, fund-operation-modal-dialogs.test.js
// and config-editor-write-gate.test.js for the established precedent), so —
// matching that convention — these tests assert against source text.

const indexCssSource = fs.readFileSync(
  path.join(__dirname, '..', 'admin', 'src', 'index.css'),
  'utf8',
)

const useReducedMotionSource = fs.readFileSync(
  path.join(__dirname, '..', 'admin', 'src', 'hooks', 'useReducedMotion.js'),
  'utf8',
)

const celestialSceneSource = fs.readFileSync(
  path.join(__dirname, '..', 'admin', 'src', 'components', 'celestial', 'CelestialScene.jsx'),
  'utf8',
)

const celestialVisualizationSource = fs.readFileSync(
  path.join(__dirname, '..', 'admin', 'src', 'components', 'celestial', 'CelestialVisualization.jsx'),
  'utf8',
)

describe('prefers-reduced-motion CSS gate (issue #539)', () => {
  it('collapses animation/transition durations under prefers-reduced-motion: reduce', () => {
    assert.match(indexCssSource, /@media \(prefers-reduced-motion: reduce\)/)
    assert.match(indexCssSource, /animation-duration: 0\.01ms !important/)
    assert.match(indexCssSource, /animation-iteration-count: 1 !important/)
    assert.match(indexCssSource, /transition-duration: 0\.01ms !important/)
  })
})

describe('useReducedMotion hook (issue #539)', () => {
  it('reads matchMedia directly with no added dependency', () => {
    assert.match(useReducedMotionSource, /window\.matchMedia\(QUERY\)/)
    const importedModules = [...useReducedMotionSource.matchAll(/from '([^']+)'/g)].map(m => m[1])
    assert.deepEqual(importedModules, ['react'])
  })

  it('subscribes and unsubscribes from the change event', () => {
    assert.match(useReducedMotionSource, /addEventListener\('change', onChange\)/)
    assert.match(useReducedMotionSource, /removeEventListener\('change', onChange\)/)
  })
})

describe('CelestialScene motion gating (issue #539)', () => {
  it('disables auto-rotate under reduced motion', () => {
    assert.match(celestialSceneSource, /autoRotate={!reducedMotion}/)
  })

  it('stops starfield drift under reduced motion', () => {
    const matches = celestialSceneSource.match(/speed={reducedMotion \? 0 : [\d.]+}/g) || []
    assert.equal(matches.length, 3)
  })
})

describe('CelestialVisualization pause control and canvas name (issue #539)', () => {
  it('defaults motion-paused state to the OS preference and persists an explicit choice', () => {
    assert.match(celestialVisualizationSource, /useReducedMotion/)
    assert.match(celestialVisualizationSource, /explicitMotionPaused \?\? prefersReducedMotion/)
    assert.match(celestialVisualizationSource, /localStorage\.setItem\(MOTION_PAUSED_STORAGE_KEY, String\(next\)\)/)
    assert.match(celestialVisualizationSource, /localStorage\.getItem\(MOTION_PAUSED_STORAGE_KEY\)/)
  })

  it('renders a real toggle button with accessible pressed state, not window.confirm/alert', () => {
    assert.match(celestialVisualizationSource, /<button[\s\S]*?aria-pressed={motionPaused}/)
    assert.doesNotMatch(celestialVisualizationSource, /window\.(confirm|alert)/)
  })

  it('switches the Canvas frameloop to demand under motion-paused so drag input still redraws', () => {
    assert.match(celestialVisualizationSource, /frameloop={motionPaused \? 'demand' : 'always'}/)
  })

  it('gives the actual <canvas> DOM node a role and computed accessible name from the tier/order counts', () => {
    assert.match(celestialVisualizationSource, /gl\.domElement\.setAttribute\('role', 'img'\)/)
    assert.match(celestialVisualizationSource, /gl\.domElement\.setAttribute\('aria-label', canvasLabel\)/)
    assert.match(celestialVisualizationSource, /canvasElRef\.current\.setAttribute\('aria-label', canvasLabel\)/)
    assert.match(celestialVisualizationSource, /Celestial system:/)
  })
})
