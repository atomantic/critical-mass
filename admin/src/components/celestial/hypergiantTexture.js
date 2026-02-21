import * as THREE from 'three'

let cachedTexture = null

/**
 * Procedural canvas-based Jupiter-like gas band texture for hypergiants.
 * 256x256 with horizontal bands of varying purple/lavender hues + turbulence.
 * Singleton — created once and shared by all hypergiant instances.
 */
export const getHypergiantTexture = () => {
  if (cachedTexture) return cachedTexture

  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')

  // Band colors — purple/lavender palette matching hypergiant theme
  const bands = [
    { color: [120, 70, 160], width: 0.08 },  // deep purple
    { color: [160, 120, 200], width: 0.05 },  // light lavender
    { color: [100, 50, 140], width: 0.10 },   // dark purple
    { color: [180, 140, 220], width: 0.04 },  // pale lavender
    { color: [90, 40, 130], width: 0.12 },    // very deep purple
    { color: [200, 170, 240], width: 0.03 },  // near-white lavender
    { color: [110, 60, 150], width: 0.09 },   // mid purple
    { color: [140, 90, 180], width: 0.06 },   // medium lavender
    { color: [80, 35, 120], width: 0.11 },    // darkest
    { color: [170, 130, 210], width: 0.05 },  // light purple
    { color: [100, 50, 140], width: 0.08 },   // dark again
    { color: [150, 100, 190], width: 0.07 },  // mid-light
    { color: [85, 40, 125], width: 0.12 },    // deep
  ]

  // Draw horizontal bands
  let y = 0
  for (const band of bands) {
    const bandHeight = band.width * size
    const [r, g, b] = band.color
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`
    ctx.fillRect(0, y, size, bandHeight + 1)
    y += bandHeight
    if (y >= size) break
  }
  // Fill remainder
  if (y < size) {
    ctx.fillStyle = 'rgb(120, 70, 160)'
    ctx.fillRect(0, y, size, size - y)
  }

  // Add turbulence/noise for gas cloud effect
  const imageData = ctx.getImageData(0, 0, size, size)
  for (let py = 0; py < size; py++) {
    // Horizontal wave distortion per row
    const waveOffset = Math.sin(py * 0.15) * 3 + Math.sin(py * 0.05) * 6
    for (let px = 0; px < size; px++) {
      const srcX = Math.floor((px + waveOffset + size) % size)
      const srcIdx = (py * size + srcX) * 4
      const dstIdx = (py * size + px) * 4

      // Copy with noise
      const noise = (Math.random() - 0.5) * 15
      imageData.data[dstIdx] = Math.max(0, Math.min(255, imageData.data[srcIdx] + noise))
      imageData.data[dstIdx + 1] = Math.max(0, Math.min(255, imageData.data[srcIdx + 1] + noise))
      imageData.data[dstIdx + 2] = Math.max(0, Math.min(255, imageData.data[srcIdx + 2] + noise))
      imageData.data[dstIdx + 3] = 255
    }
  }
  ctx.putImageData(imageData, 0, 0)

  // Add a Great Red Spot equivalent — a darker oval storm
  ctx.save()
  ctx.translate(160, 140)
  ctx.scale(1.8, 1)
  ctx.beginPath()
  ctx.arc(0, 0, 12, 0, Math.PI * 2)
  ctx.restore()
  const stormGrad = ctx.createRadialGradient(160, 140, 0, 160, 140, 20)
  stormGrad.addColorStop(0, 'rgba(60, 20, 80, 0.6)')
  stormGrad.addColorStop(1, 'rgba(60, 20, 80, 0)')
  ctx.fillStyle = stormGrad
  ctx.fill()

  cachedTexture = new THREE.CanvasTexture(canvas)
  cachedTexture.wrapS = THREE.RepeatWrapping
  cachedTexture.wrapT = THREE.ClampToEdgeWrapping
  return cachedTexture
}
