import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { NOISE_GLSL, SURFACE_VERT } from './noiseGLSL'
import FresnelGlow from './FresnelGlow'

// Animated solar surface: two fbm layers (large convection + fine granulation)
// drifting at different rates, mapped through a deep-orange→amber→white ramp,
// with photospheric limb darkening. Bright center feeds bloom naturally.
const SUN_FRAG = /* glsl */`
  uniform float uTime;
  varying vec3 vPos;
  varying vec3 vNormal;
  varying vec3 vViewDir;

  ${NOISE_GLSL}

  void main() {
    vec3 p = normalize(vPos);
    float convection = fbm(p * 4.0 + vec3(uTime * 0.06, uTime * 0.04, 0.0));
    float granules = fbm(p * 10.0 - vec3(0.0, uTime * 0.09, uTime * 0.05));
    float t = clamp(convection * 0.7 + granules * 0.55, 0.0, 1.0);

    vec3 col = mix(vec3(0.72, 0.25, 0.05), vec3(1.0, 0.62, 0.16), smoothstep(0.15, 0.6, t));
    col = mix(col, vec3(1.0, 0.94, 0.78), smoothstep(0.6, 0.95, t));

    float limb = clamp(dot(normalize(vNormal), normalize(vViewDir)), 0.0, 1.0);
    col *= mix(0.55, 1.05, pow(limb, 0.6));

    gl_FragColor = vec4(col, 1.0);
  }
`

/**
 * Sun: animated fbm-noise photosphere (seamless — no texture UV seam),
 * fresnel corona layers, rotating band rings, and solar flare spokes.
 */
const SunGeometry = ({ size }) => {
  const innerBandRef = useRef()
  const outerBandRef = useRef()
  const flareSpokesRef = useRef()
  const uniforms = useMemo(() => ({ uTime: { value: 0 } }), [])

  useFrame((state) => {
    const time = state.clock.elapsedTime
    uniforms.uTime.value = time
    if (innerBandRef.current) {
      innerBandRef.current.rotation.z += 0.0022
      innerBandRef.current.material.opacity = 0.22 + Math.sin(time * 2.4) * 0.04
    }
    if (outerBandRef.current) {
      outerBandRef.current.rotation.z -= 0.0014
      outerBandRef.current.material.opacity = 0.14 + Math.sin(time * 1.8 + 1.2) * 0.03
    }
    if (flareSpokesRef.current) {
      flareSpokesRef.current.rotation.z += 0.0016
      flareSpokesRef.current.children.forEach((child, i) => {
        if (!child.material) return
        const base = i % 2 === 0 ? 0.22 : 0.13
        child.material.opacity = base + Math.sin(time * 3.2 + i * (Math.PI / 4)) * 0.08
      })
    }
  })

  return (
    <group>
      <mesh>
        <sphereGeometry args={[size, 48, 48]} />
        <shaderMaterial vertexShader={SURFACE_VERT} fragmentShader={SUN_FRAG} uniforms={uniforms} />
      </mesh>

      {/* Corona: inner hot rim + wide soft envelope */}
      <FresnelGlow size={size} scale={1.22} color="#FBBF24" power={2.0} intensity={0.9} pulse={0.12} pulseSpeed={1.6} />
      <FresnelGlow size={size} scale={1.55} color="#FDE68A" power={3.0} intensity={0.5} pulse={0.08} pulseSpeed={1.1} segments={16} />

      <mesh ref={innerBandRef} rotation={[Math.PI * 0.48, 0, Math.PI * 0.08]}>
        <ringGeometry args={[size * 1.03, size * 1.11, 96]} />
        <meshBasicMaterial color="#FEF3C7" transparent opacity={0.24} side={THREE.DoubleSide} />
      </mesh>

      <mesh ref={outerBandRef} rotation={[Math.PI * 0.22, 0, -Math.PI * 0.16]}>
        <ringGeometry args={[size * 1.18, size * 1.24, 96]} />
        <meshBasicMaterial color="#FDBA74" transparent opacity={0.14} side={THREE.DoubleSide} />
      </mesh>

      {/* Solar flare rays — 4 major + 4 minor alternating, spin slowly */}
      <group ref={flareSpokesRef} rotation={[Math.PI / 2, 0, 0]}>
        {Array.from({ length: 8 }, (_, i) => {
          const isMajor = i % 2 === 0
          const angle = (i / 8) * Math.PI * 2
          const rayLen = isMajor ? size * 0.62 : size * 0.38
          const rayWidth = isMajor ? size * 0.055 : size * 0.034
          const midR = size * (isMajor ? 1.55 : 1.42)
          return (
            <mesh
              key={i}
              position={[Math.cos(angle) * midR, Math.sin(angle) * midR, 0]}
              rotation={[0, 0, angle - Math.PI / 2]}
            >
              <planeGeometry args={[rayWidth, rayLen]} />
              <meshBasicMaterial
                color={isMajor ? '#FB923C' : '#FDE68A'}
                transparent
                opacity={isMajor ? 0.22 : 0.13}
                side={THREE.DoubleSide}
                blending={THREE.AdditiveBlending}
                depthWrite={false}
              />
            </mesh>
          )
        })}
      </group>
    </group>
  )
}

export default SunGeometry
