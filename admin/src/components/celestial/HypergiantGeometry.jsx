import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { NOISE_GLSL, SURFACE_VERT } from './noiseGLSL'
import FresnelGlow from './FresnelGlow'

// Turbulent latitude bands: fbm-warped sine bands flowing over time, with
// pale storm swirls, in the hypergiant's violet palette. Limb-darkened.
const HYPERGIANT_FRAG = /* glsl */`
  uniform float uTime;
  varying vec3 vPos;
  varying vec3 vNormal;
  varying vec3 vViewDir;

  ${NOISE_GLSL}

  void main() {
    vec3 p = normalize(vPos);
    float warp = fbm(p * 3.0 + vec3(uTime * 0.05, 0.0, uTime * 0.03)) * 0.4;
    float bands = sin((p.y + warp) * 12.0 + uTime * 0.08) * 0.5 + 0.5;
    float storms = fbm(p * 6.0 - vec3(uTime * 0.04, uTime * 0.02, 0.0));

    vec3 col = mix(vec3(0.42, 0.18, 0.72), vec3(0.85, 0.55, 1.0), bands);
    col = mix(col, vec3(0.98, 0.9, 1.0), smoothstep(0.68, 0.95, storms));

    float limb = clamp(dot(normalize(vNormal), normalize(vViewDir)), 0.0, 1.0);
    col *= mix(0.5, 1.05, pow(limb, 0.65));

    gl_FragColor = vec4(col, 1.0);
  }
`

/**
 * Hypergiant: animated fbm gas-band shader surface with fresnel envelope
 * and rotating equatorial band rings.
 */
const HypergiantGeometry = ({ size }) => {
  const bandRef = useRef()
  const outerBandRef = useRef()
  const uniforms = useMemo(() => ({ uTime: { value: 0 } }), [])

  useFrame((state) => {
    const time = state.clock.elapsedTime
    uniforms.uTime.value = time
    if (bandRef.current) {
      bandRef.current.rotation.z += 0.0012
      bandRef.current.material.opacity = 0.26 + Math.sin(time * 1.9) * 0.04
    }
    if (outerBandRef.current) {
      outerBandRef.current.rotation.z -= 0.0009
      outerBandRef.current.material.opacity = 0.16 + Math.sin(time * 1.4 + 0.8) * 0.03
    }
  })

  return (
    <group>
      <mesh>
        <sphereGeometry args={[size, 48, 48]} />
        <shaderMaterial vertexShader={SURFACE_VERT} fragmentShader={HYPERGIANT_FRAG} uniforms={uniforms} />
      </mesh>

      <FresnelGlow size={size} scale={1.28} color="#C084FC" power={2.2} intensity={0.85} pulse={0.1} pulseSpeed={1.3} />

      <mesh ref={bandRef} rotation={[Math.PI * 0.48, 0, Math.PI * 0.12]}>
        <ringGeometry args={[size * 1.02, size * 1.12, 96]} />
        <meshBasicMaterial color="#E879F9" transparent opacity={0.26} side={THREE.DoubleSide} />
      </mesh>

      <mesh ref={outerBandRef} rotation={[Math.PI * 0.24, 0, -Math.PI * 0.16]}>
        <ringGeometry args={[size * 1.16, size * 1.28, 96]} />
        <meshBasicMaterial color="#A78BFA" transparent opacity={0.16} side={THREE.DoubleSide} />
      </mesh>

      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[size * 1.3, size * 1.62, 14, 1]} />
        <meshBasicMaterial color="#C084FC" transparent opacity={0.12} side={THREE.DoubleSide} wireframe />
      </mesh>
    </group>
  )
}

export default HypergiantGeometry
