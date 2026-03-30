import * as THREE from 'three'

let cachedTextures = null

/**
 * Procedural canvas-based lunar surface texture set.
 * Returns { map, bumpMap, roughnessMap }.
 * Created once and shared by all moon instances.
 */
export const getMoonTexture = () => {
  if (cachedTextures) return cachedTextures

  const size = 512 // Increased resolution for better detail
  const canvas = document.createElement('canvas')
  const bumpCanvas = document.createElement('canvas')
  const roughCanvas = document.createElement('canvas')
  
  canvas.width = size
  canvas.height = size
  bumpCanvas.width = size
  bumpCanvas.height = size
  roughCanvas.width = size
  roughCanvas.height = size
  
  const ctx = canvas.getContext('2d')
  const btx = bumpCanvas.getContext('2d')
  const rtx = roughCanvas.getContext('2d')

  // --- Base Surface (Highlands) ---
  // A bit warmer/colder mix for base
  ctx.fillStyle = '#9CA3AF' 
  ctx.fillRect(0, 0, size, size)
  
  // Bump base (neutral)
  btx.fillStyle = '#808080'
  btx.fillRect(0, 0, size, size)
  
  // Roughness base (high)
  rtx.fillStyle = '#B0B0B0'
  rtx.fillRect(0, 0, size, size)

  // --- Fine Noise (Granularity) ---
  const imageData = ctx.getImageData(0, 0, size, size)
  const bumpData = btx.getImageData(0, 0, size, size)
  for (let i = 0; i < imageData.data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 40
    imageData.data[i] += noise
    imageData.data[i + 1] += noise
    imageData.data[i + 2] += noise
    
    // Add noise to bump for fine surface grain
    bumpData.data[i] += (Math.random() - 0.5) * 15
    bumpData.data[i+1] += (Math.random() - 0.5) * 15
    bumpData.data[i+2] += (Math.random() - 0.5) * 15
  }
  ctx.putImageData(imageData, 0, 0)
  btx.putImageData(bumpData, 0, 0)

  // --- Maria (Dark Basalt Plains) ---
  const mariaCount = 5 + Math.floor(Math.random() * 4)
  for (let i = 0; i < mariaCount; i++) {
    const mx = Math.random() * size
    const my = Math.random() * size
    const mr = 40 + Math.random() * 80
    
    // Diffuse Map Maria
    const grad = ctx.createRadialGradient(mx, my, 0, mx, my, mr)
    grad.addColorStop(0, 'rgba(45, 45, 50, 0.7)')
    grad.addColorStop(0.6, 'rgba(55, 55, 60, 0.4)')
    grad.addColorStop(1, 'rgba(60, 60, 65, 0)')
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(mx, my, mr, 0, Math.PI * 2)
    ctx.fill()
    
    // Bump Map Maria (lower elevation)
    const bgrad = btx.createRadialGradient(mx, my, 0, mx, my, mr)
    bgrad.addColorStop(0, 'rgba(100, 100, 100, 1)') // darker = lower
    bgrad.addColorStop(1, 'rgba(128, 128, 128, 0)')
    btx.fillStyle = bgrad
    btx.beginPath()
    btx.arc(mx, my, mr, 0, Math.PI * 2)
    btx.fill()
    
    // Roughness Map Maria (smoother)
    const rgrad = rtx.createRadialGradient(mx, my, 0, mx, my, mr)
    rgrad.addColorStop(0, 'rgba(80, 80, 80, 1)') // darker = smoother
    rgrad.addColorStop(1, 'rgba(176, 176, 176, 0)')
    rtx.fillStyle = rgrad
    rtx.beginPath()
    rtx.arc(mx, my, mr, 0, Math.PI * 2)
    rtx.fill()
  }

  // --- Craters (High Frequency Detail) ---
  const craterCount = 40 + Math.floor(Math.random() * 30)
  for (let i = 0; i < craterCount; i++) {
    const cx = Math.random() * size
    const cy = Math.random() * size
    const cr = 2 + Math.random() * 20
    const depth = 0.3 + Math.random() * 0.4

    // Diffuse Map Crater
    // Rim highlight
    ctx.beginPath()
    ctx.arc(cx, cy, cr + 1.2, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(220, 220, 230, ${0.2 * depth})`
    ctx.lineWidth = 1.2
    ctx.stroke()
    
    // Crater floor
    ctx.beginPath()
    ctx.arc(cx, cy, cr, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(40, 40, 45, ${depth})`
    ctx.fill()
    
    // Bump Map Crater
    // Rim highlight (raised)
    btx.beginPath()
    btx.arc(cx, cy, cr + 1, 0, Math.PI * 2)
    btx.strokeStyle = 'rgba(160, 160, 160, 0.5)' // lighter = higher
    btx.lineWidth = 1.5
    btx.stroke()
    
    // Pit (indented)
    btx.beginPath()
    btx.arc(cx, cy, cr, 0, Math.PI * 2)
    btx.fillStyle = 'rgba(100, 100, 100, 0.8)' // darker = deeper
    btx.fill()
    
    // Occasional Ray System (lighter streaks from large craters)
    if (cr > 12 && Math.random() > 0.7) {
      const rays = 8 + Math.floor(Math.random() * 12)
      for (let r = 0; r < rays; r++) {
        const angle = Math.random() * Math.PI * 2
        const rayLen = cr * (2 + Math.random() * 4)
        const rayGrad = ctx.createLinearGradient(cx, cy, cx + Math.cos(angle) * rayLen, cy + Math.sin(angle) * rayLen)
        rayGrad.addColorStop(0, 'rgba(230, 230, 240, 0.2)')
        rayGrad.addColorStop(1, 'rgba(230, 230, 240, 0)')
        ctx.strokeStyle = rayGrad
        ctx.lineWidth = 0.5 + Math.random()
        ctx.beginPath()
        ctx.moveTo(cx, cy)
        ctx.lineTo(cx + Math.cos(angle) * rayLen, cy + Math.sin(angle) * rayLen)
        ctx.stroke()
      }
    }
  }

  cachedTextures = {
    map: new THREE.CanvasTexture(canvas),
    bumpMap: new THREE.CanvasTexture(bumpCanvas),
    roughnessMap: new THREE.CanvasTexture(roughCanvas)
  }
  
  // Set texture properties for all
  Object.values(cachedTextures).forEach(t => {
    t.wrapS = THREE.RepeatWrapping
    t.wrapT = THREE.RepeatWrapping
    t.anisotropy = 4 // Sharper detail at angles
  })

  return cachedTextures
}
