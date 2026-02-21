import { useRef, memo } from 'react'
import { useFrame } from '@react-three/fiber'
import { ORBITAL_RADII, ORBITAL_SPEEDS, TIER_COLORS } from './celestialConstants'
import SatelliteGeometry from './SatelliteGeometry'

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

    // Pulsing opacity + rotation on composite group
    if (meshRef.current) {
      const opacity = 0.2 + Math.sin(time * 3 + index) * 0.1
      meshRef.current.traverse((child) => {
        if (!child.material) return;
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((mat) => {
          if (mat && 'opacity' in mat) {
            mat.opacity = opacity;
            if ('transparent' in mat) mat.transparent = opacity < 1;
          }
        });
      })
      meshRef.current.rotation.y += 0.01
      meshRef.current.rotation.x += 0.005
    }
  })

  return (
    <group ref={groupRef} position={[radius, 0, 0]}>
      <group ref={meshRef}>
        <SatelliteGeometry size={size} color={TIER_COLORS.satellite} wireframe />
      </group>
    </group>
  )
}, (prev, next) =>
  prev.index === next.index &&
  prev.total === next.total &&
  prev.order?.orderId === next.order?.orderId
)

IncomingOrder.displayName = 'IncomingOrder'

export default IncomingOrder
