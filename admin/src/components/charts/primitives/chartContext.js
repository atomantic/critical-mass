import { createContext, useContext } from 'react'

// Geometry a CartesianChart shares with the layers drawn inside it:
// plot = { x, y, width, height }, x(index) → px, y(axisId?) → that axis' linear scale.
export const ChartContext = createContext(null)

export const useChartContext = () => useContext(ChartContext)
