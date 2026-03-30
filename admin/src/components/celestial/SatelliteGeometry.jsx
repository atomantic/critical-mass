import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

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
          color="#94A3B8"
          emissive={color}
          emissiveIntensity={emissiveInt * 0.3}
          roughness={0.2}
          metalness={0.9}
        />
      </mesh>
      
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
            color="#1E3A8A"
            emissive="#3B82F6"
            emissiveIntensity={0.1}
            roughness={0.1}
            metalness={0.8}
          />
        </mesh>
        <mesh position={[(busW / 2 + panelW / 2), 0, 0]}>
          <boxGeometry args={[panelW, panelH, panelD]} />
          <meshStandardMaterial
            color="#1E3A8A"
            emissive="#3B82F6"
            emissiveIntensity={0.1}
            roughness={0.1}
            metalness={0.8}
          />
        </mesh>
      </group>

      {/* Antenna cone */}
      <mesh position={[0, busH / 2 + antennaH / 2, 0]}>
        <coneGeometry args={[antennaR, antennaH, 6]} />
        <meshStandardMaterial
          color="#64748B"
          emissive={color}
          emissiveIntensity={emissiveInt * 0.2}
          roughness={0.3}
          metalness={0.7}
        />
      </mesh>
    </group>
  )
}

export default SatelliteGeometry
