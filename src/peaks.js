import * as THREE from 'three'
import { TERRAIN_SIZE } from './terrain.js'
import PEAKS from './data/peaks.json'

// Real Taiwan peaks (name / elev / lat / lon) projected into the current DEM
// extent. Uses the same Web Mercator math as dem.js so peaks land exactly on
// the height field. Returns POIs shaped like hud3d's findPois() output, or []
// when no catalogued peak falls inside the loaded terrain.

export function findRealPeaks(dem, sample, toFeet) {
  const n = 2 ** dem.zoom
  const latRad = (dem.lat * Math.PI) / 180
  const cx = Math.floor(((dem.lon + 180) / 360) * n)
  const cy = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)
  const half = Math.floor(dem.size / 256 / 2)

  const inRange = []
  for (const p of PEAKS) {
    // fractional tile coords → mosaic pixel coords → scene xz
    const pLatRad = (p.lat * Math.PI) / 180
    const px = (((p.lon + 180) / 360) * n - (cx - half)) * 256
    const py = (((1 - Math.log(Math.tan(pLatRad) + 1 / Math.cos(pLatRad)) / Math.PI) / 2) * n - (cy - half)) * 256
    const x = (px / (dem.size - 1) - 0.5) * TERRAIN_SIZE
    const z = (py / (dem.size - 1) - 0.5) * TERRAIN_SIZE
    // keep a small margin so labels don't sit on the fogged mesh edge
    if (Math.abs(x) > TERRAIN_SIZE * 0.47 || Math.abs(z) > TERRAIN_SIZE * 0.47) continue
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
