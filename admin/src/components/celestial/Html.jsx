import { useEffect, useMemo, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { useFrame, useThree } from '@react-three/fiber'
import { Vector3 } from 'three'

/**
 * Minimal DOM overlay anchored to a 3D point (relative to the parent object).
 * Children render in a separate React root appended next to the canvas and are
 * repositioned every frame; hidden while the anchor is behind the camera.
 */
const Html = ({ position = [0, 0, 0], children, style }) => {
  const camera = useThree(s => s.camera)
  const size = useThree(s => s.size)
  const gl = useThree(s => s.gl)
  const groupRef = useRef()
  const world = useMemo(() => new Vector3(), [])
  const el = useMemo(() => document.createElement('div'), [])
  const rootRef = useRef(null)

  useEffect(() => {
    const target = gl.domElement.parentNode
    Object.assign(el.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none', willChange: 'transform' })
    target.appendChild(el)
    const root = createRoot(el)
    rootRef.current = root
    return () => {
      rootRef.current = null
      root.unmount()
      target.removeChild(el)
    }
  }, [gl, el])

  useEffect(() => {
    rootRef.current?.render(<div style={style}>{children}</div>)
  })

  useFrame(() => {
    const group = groupRef.current
    if (!group) return
    group.updateWorldMatrix(true, false)
    world.setFromMatrixPosition(group.matrixWorld).project(camera)
    const visible = world.z < 1 && world.z > -1
    el.style.display = visible ? '' : 'none'
    if (!visible) return
    const x = (world.x * 0.5 + 0.5) * size.width
    const y = (-world.y * 0.5 + 0.5) * size.height
    el.style.transform = `translate3d(${x}px,${y}px,0) translate3d(-50%,-50%,0)`
  })

  return <group ref={groupRef} position={position} />
}

export default Html
