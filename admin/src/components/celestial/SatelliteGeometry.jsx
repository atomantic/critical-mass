/**
 * Satellite-shaped composite geometry:
 * Central rectangular bus + two solar panel wings + antenna cone.
 * All dimensions proportional to `size` parameter.
 * Accepts `wireframe` prop for IncomingOrder wireframe rendering.
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
      {/* Central bus — gray metallic */}
      <mesh>
        <boxGeometry args={[busW, busH, busD]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={emissiveInt}
          roughness={0.3}
          metalness={0.6}
        />
      </mesh>
      {/* Left solar panel — dark blue */}
      <mesh position={[-(busW / 2 + panelW / 2), 0, 0]}>
        <boxGeometry args={[panelW, panelH, panelD]} />
        <meshStandardMaterial
          color="#1E40AF"
          emissive="#1E40AF"
          emissiveIntensity={emissiveInt * 0.5}
          roughness={0.2}
          metalness={0.7}
        />
      </mesh>
      {/* Right solar panel — dark blue */}
      <mesh position={[(busW / 2 + panelW / 2), 0, 0]}>
        <boxGeometry args={[panelW, panelH, panelD]} />
        <meshStandardMaterial
          color="#1E40AF"
          emissive="#1E40AF"
          emissiveIntensity={emissiveInt * 0.5}
          roughness={0.2}
          metalness={0.7}
        />
      </mesh>
      {/* Antenna cone */}
      <mesh position={[0, busH / 2 + antennaH / 2, 0]}>
        <coneGeometry args={[antennaR, antennaH, 6]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={emissiveInt}
          roughness={0.3}
          metalness={0.6}
        />
      </mesh>
    </group>
  )
}

export default SatelliteGeometry
