import * as THREE from 'three'
import PEAKS from './data/peaks.json'

// Real Taiwan peaks (name / elev / lat / lon) projected into the streamed
// world via the shared projection (geo.js), so peaks land exactly on the
// height field. Search is centered on the pan target (peaks enter/leave as
// the world streams). Returns POIs shaped like hud3d's findPois() output,
// or [] when no catalogued peak falls inside `radius` of `center`.

export function findRealPeaks(heightField, sample, toFeet, center, radius, { limit = 6, minSep = 1.5 } = {}) {
  const proj = heightField.projection

  const inRange = []
  for (const p of PEAKS) {
    const { x, z } = proj.lonLatToWorld(p.lon, p.lat)
    if (Math.hypot(x - center.x, z - center.z) > radius) continue
    inRange.push({ ...p, x, z })
  }

  // highest first, drop near-duplicates (twin summits crowd their labels);
  // P2 far views raise minSep with the camera distance so the island view
  // spreads its few labels instead of stacking the central range
  inRange.sort((a, b) => b.elev - a.elev)
  const picked = []
  for (const p of inRange) {
    if (picked.every((q) => Math.hypot(q.x - p.x, q.z - p.z) >= minSep)) {
      picked.push(p)
      if (picked.length === limit) break
    }
  }

  return picked.map((p) => {
    const h = sample(p.x, p.z) // marker height comes from the height field, not the catalogue
    return {
      x: p.x,
      z: p.z,
      h,
      id: `${p.name} ${Math.round(p.elev)}`,
      kind: 'PEAK',
      feet: toFeet(h),
      grid: `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`,
      top: new THREE.Vector3(p.x, h + 2.1, p.z),
    }
  })
}
