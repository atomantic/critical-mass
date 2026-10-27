import { useMemo, useState, useCallback, useRef, useLayoutEffect } from 'react'
import { useThree } from '@react-three/fiber'
import BloomEffect from './BloomEffect'
import OrbitControlsLite from './OrbitControlsLite'
import Starfield from './Starfield'
import HierarchicalOrbit from './HierarchicalOrbit'
import IncomingOrder from './IncomingOrder'
import { sortCelestialBodies, getSystemBounds } from './orbitLayout'
import { fitCameraToBounds } from './cameraFit'

/**
 * Places the camera/controls so the whole orbital envelope is in frame. Runs on
 * mount and whenever the fitted distance or viewport aspect changes (a body or
 * layout change), never per frame, so manual orbit/zoom is left alone between.
 */
const CameraFit = ({ fit, controlsRef }) => {
  const camera = useThree(s => s.camera)
  const invalidate = useThree(s => s.invalidate)
  const [px, py, pz] = fit.position

  useLayoutEffect(() => {
    camera.position.set(px, py, pz)
    camera.far = fit.far
    camera.lookAt(0, 0, 0)
    camera.updateProjectionMatrix()
    const controls = controlsRef.current
    if (controls) {
      controls.minDistance = fit.minDistance
      controls.maxDistance = fit.maxDistance
      controls.target.set(0, 0, 0)
      controls.update()
    }
    invalidate()
  }, [camera, controlsRef, invalidate, px, py, pz, fit.far, fit.minDistance, fit.maxDistance])

  return null
}

/**
 * R3F scene composition: lights, stars, hierarchical orbits, bloom, controls.
 * Bodies are sorted largest-first; the largest sits at center and each
 * subsequent body orbits the next-larger one in a nested chain.
 */
const CelestialScene = ({ bodies = [], buyOrders = [], maxUsdcDeployed, baseCurrency = 'BTC', controlsRef, reducedMotion = false, fitCamera = false }) => {
  const sortedBodies = useMemo(() => sortCelestialBodies(bodies), [bodies])

  // Opt-in framing (previews): derive the camera from the actual hierarchy
  // bounds instead of the caller's fixed camera.
  const aspect = useThree(s => s.size.width / s.size.height)
  const fov = useThree(s => s.camera.fov)
  const bounds = useMemo(() => getSystemBounds(bodies, maxUsdcDeployed), [bodies, maxUsdcDeployed])
  const fit = useMemo(
    () => (fitCamera ? fitCameraToBounds(bounds, { aspect, fov }) : null),
    [fitCamera, bounds, aspect, fov],
  )
  const internalControlsRef = useRef(null)
  const activeControlsRef = controlsRef ?? internalControlsRef

  const hasHighTier = bodies.some(b => ['sun', 'hypergiant', 'nebula', 'galaxy', 'black_hole'].includes(b.tier))
  const hasBlackHole = bodies.some(b => b.tier === 'black_hole')

  // Pinned tooltip: stays on last-hovered body until a different one is hovered
  const [activeBodyId, setActiveBodyId] = useState(null)
  const onBodyHover = useCallback((bodyId) => setActiveBodyId(bodyId), [])

  return (
    <>
      {/* Camera controls — pan enabled for better navigation */}
      <OrbitControlsLite
        ref={activeControlsRef}
        autoRotate={!reducedMotion}
        autoRotateSpeed={0.3}
        enablePan
        panSpeed={0.8}
        minDistance={fit?.minDistance ?? 4}
        maxDistance={fit?.maxDistance ?? 40}
        maxPolarAngle={Math.PI * 0.85}
        minPolarAngle={Math.PI * 0.15}
      />
      {fit && <CameraFit fit={fit} controlsRef={activeControlsRef} />}

      {/* Fog for depth — keep it subtle so the scene retains contrast */}
      <fog attach="fog" args={['#111827', fit?.fogNear ?? 38, fit?.fogFar ?? 96]} />

      {/* Ambient and Global Depth Lighting */}
      <hemisphereLight intensity={0.32} groundColor="#020617" color="#C7D2FE" />
      <ambientLight intensity={hasHighTier ? 0.24 : 0.42} />

      {/* Central point light - amber/red glow from center */}
      <pointLight
        position={[0, 0, 0]}
        color={hasBlackHole ? '#EF4444' : '#F59E0B'}
        intensity={hasHighTier ? 4.0 : 2.0}
        distance={50}
        decay={1.5}
      />

      {/* Secondary fill lights for visibility on dark sides */}
      <pointLight position={[0, 10, 0]} color="#ffffff" intensity={0.6} distance={34} decay={1.5} />
      <pointLight position={[0, -10, 0]} color="#60A5FA" intensity={0.35} distance={34} decay={2} />

      {/* Rim fill light */}
      <directionalLight position={[5, 3, 5]} intensity={0.45} color="#ffffff" />
      <directionalLight position={[-4, 2, 6]} intensity={0.2} color="#FDBA74" />

      {/* Multi-layer starfield background */}
      <Starfield radius={60} depth={50} count={1800} factor={3.2} saturation={0.15} seed={1} />
      <Starfield radius={100} depth={80} count={1600} factor={2.1} saturation={0.25} seed={2} />
      <Starfield radius={140} depth={110} count={2400} factor={1.2} saturation={0.4} seed={3} />

      {/* Hierarchical celestial bodies - largest at center, each smaller orbits the next-larger */}
      <HierarchicalOrbit
        bodies={sortedBodies}
        activeBodyId={activeBodyId}
        onBodyHover={onBodyHover}
        maxUsdcDeployed={maxUsdcDeployed}
        baseCurrency={baseCurrency}
      />

      {/* Incoming buy orders as wireframe satellites */}
      {buyOrders.map((order, i) => (
        <IncomingOrder
          key={order.orderId || i}
          order={order}
          index={i}
          total={buyOrders.length}
        />
      ))}

      {/* Bloom post-processing */}
      <BloomEffect threshold={0.75} strength={0.25} radius={0.45} smoothWidth={0.18} />
    </>
  )
}

export default CelestialScene
