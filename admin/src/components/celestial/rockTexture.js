import * as THREE from 'three'

let cachedTexture = null

/**
 * Procedural rocky texture for asteroids.
 * Gritty, high-contrast displacement noise.
 */
export const getRockTexture = () => {
  if (cachedTexture) return cachedTexture

  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')

  // Base gray-brown
  ctx.fillStyle = '#6B7280'
  ctx.fillRect(0, 0, size, size)

  // Gritty noise
  const imageData = ctx.getImageData(0, 0, size, size)
  for (let i = 0; i < imageData.data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 80
    imageData.data[i] += noise
    imageData.data[i + 1] += noise - 10 // slightly more blue-gray
    imageData.data[i + 2] += noise - 20
  }
  ctx.putImageData(imageData, 0, 0)

  // Veins/cracks
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)'
  ctx.lineWidth = 1
  for (let i = 0; i < 15; i++) {
    ctx.beginPath()
    ctx.moveTo(Math.random() * size, Math.random() * size)
    ctx.lineTo(Math.random() * size, Math.random() * size)
    ctx.stroke()
  }

  cachedTexture = new THREE.CanvasTexture(canvas)
  cachedTexture.wrapS = THREE.RepeatWrapping
  cachedTexture.wrapT = THREE.RepeatWrapping
  return cachedTexture
}
