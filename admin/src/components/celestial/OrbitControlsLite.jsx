import { forwardRef, useEffect, useImperativeHandle, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

/**
 * Minimal OrbitControls wrapper. Remaining props are assigned to the controls
 * instance (autoRotate, enablePan, minDistance, polar limits, ...). The
 * instance is exposed through the forwarded ref (e.g. `ref.current.target`).
 */
const OrbitControlsLite = forwardRef((props, ref) => {
  const camera = useThree(s => s.camera)
  const domElement = useThree(s => s.gl.domElement)
  const invalidate = useThree(s => s.invalidate)
  const controls = useMemo(() => new OrbitControls(camera, domElement), [camera, domElement])

  useImperativeHandle(ref, () => controls, [controls])

  useEffect(() => {
    Object.assign(controls, props)
  })

  useEffect(() => {
    controls.addEventListener('change', invalidate)
    return () => {
      controls.removeEventListener('change', invalidate)
      controls.dispose()
    }
  }, [controls, invalidate])

  useFrame(() => controls.update(), -1)

  return null
})

export default OrbitControlsLite
