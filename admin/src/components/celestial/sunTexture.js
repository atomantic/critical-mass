import * as THREE from 'three'

let cachedTexture = null

/**
 * Procedural canvas-based solar surface texture with granulation and hot spots.
 * 256x256 singleton — created once and shared by all sun instances.
 */
export const getSunTexture = () => {
  if (cachedTexture) return cachedTexture

  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')

  // Base warm yellow-orange
  ctx.fillStyle = '#FEF3C7'
  ctx.fillRect(0, 0, size, size)

  // Granulation cells
  const cellCount = 40 + Math.floor(Math.random() * 20)
  for (let i = 0; i < cellCount; i++) {
    const cx = Math.random() * size
    const cy = Math.random() * size
    const cr = 8 + Math.random() * 18
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr)
    grad.addColorStop(0, `rgba(255, 251, 235, ${0.4 + Math.random() * 0.3})`)
    grad.addColorStop(0.7, `rgba(251, 191, 36, ${0.2 + Math.random() * 0.2})`)
    grad.addColorStop(1, 'rgba(245, 158, 11, 0)')
    ctx.fillStyle = grad
    ctx.fillRect(cx - cr, cy - cr, cr * 2, cr * 2)
  }

  // Hot spots (solar flare origins)
  for (let i = 0; i < 5; i++) {
    const cx = Math.random() * size
    const cy = Math.random() * size
    const cr = 4 + Math.random() * 8
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr)
    grad.addColorStop(0, 'rgba(255, 255, 255, 0.8)')
    grad.addColorStop(1, 'rgba(255, 255, 255, 0)')
    ctx.fillStyle = grad
    ctx.fillRect(cx - cr, cy - cr, cr * 2, cr * 2)
  }

  // Noise for texture detail
  const imageData = ctx.getImageData(0, 0, size, size)
  for (let i = 0; i < imageData.data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 12
    imageData.data[i] = Math.max(0, Math.min(255, imageData.data[i] + noise))
    imageData.data[i + 1] = Math.max(0, Math.min(255, imageData.data[i + 1] + noise))
    imageData.data[i + 2] = Math.max(0, Math.min(255, imageData.data[i + 2] + noise))
  }
  ctx.putImageData(imageData, 0, 0)

  cachedTexture = new THREE.CanvasTexture(canvas)
  cachedTexture.wrapS = THREE.RepeatWrapping
  cachedTexture.wrapT = THREE.RepeatWrapping
  return cachedTexture
}
