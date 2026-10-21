import { useEffect, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Vector2 } from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'

/**
 * Bloom post-processing built on three's own EffectComposer + UnrealBloomPass
 * (replaces @react-three/postprocessing). Rendering at useFrame priority 1
 * takes over fiber's default render, so it works with frameloop="demand" too.
 */
const BloomEffect = ({ threshold, strength, radius }) => {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)
  const [parts, setParts] = useState(null)

  useEffect(() => {
    const composer = new EffectComposer(gl)
    const bloom = new UnrealBloomPass(new Vector2(1, 1), strength, radius, threshold)
    composer.addPass(new RenderPass(scene, camera))
    composer.addPass(bloom)
    composer.addPass(new OutputPass())
    setParts({ composer, bloom })
    return () => {
      composer.passes.forEach((p) => p.dispose?.())
      composer.dispose()
      setParts(null)
    }
  }, [gl, scene, camera])

  useEffect(() => {
    if (!parts) return
    parts.bloom.threshold = threshold
    parts.bloom.strength = strength
    parts.bloom.radius = radius
  }, [parts, threshold, strength, radius])

  useEffect(() => {
    if (!parts) return
    parts.composer.setPixelRatio(dpr)
    parts.composer.setSize(size.width, size.height)
  }, [parts, size, dpr])

  useFrame(() => {
    if (parts) parts.composer.render()
  }, 1)

  return null
}

export default BloomEffect
