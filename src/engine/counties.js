import * as THREE from 'three'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import BORDERS from './data/counties_internal_borders.json'

// County borders: the main island's INTERNAL county boundaries (33 polylines,
// ~11k vertices) — the coastline ring already draws the outer edge. Every
// vertex carries a baked DTM elevation, so the lines ride the ridgelines
// instead of floating at sea level. Real mode only, same as the coastline.
//
// All 33 lines merge into ONE LineSegments2 (segment pairs in a single
// instanced geometry = one draw call). Horizontal xz is projected once (the
// projection is anchored at the first DEM load and never rebuilt); vertical y
// is (elev - datumM) * K * demExaggeration, rewritten in place whenever the
// vertical scale changes — the interleaved buffer wraps our own Float32Array,
// so applyVertical() just mutates it and flags needsUpdate.
//
// Anti-z-fight lift: same fogScale-scaled scheme as the coastline (see
// coastline.js header), with a slightly higher base — these vertices sit ON
// the terrain skin (baked 20 m DTM vs the streamed tile mesh disagree by a
// few meters), not safely above it like the sea-level ring.
const LIFT_BASE = 0.05

export function createCounties(params, resolution) {
  const material = new LineMaterial({
    color: new THREE.Color(params.countiesColor),
    linewidth: params.countiesWidth, // px
    transparent: true,
    opacity: params.countiesOpacity,
    fog: true,
  })
  material.uniforms.resolution.value = resolution // shared with scene.js's resize path
  const mesh = new LineSegments2(new LineSegmentsGeometry(), material)
  mesh.visible = false

  // segment-pair buffers, baked once: [x1 y1 z1 x2 y2 z2] per segment + the
  // endpoints' raw elevations (meters) for vertical rewrites
  let seg = null // Float32Array(nSeg * 6)
  let elev = null // Float32Array(nSeg * 2)
  let nSeg = 0
  let geomInit = false
  let lastVScale = NaN
  let lift = LIFT_BASE

  function bake(projection) {
    nSeg = BORDERS.lines.reduce((n, l) => n + l.length - 1, 0)
    seg = new Float32Array(nSeg * 6)
    elev = new Float32Array(nSeg * 2)
    let s = 0
    for (const line of BORDERS.lines) {
      for (let i = 0; i < line.length - 1; i++) {
        const a = projection.lonLatToWorld(line[i][0], line[i][1])
        const b = projection.lonLatToWorld(line[i + 1][0], line[i + 1][1])
        seg[s * 6] = a.x
        seg[s * 6 + 2] = a.z
        seg[s * 6 + 3] = b.x
        seg[s * 6 + 5] = b.z
        elev[s * 2] = line[i][2]
        elev[s * 2 + 1] = line[i + 1][2]
        s++
      }
    }
  }

  // world y from baked elevation — same datum/K math as the terrain sampler
  function applyVertical(heightField, params) {
    const scale = heightField.projection.K * params.demExaggeration
    const datum = heightField.datumM
    if (scale === lastVScale) return
    lastVScale = scale
    for (let s = 0; s < nSeg; s++) {
      seg[s * 6 + 1] = (elev[s * 2] - datum) * scale
      seg[s * 6 + 4] = (elev[s * 2 + 1] - datum) * scale
    }
    if (!geomInit) {
      mesh.geometry.setPositions(seg) // instanced buffer wraps `seg` directly
      geomInit = true
    } else {
      mesh.geometry.attributes.instanceStart.data.needsUpdate = true
      mesh.geometry.computeBoundingBox()
      mesh.geometry.computeBoundingSphere()
    }
  }

  return {
    mesh,
    material,
    // regenerateTerrain path (initial load / source switch / vertical scale) +
    // the GUI toggle and width/opacity/color params
    update(params, heightField) {
      const show = params.source === 'real' && !!heightField && params.counties
      if (show && !seg) bake(heightField.projection)
      if (seg && heightField) applyVertical(heightField, params)
      material.color.set(params.countiesColor)
      material.linewidth = params.countiesWidth
      material.opacity = params.countiesOpacity
      mesh.visible = show
    },
    // per-frame (from the tick, alongside the other fogScale consumers)
    setFogScale(fogScale) {
      lift = LIFT_BASE * fogScale
      mesh.position.y = lift
    },
  }
}
