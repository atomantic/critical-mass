import * as THREE from 'three'

let cachedTexture = null

/**
 * Procedural canvas-based planet surface texture with continents and ice caps.
 * 256x256 singleton — created once and shared by all planet instances.
 */
export const getPlanetTexture = () => {
  if (cachedTexture) return cachedTexture

  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')

  // Base ocean blue
  ctx.fillStyle = '#1E40AF'
  ctx.fillRect(0, 0, size, size)

  // Continent-like patches
  const patches = 8 + Math.floor(Math.random() * 6)
  for (let i = 0; i < patches; i++) {
    const cx = Math.random() * size
    const cy = Math.random() * size
    const cr = 15 + Math.random() * 35
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr)
    grad.addColorStop(0, `rgba(34, 139, 34, ${0.5 + Math.random() * 0.3})`)
    grad.addColorStop(0.6, `rgba(85, 107, 47, ${0.3 + Math.random() * 0.2})`)
    grad.addColorStop(1, 'rgba(30, 64, 175, 0)')
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.ellipse(cx, cy, cr * (0.8 + Math.random() * 0.4), cr, Math.random() * Math.PI, 0, Math.PI * 2)
    ctx.fill()
  }

  // Ice caps
  const capGrad1 = ctx.createLinearGradient(0, 0, 0, 30)
  capGrad1.addColorStop(0, 'rgba(255, 255, 255, 0.7)')
  capGrad1.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = capGrad1
  ctx.fillRect(0, 0, size, 30)

  const capGrad2 = ctx.createLinearGradient(0, size - 30, 0, size)
  capGrad2.addColorStop(0, 'rgba(255, 255, 255, 0)')
  capGrad2.addColorStop(1, 'rgba(255, 255, 255, 0.7)')
  ctx.fillStyle = capGrad2
  ctx.fillRect(0, size - 30, size, 30)

  // Noise
  const imageData = ctx.getImageData(0, 0, size, size)
  for (let i = 0; i < imageData.data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 15
    imageData.data[i] = Math.max(0, Math.min(255, imageData.data[i] + noise))
    imageData.data[i + 1] = Math.max(0, Math.min(255, imageData.data[i + 1] + noise))
    imageData.data[i + 2] = Math.max(0, Math.min(255, imageData.data[i + 2] + noise))
  }
  ctx.putImageData(imageData, 0, 0)

  cachedTexture = new THREE.CanvasTexture(canvas)
  cachedTexture.wrapS = THREE.RepeatWrapping
  cachedTexture.wrapT = THREE.ClampToEdgeWrapping
  return cachedTexture
}
