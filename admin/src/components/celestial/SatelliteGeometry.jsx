import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

const OUTLINE_OPACITY = 0.55

const TronOutline = ({ geometry, color, scale = 1.03 }) => (
  <lineSegments geometry={geometry} scale={scale}>
    <lineBasicMaterial color={color} transparent opacity={OUTLINE_OPACITY} />
  </lineSegments>
)

/**
 * Satellite-shaped composite geometry:
 * Central rectangular bus + two solar panel wings + antenna cone.
 * Enhanced with "blinking" status LEDs and metallic materials.
 */
const SatelliteGeometry = ({ size, color, emissiveInt, wireframe }) => {
  const busW = size * 0.7
  const busH = size * 0.5
  const busD = size * 0.7
  const panelW = size * 1.2
  const panelH = size * 0.05
  const panelD = size * 0.5
  const antennaR = size * 0.08
  const antennaH = size * 0.4
  const outlineColor = new THREE.Color('#60A5FA').lerp(new THREE.Color(color), 0.35)
  const busEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(busW, busH, busD))
  const panelEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(panelW, panelH, panelD))
  const antennaEdges = new THREE.EdgesGeometry(new THREE.ConeGeometry(antennaR, antennaH, 6))

  const ledRef = useRef()

  useFrame((state) => {
    if (ledRef.current) {
      // Blinking red status LED
      ledRef.current.material.emissiveIntensity = 2 + Math.sin(state.clock.elapsedTime * 10) * 2
    }
  })

  if (wireframe) {
    return (
      <group>
        {/* Bus */}
        <mesh>
          <boxGeometry args={[busW, busH, busD]} />
          <meshBasicMaterial color={color} wireframe transparent opacity={0.3} />
        </mesh>
        {/* Left panel */}
        <mesh position={[-(busW / 2 + panelW / 2), 0, 0]}>
          <boxGeometry args={[panelW, panelH, panelD]} />
          <meshBasicMaterial color={color} wireframe transparent opacity={0.3} />
        </mesh>
        {/* Right panel */}
        <mesh position={[(busW / 2 + panelW / 2), 0, 0]}>
          <boxGeometry args={[panelW, panelH, panelD]} />
          <meshBasicMaterial color={color} wireframe transparent opacity={0.3} />
        </mesh>
        {/* Antenna */}
        <mesh position={[0, busH / 2 + antennaH / 2, 0]}>
          <coneGeometry args={[antennaR, antennaH, 6]} />
          <meshBasicMaterial color={color} wireframe transparent opacity={0.3} />
        </mesh>
      </group>
    )
  }

  return (
    <group>
      {/* Central bus — metallic chrome/silver */}
      <mesh>
        <boxGeometry args={[busW, busH, busD]} />
        <meshStandardMaterial
          color="#CBD5E1"
          emissive={outlineColor}
          emissiveIntensity={emissiveInt}
          roughness={0.2}
          metalness={0.92}
        />
      </mesh>
      <TronOutline geometry={busEdges} color={outlineColor} />
      
      {/* Small status light */}
      <mesh ref={ledRef} position={[busW / 2, busH / 4, busD / 2]}>
        <sphereGeometry args={[size * 0.05, 8, 8]} />
        <meshStandardMaterial color="#EF4444" emissive="#EF4444" emissiveIntensity={2} />
      </mesh>

      {/* Solar panel wings — deep blue tech pattern look */}
      <group>
        <mesh position={[-(busW / 2 + panelW / 2), 0, 0]}>
          <boxGeometry args={[panelW, panelH, panelD]} />
          <meshStandardMaterial
            color="#1D4ED8"
            emissive="#60A5FA"
            emissiveIntensity={0.35}
            roughness={0.1}
            metalness={0.8}
          />
        </mesh>
        <group position={[-(busW / 2 + panelW / 2), 0, 0]}>
          <TronOutline geometry={panelEdges} color="#60A5FA" scale={1.04} />
        </group>
        <mesh position={[(busW / 2 + panelW / 2), 0, 0]}>
          <boxGeometry args={[panelW, panelH, panelD]} />
          <meshStandardMaterial
            color="#1D4ED8"
            emissive="#60A5FA"
            emissiveIntensity={0.35}
            roughness={0.1}
            metalness={0.8}
          />
        </mesh>
        <group position={[(busW / 2 + panelW / 2), 0, 0]}>
          <TronOutline geometry={panelEdges} color="#60A5FA" scale={1.04} />
        </group>
      </group>

      {/* Antenna cone */}
      <mesh position={[0, busH / 2 + antennaH / 2, 0]}>
        <coneGeometry args={[antennaR, antennaH, 6]} />
        <meshStandardMaterial
          color="#94A3B8"
          emissive={outlineColor}
          emissiveIntensity={emissiveInt * 0.8}
          roughness={0.3}
          metalness={0.7}
        />
      </mesh>
      <group position={[0, busH / 2 + antennaH / 2, 0]}>
        <TronOutline geometry={antennaEdges} color={outlineColor} scale={1.05} />
      </group>
    </group>
  )
}

export default SatelliteGeometry
