import * as THREE from 'three'

let cachedTextures = null

/**
 * Procedural chunky rock texture set for asteroids.
 * Includes map, bumpMap, and an 'ore' emissive map.
 */
export const getRockTexture = () => {
  if (cachedTextures) return cachedTextures

  const size = 512
  const canvas = document.createElement('canvas')
  const bumpCanvas = document.createElement('canvas')
  const oreCanvas = document.createElement('canvas')
  
  canvas.width = size; canvas.height = size
  bumpCanvas.width = size; bumpCanvas.height = size
  oreCanvas.width = size; oreCanvas.height = size
  
  const ctx = canvas.getContext('2d')
  const btx = bumpCanvas.getContext('2d')
  const otx = oreCanvas.getContext('2d')

  // 1. Base Rocky Color (Dark slate/umber)
  ctx.fillStyle = '#4B5563'
  ctx.fillRect(0, 0, size, size)
  
  // 2. Chunky Noise/Cellular pattern
  for (let i = 0; i < 40; i++) {
    const x = Math.random() * size
    const y = Math.random() * size
    const r = 20 + Math.random() * 60
    
    // Rock patches
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r)
    const color = Math.random() > 0.5 ? '#374151' : '#1F2937'
    grad.addColorStop(0, color)
    grad.addColorStop(1, 'transparent')
    ctx.fillStyle = grad
    ctx.fillRect(x - r, y - r, r * 2, r * 2)
    
    // Bump (raised plateaus)
    const bgrad = btx.createRadialGradient(x, y, 0, x, y, r)
    bgrad.addColorStop(0, 'rgba(200, 200, 200, 0.5)')
    bgrad.addColorStop(1, 'rgba(128, 128, 128, 0)')
    btx.fillStyle = bgrad
    btx.fillRect(x - r, y - r, r * 2, r * 2)
  }

  // 3. Ore Veins (The No Man's Sky glow)
  otx.fillStyle = '#000000'
  otx.fillRect(0, 0, size, size)
  
  const oreCount = 10 + Math.floor(Math.random() * 10)
  for (let i = 0; i < oreCount; i++) {
    const ox = Math.random() * size
    const oy = Math.random() * size
    const or = 2 + Math.random() * 8
    
    // Glowing spots
    const ograd = otx.createRadialGradient(ox, oy, 0, ox, oy, or)
    ograd.addColorStop(0, '#FCD34D') // Gold/Amber ore
    ograd.addColorStop(0.5, '#B45309')
    ograd.addColorStop(1, 'transparent')
    otx.fillStyle = ograd
    otx.beginPath()
    otx.arc(ox, oy, or, 0, Math.PI * 2)
    otx.fill()
    
    // Also add to diffuse so it's visible without bloom
    ctx.fillStyle = '#FBBF24'
    ctx.beginPath()
    ctx.arc(ox, oy, or * 0.5, 0, Math.PI * 2)
    ctx.fill()
  }

  cachedTextures = {
    map: new THREE.CanvasTexture(canvas),
    bumpMap: new THREE.CanvasTexture(bumpCanvas),
    emissiveMap: new THREE.CanvasTexture(oreCanvas)
  }

  Object.values(cachedTextures).forEach(t => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping
  })

  return cachedTextures
}
