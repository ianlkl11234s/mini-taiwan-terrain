import * as THREE from 'three'
import { metersToWorldY, zFightLift } from './geo.js'
import { createMarkers } from './markers.js'

// Reservoir water-surface layer (kind 'area'). One translucent horizontal plane
// per reservoir, triangulated from the baked shoreline polygon (THREE.Shape ->
// ShapeGeometry, outer ring only — holes ignored) and placed at the water-level
// elevation. depthTest ON + depthWrite OFF means terrain that rises above the
// water plane naturally occludes it, so the sheet reads as water sitting inside
// the valley basin; the terrain skin never z-fights it because it draws after
// the opaque pass with a small anti-z-fight lift.
//
// WATER LEVEL (an approximation — no bathymetry is available):
//   fullElev  = shoreline (ring) median elevation  ≈ real full-pool level
//   floorElev = the flat "captured water" surface the DTM actually recorded
//               (interior 10th-percentile), i.e. the deepest level we can still
//               SHOW — below it the terrain skin would hide the plane.
//   physical  = fullElev − (1 − ratio) × dam_height      (task formula)
//               dam_height matched from water_dams by name; unmatched → a
//               conservative fullElev×0.15 drop basis (empty ≈ 85% of full).
//   rendered  = clamp(physical, floorElev, fullElev)     ← keeps it visible
//
// ratio is the live storage ratio (Supabase) per reservoir by default; the
// panel's global ratio slider, once touched, overrides ALL basins uniformly so
// the user can simulate draining/filling — only each mesh's position.y moves,
// geometry is never rebuilt.
//
// Dam markers (water_dams, is_reservoir=true) ride inside the same group via an
// embedded marker set, so they appear/vanish with the layer toggle and their
// name tags carry the live storage %.

const LIFT_BASE = 0.06 // a hair above the terrain skin (see geo.zFightLift)
const DAM_COLOR = '#1560a8'

export function createReservoirLayer(params) {
  const group = new THREE.Group()
  group.visible = false

  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(params.reservoirsColor),
    transparent: true,
    opacity: params.reservoirsOpacity,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  })

  const markers = createMarkers(params)
  group.add(markers.group)

  let specs = [] // baked reservoir specs (+ liveRatio attached)
  let meshes = [] // { mesh, fullElev, floorElev, drop, liveRatio }
  let built = false
  let hf = null
  let lift = LIFT_BASE
  let manualActive = false
  let manualRatio = 1

  function gate() {
    return params.source === 'real' && !!hf && params.reservoirsVisible
  }

  function buildMeshes(projection) {
    for (const m of meshes) {
      group.remove(m.mesh)
      m.mesh.geometry.dispose()
    }
    meshes = []
    for (const r of specs) {
      const ring = r.ring
      if (!ring || ring.length < 4) continue
      const shape = new THREE.Shape()
      for (let i = 0; i < ring.length; i++) {
        const w = projection.lonLatToWorld(ring[i][0], ring[i][1])
        if (i === 0) shape.moveTo(w.x, w.z)
        else shape.lineTo(w.x, w.z)
      }
      const geo = new THREE.ShapeGeometry(shape)
      geo.rotateX(Math.PI / 2) // (x, z, 0) plane -> horizontal (x, 0, z)
      const mesh = new THREE.Mesh(geo, material)
      mesh.renderOrder = 3
      mesh.frustumCulled = true
      group.add(mesh)
      const drop = r.damHeight != null ? r.damHeight : r.fullElev * 0.15
      meshes.push({ mesh, fullElev: r.fullElev, floorElev: r.floorElev, drop, liveRatio: r.liveRatio ?? 1 })
    }
    built = true
  }

  // position.y only — never rebuilds geometry (called on load, exaggeration
  // change, lift change from fogScale, and every ratio-slider drag)
  function applyWaterLevels() {
    if (!hf) return
    for (const m of meshes) {
      const ratio = manualActive ? manualRatio : m.liveRatio
      const physical = m.fullElev - (1 - ratio) * m.drop
      const rendered = Math.min(m.fullElev, Math.max(m.floorElev, physical))
      m.mesh.position.y = metersToWorldY(hf, rendered, params.demExaggeration) + lift
    }
  }

  function applyStyle() {
    material.color.set(params.reservoirsColor)
    material.opacity = params.reservoirsOpacity
  }

  return {
    id: 'reservoirs',
    kind: 'area',
    label: 'Reservoirs',
    rowLabel: '水庫 Reservoirs',
    object3d: group,
    visibleParam: 'reservoirsVisible',
    paramMap: {
      visible: 'reservoirsVisible',
      ratio: 'reservoirsRatio',
      opacity: 'reservoirsOpacity',
      color: 'reservoirsColor',
    },

    build() {},

    // deferred data arrival: baked reservoir specs + dam markers + the live
    // storage ratios (name -> 0..1). Builds nothing yet — meshes/markers are
    // materialized in update() once the DEM world exists (avoids the empty-
    // geometry-then-fill trap). Dam tags fold the live % into their name.
    setData(reservoirs, dams, liveByName = {}) {
      specs = reservoirs.map((r) => ({ ...r, liveRatio: liveByName[r.name] ?? 1 }))
      built = false
      const damPoints = (dams ?? []).map((d) => {
        const pct = liveByName[d.name]
        return {
          name: pct != null ? `${d.name} ${Math.round(pct * 100)}%` : d.name,
          lon: d.lon,
          lat: d.lat,
          elev: d.elev,
        }
      })
      markers.setSet('dams', { color: DAM_COLOR, visible: true, points: damPoints })
    },

    update(ctx) {
      hf = ctx.heightField
      const show = gate()
      if (show && hf) {
        if (!built && specs.length) buildMeshes(hf.projection)
        applyStyle()
        applyWaterLevels()
      }
      group.visible = show
      // embedded dam markers track the same visibility + real-mode world
      markers.update(params, hf)
      markers.group.visible = show
    },

    tickView(ctx) {
      const next = zFightLift(LIFT_BASE, ctx.fogScale)
      if (next !== lift) {
        lift = next
        if (built) applyWaterLevels()
      }
      markers.setFogScale(ctx.fogScale)
      markers.tick(ctx.dt, ctx.camera)
    },

    // global ratio-slider override (0..1). Once touched, every basin follows the
    // slider instead of its live ratio, so the whole system drains/fills together.
    setManualRatio(v01) {
      manualActive = true
      manualRatio = Math.min(1, Math.max(0, v01))
      applyWaterLevels()
    },

    describe() {
      return {
        id: 'reservoirs',
        kind: 'area',
        label: 'Reservoirs',
        rowLabel: '水庫 Reservoirs',
        count: meshes.length || specs.length,
        visible: params.reservoirsVisible,
        styleSchema: {
          ratio: { type: 'slider', label: '蓄水率 Ratio %', min: 0, max: 100, step: 1, format: (v) => `${Math.round(v)}%` },
          opacity: { type: 'slider', label: '不透明度 Opacity', min: 0, max: 1, step: 0.02, format: (v) => v.toFixed(2) },
          color: { type: 'color', label: '水色 Color' },
        },
        style: {
          ratio: params.reservoirsRatio,
          opacity: params.reservoirsOpacity,
          color: params.reservoirsColor,
        },
      }
    },

    dispose() {
      for (const m of meshes) m.mesh.geometry.dispose()
      material.dispose()
    },
  }
}
