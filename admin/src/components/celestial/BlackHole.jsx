import { useRef, useMemo, memo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { getBodySize, bodyPropsEqual } from './celestialConstants'
import { NOISE_GLSL } from './noiseGLSL'
import CelestialTooltip from './CelestialTooltip'
import FresnelGlow from './FresnelGlow'

const DISK_VERT = /* glsl */`
  varying vec2 vPos2;
  void main() {
    vPos2 = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

// Accretion disk: radial temperature gradient (white-hot inner → deep red-brown
// outer), differential rotation (inner orbits faster) driving fbm turbulence
// streaks, and relativistic doppler beaming (approaching side brighter).
// Noise is sampled on (cos a, sin a) so there is no seam at the angle wrap.
const DISK_FRAG = /* glsl */`
  uniform float uTime;
  uniform float uInner;
  uniform float uOuter;
  varying vec2 vPos2;

  ${NOISE_GLSL}

  void main() {
    float r = length(vPos2);
    float t = clamp((r - uInner) / (uOuter - uInner), 0.0, 1.0);
    float angle = atan(vPos2.y, vPos2.x);

    float a2 = angle + uTime * mix(0.9, 0.22, t);
    vec3 np = vec3(cos(a2), sin(a2), 0.0) * 2.5 + vec3(0.0, 0.0, t * 6.0);
    float streak = fbm(np * 2.0);

    vec3 col = mix(vec3(1.0, 0.96, 0.88), vec3(1.0, 0.58, 0.14), smoothstep(0.0, 0.45, t));
    col = mix(col, vec3(0.5, 0.14, 0.03), smoothstep(0.45, 1.0, t));

    float doppler = 1.0 + 0.55 * sin(angle);
    float bright = (0.5 + streak * 0.75) * doppler;

    float fadeIn = smoothstep(0.0, 0.07, t);
    float fadeOut = 1.0 - smoothstep(0.72, 1.0, t);

    gl_FragColor = vec4(col * bright * fadeIn * fadeOut, 1.0);
  }
`

/**
 * Black hole - stationary at the center of the system
 * True black void core with thin near-horizontal accretion disk,
 * photon ring, and gravitational lensing glow.
 * Tooltip is pinned by parent (stays on last-hovered body)
 */
const BlackHole = memo(({ body, showTooltip, onHover, maxUsdcDeployed, baseCurrency = 'BTC' }) => {
  const photonRingRef = useRef()
  const photonRingOuterRef = useRef()
  const jetCoreRefs = useRef([])
  const jetHaloRefs = useRef([])

  const size = getBodySize(body.costBasis, maxUsdcDeployed) * 1.2
  const hasTP = body.tpPrice > 0

  const diskUniforms = useMemo(() => ({
    uTime: { value: 0 },
    uInner: { value: size * 1.12 },
    uOuter: { value: size * 2.2 },
  }), [size])

  useFrame((state) => {
    const time = state.clock.elapsedTime
    diskUniforms.uTime.value = time

    // Pulse the photon ring
    if (photonRingRef.current) {
      photonRingRef.current.material.opacity = 0.6 + Math.sin(time * 3) * 0.12
    }
    if (photonRingOuterRef.current) {
      photonRingOuterRef.current.material.opacity = 0.32 + Math.sin(time * 2.2 + 0.8) * 0.08
    }

    // Relativistic jets — anti-phase core/halo for depth effect
    const jetCore = 0.42 + Math.sin(time * 2.2) * 0.12
    const jetHalo = 0.16 + Math.sin(time * 2.2 + Math.PI) * 0.06
    jetCoreRefs.current.forEach(r => { if (r) r.material.opacity = jetCore })
    jetHaloRefs.current.forEach(r => { if (r) r.material.opacity = jetHalo })
  })

  // Disk tilt: nearly horizontal with a slight tilt for depth (80° from vertical)
  const diskTilt = Math.PI * 0.44
  const jetLen = size * 2.8
  const jetHalf = size + jetLen / 2

  return (
    <group position={[0, 0, 0]}>
      {/* Dark void core — true black, absorbs everything */}
      <mesh
        onPointerOver={(e) => { e.stopPropagation(); onHover(body.id) }}
      >
        <sphereGeometry args={[size, 32, 32]} />
        <meshBasicMaterial color="#000000" />
      </mesh>

      {/* Shadow sphere — slightly larger, ensures the core stays pitch black against bloom */}
      <mesh scale={1.08}>
        <sphereGeometry args={[size, 24, 24]} />
        <meshBasicMaterial color="#000000" />
      </mesh>

      {/* Photon ring — bright thin ring hugging the event horizon */}
      <mesh ref={photonRingRef} rotation={[diskTilt, 0, 0]}>
        <ringGeometry args={[size * 1.04, size * 1.1, 128]} />
        <meshBasicMaterial
          color="#FFF7ED"
          transparent
          opacity={0.72}
          side={THREE.DoubleSide}
        />
      </mesh>

      <mesh ref={photonRingOuterRef} rotation={[diskTilt, 0, 0]}>
        <ringGeometry args={[size * 1.11, size * 1.18, 128]} />
        <meshBasicMaterial
          color="#FDE68A"
          transparent
          opacity={0.3}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Accretion disk — shader: temperature gradient, doppler beaming,
          differential-rotation turbulence streaks */}
      <mesh rotation={[diskTilt, 0, 0]}>
        <ringGeometry args={[size * 1.12, size * 2.2, 128, 4]} />
        <shaderMaterial
          vertexShader={DISK_VERT}
          fragmentShader={DISK_FRAG}
          uniforms={diskUniforms}
          transparent
          depthWrite={false}
          side={THREE.DoubleSide}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Gravitational lensing glow — tight around event horizon */}
      <FresnelGlow size={size} scale={1.6} color="#991B1B" power={2.0} intensity={hasTP ? 0.35 : 0.25} pulse={hasTP ? 0 : 0.08} pulseSpeed={1.5} segments={16} />

      {/* Relativistic jets — bipolar beams along the rotation axis */}
      <mesh ref={el => { jetCoreRefs.current[0] = el }} position={[0, jetHalf, 0]}>
        <cylinderGeometry args={[size * 0.02, size * 0.09, jetLen, 8, 1, true]} />
        <meshBasicMaterial color="#A5F3FC" transparent opacity={0.42} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh ref={el => { jetHaloRefs.current[0] = el }} position={[0, jetHalf, 0]}>
        <cylinderGeometry args={[size * 0.07, size * 0.22, jetLen, 8, 1, true]} />
        <meshBasicMaterial color="#67E8F9" transparent opacity={0.16} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh ref={el => { jetCoreRefs.current[1] = el }} position={[0, -jetHalf, 0]} rotation={[Math.PI, 0, 0]}>
        <cylinderGeometry args={[size * 0.02, size * 0.09, jetLen, 8, 1, true]} />
        <meshBasicMaterial color="#A5F3FC" transparent opacity={0.42} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh ref={el => { jetHaloRefs.current[1] = el }} position={[0, -jetHalf, 0]} rotation={[Math.PI, 0, 0]}>
        <cylinderGeometry args={[size * 0.07, size * 0.22, jetLen, 8, 1, true]} />
        <meshBasicMaterial color="#67E8F9" transparent opacity={0.16} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>

      {showTooltip && <CelestialTooltip body={body} position={[0, size + 0.8, 0]} maxUsdcDeployed={maxUsdcDeployed} baseCurrency={baseCurrency} />}
    </group>
  )
}, bodyPropsEqual)

BlackHole.displayName = 'BlackHole'

export default BlackHole
