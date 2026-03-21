import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

/**
 * Procedural planet surface texture with continent-like features.
 */
const getPlanetTexture = () => {
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

  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  return tex
}

let cachedPlanetTexture = null
const getOrCreatePlanetTexture = () => {
  if (!cachedPlanetTexture) cachedPlanetTexture = getPlanetTexture()
  return cachedPlanetTexture
}

/**
 * Planet with atmosphere glow and improved Saturn-like rings for merged bodies.
 * Uses textured sphere with atmospheric limb glow.
 */
const PlanetGeometry = ({ size, color, emissiveInt, mergeCount = 0 }) => {
  const atmosphereRef = useRef()
  const texture = useMemo(() => getOrCreatePlanetTexture(), [])
  const hasRings = mergeCount > 2

  useFrame((state) => {
    if (atmosphereRef.current) {
      const time = state.clock.elapsedTime
      atmosphereRef.current.material.opacity = 0.12 + Math.sin(time * 0.8) * 0.03
    }
  })

  return (
    <group>
      {/* Planet surface */}
      <mesh>
        <sphereGeometry args={[size, 32, 32]} />
        <meshStandardMaterial
          map={texture}
          color={color}
          emissive={color}
          emissiveIntensity={emissiveInt}
          roughness={0.5}
          metalness={0.2}
        />
      </mesh>

      {/* Atmospheric limb glow */}
      <mesh ref={atmosphereRef} scale={1.12}>
        <sphereGeometry args={[size, 16, 16]} />
        <meshBasicMaterial
          color="#60A5FA"
          transparent
          opacity={0.12}
          side={THREE.BackSide}
        />
      </mesh>

      {/* Saturn-like rings for merged planets (mergeCount > 2) */}
      {hasRings && (
        <group rotation={[Math.PI / 3, 0, 0]}>
          {/* Inner ring — brighter */}
          <mesh>
            <ringGeometry args={[size * 1.3, size * 1.6, 64]} />
            <meshBasicMaterial
              color={color}
              transparent
              opacity={0.3}
              side={THREE.DoubleSide}
            />
          </mesh>
          {/* Cassini division gap */}
          <mesh>
            <ringGeometry args={[size * 1.6, size * 1.65, 64]} />
            <meshBasicMaterial
              color="#000000"
              transparent
              opacity={0.15}
              side={THREE.DoubleSide}
            />
          </mesh>
          {/* Outer ring — fainter */}
          <mesh>
            <ringGeometry args={[size * 1.65, size * 2.0, 64]} />
            <meshBasicMaterial
              color={color}
              transparent
              opacity={0.15}
              side={THREE.DoubleSide}
            />
          </mesh>
        </group>
      )}
    </group>
  )
}

export default PlanetGeometry
