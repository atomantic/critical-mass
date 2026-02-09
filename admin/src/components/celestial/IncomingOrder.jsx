import { useRef, memo } from 'react'
import { useFrame } from '@react-three/fiber'
import { ORBITAL_RADII, ORBITAL_SPEEDS, TIER_COLORS } from './celestialConstants'

/**
 * Open buy orders rendered as wireframe "under construction" satellites
 */
const IncomingOrder = memo(({ order, index, total }) => {
  const groupRef = useRef()
  const meshRef = useRef()

  const radius = ORBITAL_RADII.satellite + 1 // Slightly outside satellite orbit
  const speed = ORBITAL_SPEEDS.satellite * 0.7
  const angleOffset = total > 1 ? (index / total) * Math.PI * 2 + Math.PI : Math.PI // Offset from real satellites
  const size = 0.08

  useFrame((state) => {
    if (!groupRef.current) return
    const time = state.clock.elapsedTime
    const angle = time * speed + angleOffset

    groupRef.current.position.set(
      Math.cos(angle) * radius,
      0,
      Math.sin(angle) * radius
    )

    // Pulsing opacity
    if (meshRef.current) {
      meshRef.current.material.opacity = 0.2 + Math.sin(time * 3 + index) * 0.1
      meshRef.current.rotation.y += 0.01
      meshRef.current.rotation.x += 0.005
    }
  })

  return (
    <group ref={groupRef} position={[radius, 0, 0]}>
      <mesh ref={meshRef}>
        <sphereGeometry args={[size, 12, 12]} />
        <meshBasicMaterial
          color={TIER_COLORS.satellite}
          wireframe
          transparent
          opacity={0.3}
        />
      </mesh>
    </group>
  )
}, (prev, next) =>
  prev.index === next.index &&
  prev.total === next.total &&
  prev.order?.orderId === next.order?.orderId
)

IncomingOrder.displayName = 'IncomingOrder'

export default IncomingOrder
