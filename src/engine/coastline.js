import * as THREE from 'three'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import RING from './data/coastline_taiwan.json'

// Taiwan main-island coastline: one closed sea-level ring (county boundaries
// unioned, largest polygon's exterior, simplified to 100 m — 1,289 points).
// Only meaningful in real mode; procedural terrain hides it.
//
// W2: fat line. THREE.Line renders at 1 px on WebGL — this is Line2 +
// LineMaterial, which extrudes screen-space quads so linewidth is real pixels
// (worldUnits stays false). The material needs the viewport in its
// `resolution` uniform: we share the stage's live Vector2 (scene.js updates it
// on resize) by swapping it in as the uniform value — LineMaterial's
// `.resolution` setter would copy instead of share. fog: true works: the
// shader includes the fog chunks and the line sinks into the white wall.
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
export function createCoastline(params, resolution) {
  const material = new LineMaterial({
    color: new THREE.Color(params.coastlineColor), // independent ink (darker than contours)
    linewidth: params.coastlineWidth, // px
    transparent: true,
    opacity: params.coastlineOpacity,
    fog: true, // sinks into the white fog wall like the terrain does
  })
  material.uniforms.resolution.value = resolution // shared with scene.js's resize path
  const line = new Line2(new LineGeometry(), material)
  line.visible = false
  let built = false
  let seaY = 0 // sea level in world units (before the anti-z-fight lift)
  let lift = 0.03

  return {
    line,
    material,
    // called from the regenerateTerrain path — covers initial load, source
    // switches (noise ↔ real) and vertical-scale changes; the GUI toggle and
    // width/opacity/color sliders call it directly
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
        line.geometry.setPositions(pos)
        built = true
      }
      if (heightField) {
        seaY = (0 - heightField.datumM) * heightField.projection.K * params.demExaggeration
        line.position.y = seaY + lift
      }
      material.color.set(params.coastlineColor)
      material.linewidth = params.coastlineWidth
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
