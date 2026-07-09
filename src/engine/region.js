import * as THREE from 'three'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { metersToWorldY } from './geo.js'

// Regional context layer: the neighbouring coastlines (Taiwan's outlying islands,
// N Philippines, the Ryukyus, S Japan, S Korea, SE China) as flat sea-level
// strokes, over a single sea-coloured plane. Gives the storm a geographic frame
// beyond the DEM footprint (which only covers the Taiwan bbox).
//
//   - sea plane: one big flat sheet a hair ABOVE sea level, so it hides the white
//     DEM "sea" (elevation-0 tiles) under a real ocean colour AND fills the open
//     ocean past the DEM. Land (terrain above sea level) pokes through and
//     occludes it by depthTest; it sits just BELOW the coast strokes' lift so the
//     lines always draw on top.
//   - coastlines: disjoint LineSegments2 (one draw call), baked from
//     public/layers/region_coast.json ([lon,lat] pairs), placed at sea level.
//
// Deferred like rail/rivers: registers empty, fed via setData() on first
// switch-on. Data is standard Web Mercator (projection.lonLatToWorld), so the
// far neighbours land in the correct position relative to Taiwan (with the usual
// Mercator inflation up north — fine for a context map).

const SEA_SIZE = 12000 // world units — covers the whole region from the origin
// Sea plane height: a few metres above sea, only to clear the 0 m DEM ocean
// (NODATA→0) so the near sea reads blue instead of white. Land is NOT excluded
// by height — low plains would flood / z-fight — it is cut out by a land/sea
// MASK (region_sea_mask.png, from the exact Taiwan coastline ring) the plane
// samples as an alphaMap: mask sea=255 → drawn, land=0 → alphaTest discards it.
const SEA_PLANE_M = 3.0
const LINE_LIFT = 0.03 // coastlines float a hair above the sea plane

export function createRegionLayer(params) {
  const group = new THREE.Group()
  group.visible = false

  const seaMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(params.regionSeaColor),
    transparent: true,
    opacity: params.regionSeaOpacity,
    depthTest: true,
    depthWrite: false,
    fog: true,
    alphaTest: 0.5, // mask land (0) is discarded; the alphaMap is set by setMask
    // the DEM renders the ocean (elevation 0) as a flat white "sea" mesh a few
    // metres below this plane; at far/grazing views the two are near-coplanar and
    // z-fight into horizontal streaks. polygonOffset pulls the plane's depth
    // toward the camera so it wins cleanly (land is still cut out by the mask, so
    // this never paints over terrain).
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  })
  const seaGeo = new THREE.PlaneGeometry(SEA_SIZE, SEA_SIZE, 1, 1)
  seaGeo.rotateX(-Math.PI / 2) // lie flat, normal +Y
  const sea = new THREE.Mesh(seaGeo, seaMat)
  sea.renderOrder = 1
  sea.frustumCulled = false
  group.add(sea)

  const lineMat = new LineMaterial({
    color: new THREE.Color(params.regionLineColor),
    linewidth: params.regionLineWidth,
    transparent: true,
    opacity: params.regionLineOpacity,
    fog: true,
  })
  const lines = new LineSegments2(new LineSegmentsGeometry(), lineMat)
  lines.renderOrder = 2
  lines.visible = false
  group.add(lines)

  let coast = [] // [[ [lon,lat], ... ], ...]
  let seg = null // Float32Array segment pairs (xz baked, y stays 0)
  let built = false
  let hf = null
  let resolutionSet = false
  let maskBbox = null // {minLon,maxLon,minLat,maxLat} of the land/sea mask
  let maskReady = false
  let uvSet = false // sea-plane UVs mapped to the mask (needs the projection)

  function gate() {
    return params.source === 'real' && !!hf && params.regionVisible
  }

  // map the sea plane's vertex UVs so the mask covers its geographic bbox in
  // world space (nw = west/north, se = east/south); ClampToEdge means anything
  // beyond Taiwan samples the mask's sea border → open ocean stays sea
  function applyMaskUVs(projection) {
    if (!maskBbox) return
    const nw = projection.lonLatToWorld(maskBbox.minLon, maskBbox.maxLat)
    const se = projection.lonLatToWorld(maskBbox.maxLon, maskBbox.minLat)
    const dx = se.x - nw.x
    const dz = se.z - nw.z
    const pos = seaGeo.attributes.position
    const uv = seaGeo.attributes.uv
    for (let i = 0; i < pos.count; i++) {
      uv.setXY(i, (pos.getX(i) - nw.x) / dx, (pos.getZ(i) - nw.z) / dz)
    }
    uv.needsUpdate = true
    uvSet = true
  }

  function bake(projection) {
    let nSeg = 0
    for (const l of coast) nSeg += Math.max(0, l.length - 1)
    seg = new Float32Array(nSeg * 6)
    let s = 0
    for (const line of coast) {
      for (let i = 0; i < line.length - 1; i++) {
        const a = projection.lonLatToWorld(line[i][0], line[i][1])
        const b = projection.lonLatToWorld(line[i + 1][0], line[i + 1][1])
        seg[s * 6] = a.x
        seg[s * 6 + 2] = a.z
        seg[s * 6 + 3] = b.x
        seg[s * 6 + 5] = b.z
        s++
      }
    }
    // fresh geometry: three memoizes _maxInstanceCount at first render, so an
    // already-rendered empty geometry would keep drawing 0 instances (see polyline.js)
    lines.geometry.dispose()
    lines.geometry = new LineSegmentsGeometry()
    lines.geometry.setPositions(seg)
    built = true
  }

  function placeVertical() {
    if (!hf) return
    const y = metersToWorldY(hf, SEA_PLANE_M, params.demExaggeration)
    sea.position.y = y
    lines.position.y = y + LINE_LIFT
  }

  function applyStyle() {
    seaMat.color.set(params.regionSeaColor)
    seaMat.opacity = params.regionSeaOpacity
    lineMat.color.set(params.regionLineColor)
    lineMat.linewidth = params.regionLineWidth
    lineMat.opacity = params.regionLineOpacity
  }

  return {
    id: 'region',
    kind: 'area',
    label: 'Region',
    rowLabel: '周邊 Region',
    object3d: group,
    visibleParam: 'regionVisible',
    paramMap: {
      visible: 'regionVisible',
      seaColor: 'regionSeaColor',
      seaOpacity: 'regionSeaOpacity',
      lineColor: 'regionLineColor',
      lineWidth: 'regionLineWidth',
      lineOpacity: 'regionLineOpacity',
    },

    build(ctx) {
      if (!resolutionSet && ctx.lineResolution) {
        lineMat.uniforms.resolution.value = ctx.lineResolution
        resolutionSet = true
      }
    },

    // deferred data: the baked coastline polylines ([lon,lat] pairs)
    setData(newLines) {
      coast = newLines || []
      built = false
      seg = null
      lines.geometry.dispose()
      lines.geometry = new LineSegmentsGeometry()
    },

    update(ctx) {
      hf = ctx.heightField
      const show = gate()
      if (hf) {
        if (show && !built && coast.length) bake(hf.projection)
        if (maskReady && !uvSet) applyMaskUVs(hf.projection)
        placeVertical()
        applyStyle()
      }
      // the sea plane needs its land/sea mask before it can show (else it would
      // paint over the low plains) — gate it on maskReady, lines on their data
      sea.visible = show && maskReady
      lines.visible = show && built
      group.visible = show
    },

    // deferred land/sea mask: sea=255 / land=0, sampled as the sea plane's
    // alphaMap so land is cut out independent of elevation. flipY false → row 0
    // (north) reads at uv v=0, matching applyMaskUVs.
    setMask(tex, bbox) {
      maskBbox = bbox
      seaMat.alphaMap = tex
      seaMat.needsUpdate = true
      maskReady = true
      uvSet = false
    },

    describe() {
      return {
        id: 'region',
        kind: 'area',
        label: 'Region',
        rowLabel: '周邊 Region',
        count: coast.length,
        visible: params.regionVisible,
        styleSchema: {
          seaColor: { type: 'color', label: '海色 Sea' },
          seaOpacity: { type: 'slider', label: '海透明度 Sea opacity', min: 0, max: 1, step: 0.02, format: (v) => v.toFixed(2) },
          lineColor: { type: 'color', label: '海岸線色 Coast' },
          lineWidth: { type: 'slider', label: '線寬 Width', min: 0.3, max: 4, step: 0.1, format: (v) => v.toFixed(1) },
          lineOpacity: { type: 'slider', label: '線透明度 Line opacity', min: 0, max: 1, step: 0.02, format: (v) => v.toFixed(2) },
        },
        style: {
          seaColor: params.regionSeaColor,
          seaOpacity: params.regionSeaOpacity,
          lineColor: params.regionLineColor,
          lineWidth: params.regionLineWidth,
          lineOpacity: params.regionLineOpacity,
        },
      }
    },

    dispose() {
      seaGeo.dispose()
      seaMat.dispose()
      lines.geometry.dispose()
      lineMat.dispose()
    },
  }
}
