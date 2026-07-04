import { useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

const VERT = /* glsl */`
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    vViewDir = normalize(-mvPos.xyz);
    gl_Position = projectionMatrix * mvPos;
  }
`

// Rendered on a BackSide-scaled sphere: |dot(N, V)| is 0 at the halo's outer
// silhouette and grows toward the occluded center, so brightness peaks right
// at the body's limb and falls off outward — a volumetric atmosphere look
// that flat-opacity shells can't produce.
const FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform float uPower;
  uniform float uIntensity;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    float rim = pow(abs(dot(normalize(vNormal), normalize(vViewDir))), uPower);
    gl_FragColor = vec4(uColor * rim * uIntensity, 1.0);
  }
`

/**
 * View-dependent atmospheric rim glow (fresnel), additively blended.
 * Replaces flat BackSide opacity spheres. `scale` may be a number or
 * [x, y, z] array for ellipsoid glows (nebula clouds).
 * `pulse` > 0 adds a sine wobble on intensity.
 */
const FresnelGlow = ({
  size,
  color,
  scale = 1.3,
  power = 2.5,
  intensity = 0.5,
  pulse = 0,
  pulseSpeed = 2,
  segments = 24,
}) => {
  const colorObj = useMemo(() => new THREE.Color(color), [color])
  const uniforms = useMemo(() => ({
    uColor: { value: new THREE.Color(color) },
    uPower: { value: power },
    uIntensity: { value: intensity },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [])

  useFrame((state) => {
    uniforms.uColor.value.copy(colorObj)
    uniforms.uPower.value = power
    uniforms.uIntensity.value = pulse > 0
      ? intensity + Math.sin(state.clock.elapsedTime * pulseSpeed) * pulse
      : intensity
  })

  return (
    <mesh scale={scale}>
      <sphereGeometry args={[size, segments, segments]} />
      <shaderMaterial
        vertexShader={VERT}
        fragmentShader={FRAG}
        uniforms={uniforms}
        transparent
        depthWrite={false}
        side={THREE.BackSide}
        blending={THREE.AdditiveBlending}
      />
    </mesh>
  )
}

export default FresnelGlow
