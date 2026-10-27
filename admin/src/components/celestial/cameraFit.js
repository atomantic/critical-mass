/**
 * Camera framing for the celestial preview: derives the distance (and camera
 * limits) at which the whole orbital envelope from orbitLayout.js fits inside
 * the perspective frustum with padding.
 */

// Existing preview viewpoint: looking at the origin from [0, 8, 12].
export const DEFAULT_CAMERA_DIRECTION = [0, 8, 12]
export const DEFAULT_FOV = 45
const DEFAULT_ASPECT = 16 / 10
const DEFAULT_MIN_DISTANCE = 4
const DEFAULT_MAX_DISTANCE = 40
const DEFAULT_FAR = 100
const DEFAULT_FOG_NEAR = 38
const FOG_SPAN = 58
// A lone small body still gets a sensible amount of context around it.
const MIN_FIT_RADIUS = 4
const RING_SAMPLES = 64

const normalize = ([x, y, z]) => {
  const len = Math.hypot(x, y, z) || 1
  return [x / len, y / len, z / len]
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

const finitePositive = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback)

/**
 * @param {{radius: number, height: number}} bounds - from getSystemBounds
 * @param {{aspect?: number, fov?: number, padding?: number, direction?: number[]}} [options]
 * @returns camera placement for a target at the origin, plus matching controls/fog/far values
 */
export const fitCameraToBounds = (bounds, { aspect, fov, padding = 1.12, direction = DEFAULT_CAMERA_DIRECTION } = {}) => {
  const radius = Math.max(finitePositive(bounds?.radius, 0), MIN_FIT_RADIUS)
  const height = Math.max(finitePositive(bounds?.height, 0), 0)
  const tanV = Math.tan((finitePositive(fov, DEFAULT_FOV) * Math.PI) / 360)
  const tanH = tanV * finitePositive(aspect, DEFAULT_ASPECT)

  const dir = normalize(direction)
  const right = normalize(cross([-dir[0], -dir[1], -dir[2]], [0, 1, 0]))
  const up = cross(right, [-dir[0], -dir[1], -dir[2]])

  // A point p is inside the padded frustum when |p·right| <= (d - p·dir) * tanH / padding
  // (same for up/tanV), so the distance needed is a closed form over a ring
  // that encloses the system at every orbital phase and azimuth.
  let distance = 0
  for (let i = 0; i < RING_SAMPLES; i++) {
    const angle = (i / RING_SAMPLES) * Math.PI * 2
    for (const y of [height, -height]) {
      const p = [Math.cos(angle) * radius, y, Math.sin(angle) * radius]
      const needed = dot(p, dir) + padding * Math.max(Math.abs(dot(p, right)) / tanH, Math.abs(dot(p, up)) / tanV)
      if (needed > distance) distance = needed
    }
  }
  distance = Math.max(distance, DEFAULT_MIN_DISTANCE + radius)

  return {
    distance,
    position: dir.map(c => c * distance),
    target: [0, 0, 0],
    minDistance: Math.min(DEFAULT_MIN_DISTANCE, distance * 0.4),
    maxDistance: Math.max(DEFAULT_MAX_DISTANCE, distance * 1.8),
    far: Math.max(DEFAULT_FAR, Math.ceil(distance * 2.5)),
    fogNear: Math.max(DEFAULT_FOG_NEAR, distance + radius),
    fogFar: Math.max(DEFAULT_FOG_NEAR, distance + radius) + FOG_SPAN,
  }
}
