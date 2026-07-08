import * as THREE from 'three'
import RING from './data/coastline_taiwan.json'

// Taiwan main-island coastline: one closed sea-level ring (county boundaries
// unioned, largest polygon's exterior, simplified to 100 m — 1,289 points).
// Only meaningful in real mode; procedural terrain hides it.
//
// The ring is built once in world xz with y = 0 — the projection is anchored
// at the first DEM load and never rebuilt, so the horizontal geometry never
// changes. Sea level's world height DOES move with the vertical-scale datum
// math ((0 - datumM) * K * demExaggeration), so update() lifts the whole line
// via line.position.y instead of touching vertices.
//
// Anti-z-fight lift: 0.03 units at the near view, scaled up with fogScale for
// far views — depth-buffer precision degrades ~dist², so the fixed 0.03 falls
// BELOW precision at the island view (dist 850 → δz ≈ 0.09) and the terrain
// skin eats the line. Linear fogScale scaling stays comfortably above the
// precision curve across the whole dolly range while remaining sub-pixel.
export function createCoastline(params) {
  const material = new THREE.LineBasicMaterial({
    color: new THREE.Color(params.contourColor), // same ink as the contour lines
    transparent: true,
    opacity: params.coastlineOpacity,
    fog: true, // sinks into the white fog wall like the terrain does
  })
  const line = new THREE.Line(new THREE.BufferGeometry(), material)
  line.visible = false
  let built = false
  let seaY = 0 // sea level in world units (before the anti-z-fight lift)
  let lift = 0.03

  return {
    line,
    material,
    // called from the regenerateTerrain path — covers initial load, source
    // switches (noise ↔ real) and vertical-scale changes; the GUI toggle and
    // opacity slider call it directly
    update(params, heightField) {
      const show = params.source === 'real' && !!heightField && params.coastline
      if (show && !built) {
        const pos = new Float32Array(RING.length * 3)
        for (let i = 0; i < RING.length; i++) {
          const { x, z } = heightField.projection.lonLatToWorld(RING[i][0], RING[i][1])
          pos[i * 3] = x
          pos[i * 3 + 1] = 0
          pos[i * 3 + 2] = z
        }
        line.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3))
        built = true
      }
      if (heightField) {
        seaY = (0 - heightField.datumM) * heightField.projection.K * params.demExaggeration
        line.position.y = seaY + lift
      }
      material.opacity = params.coastlineOpacity
      line.visible = show
    },
    // per-frame (from the tick, alongside the other fogScale consumers)
    setFogScale(fogScale) {
      lift = 0.03 * fogScale
      line.position.y = seaY + lift
    },
  }
}
