import * as THREE from 'three'
import PEAKS from './data/peaks.json'

// Real Taiwan peaks (name / elev / lat / lon) projected into the loaded chunk
// grid via the shared world projection (geo.js), so peaks land exactly on the
// height field. Returns POIs shaped like hud3d's findPois() output, or []
// when no catalogued peak falls inside the loaded terrain.

export function findRealPeaks(heightField, sample, toFeet) {
  const proj = heightField.projection
  // keep a small margin so labels don't sit on the fogged chunk-grid edge
  const limit = heightField.extentWorld * 0.47

  const inRange = []
  for (const p of PEAKS) {
    const { x, z } = proj.lonLatToWorld(p.lon, p.lat)
    if (Math.abs(x) > limit || Math.abs(z) > limit) continue
    inRange.push({ ...p, x, z })
  }

  // highest first, drop near-duplicates (twin summits crowd their labels)
  inRange.sort((a, b) => b.elev - a.elev)
  const picked = []
  for (const p of inRange) {
    if (picked.every((q) => Math.hypot(q.x - p.x, q.z - p.z) >= 1.5)) {
      picked.push(p)
      if (picked.length === 6) break
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
