import * as THREE from 'three'

let cachedTexture = null

/**
 * Procedural canvas-based lunar surface texture.
 * 256x256 with craters, maria (dark basalt plains), and pixel noise.
 * Singleton — created once and shared by all moon instances.
 */
export const getMoonTexture = () => {
  if (cachedTexture) return cachedTexture

  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')

  // Base gray surface
  ctx.fillStyle = '#8A8A8A'
  ctx.fillRect(0, 0, size, size)

  // Pixel noise for granularity
  const imageData = ctx.getImageData(0, 0, size, size)
  for (let i = 0; i < imageData.data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 30
    imageData.data[i] += noise
    imageData.data[i + 1] += noise
    imageData.data[i + 2] += noise
  }
  ctx.putImageData(imageData, 0, 0)

  // Dark maria (large basalt plains)
  const maria = [
    { x: 80, y: 70, r: 45 },
    { x: 180, y: 130, r: 35 },
    { x: 120, y: 200, r: 40 },
  ]
  for (const m of maria) {
    const grad = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.r)
    grad.addColorStop(0, 'rgba(60, 60, 65, 0.6)')
    grad.addColorStop(1, 'rgba(60, 60, 65, 0)')
    ctx.fillStyle = grad
    ctx.fillRect(m.x - m.r, m.y - m.r, m.r * 2, m.r * 2)
  }

  // Craters — darker fill with lighter rim highlight
  const craterCount = 20 + Math.floor(Math.random() * 10)
  for (let i = 0; i < craterCount; i++) {
    const cx = Math.random() * size
    const cy = Math.random() * size
    const cr = 3 + Math.random() * 12

    // Rim highlight (lighter ring)
    ctx.beginPath()
    ctx.arc(cx, cy, cr + 1.5, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(180, 180, 180, 0.4)'
    ctx.lineWidth = 1.5
    ctx.stroke()

    // Crater floor (darker)
    ctx.beginPath()
    ctx.arc(cx, cy, cr, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(50, 50, 55, ${0.3 + Math.random() * 0.3})`
    ctx.fill()
  }

  cachedTexture = new THREE.CanvasTexture(canvas)
  cachedTexture.wrapS = THREE.RepeatWrapping
  cachedTexture.wrapT = THREE.RepeatWrapping
  return cachedTexture
}
