import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

/**
 * Procedural sun surface texture — solar granulation with hot spots.
 */
const getSunTexture = () => {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')

  // Base warm yellow-orange
  ctx.fillStyle = '#FEF3C7'
  ctx.fillRect(0, 0, size, size)

  // Granulation cells — brighter spots with darker boundaries
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

  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  return tex
}

let cachedSunTexture = null
const getOrCreateSunTexture = () => {
  if (!cachedSunTexture) cachedSunTexture = getSunTexture()
  return cachedSunTexture
}

/**
 * Sun-specific geometry: textured sphere with corona layers and flare rays.
 * Uses MeshBasicMaterial (unlit) so bloom handles the glow.
 */
const SunGeometry = ({ size }) => {
  const coronaRef1 = useRef()
  const coronaRef2 = useRef()
  const texture = useMemo(() => getOrCreateSunTexture(), [])

  useFrame((state) => {
    const time = state.clock.elapsedTime
    // Pulsing corona layers
    if (coronaRef1.current) {
      coronaRef1.current.material.opacity = 0.12 + Math.sin(time * 2) * 0.04
      coronaRef1.current.rotation.y += 0.001
    }
    if (coronaRef2.current) {
      coronaRef2.current.material.opacity = 0.06 + Math.sin(time * 1.3 + 1) * 0.03
      coronaRef2.current.rotation.y -= 0.0008
    }
  })

  return (
    <group>
      {/* Core sun sphere with surface texture */}
      <mesh>
        <sphereGeometry args={[size, 32, 32]} />
        <meshBasicMaterial map={texture} />
      </mesh>

      {/* Inner corona — warm amber halo */}
      <mesh ref={coronaRef1} scale={1.25}>
        <sphereGeometry args={[size, 16, 16]} />
        <meshBasicMaterial
          color="#F59E0B"
          transparent
          opacity={0.12}
          side={THREE.BackSide}
        />
      </mesh>

      {/* Outer corona — wider, fainter */}
      <mesh ref={coronaRef2} scale={1.5}>
        <sphereGeometry args={[size, 12, 12]} />
        <meshBasicMaterial
          color="#FDE68A"
          transparent
          opacity={0.06}
          side={THREE.BackSide}
        />
      </mesh>

      {/* Solar prominences — thin rings at slight angles */}
      <mesh rotation={[Math.PI * 0.4, 0, Math.PI * 0.1]}>
        <ringGeometry args={[size * 1.02, size * 1.08, 64]} />
        <meshBasicMaterial
          color="#FEF3C7"
          transparent
          opacity={0.15}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  )
}

export default SunGeometry
