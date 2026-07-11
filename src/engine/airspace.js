import * as THREE from 'three'
import { metersToWorldY } from './geo.js'

// Airspace "立體圍籬" (3D fence) overlay — kind 'area'. A small baked-JSON
// polygon set (public/layers/airspace.json, ~31 zones after bake_airspace.py's
// P/R/D filter — see that script for why FIR/TMA/CTR/ULZ etc are excluded),
// built ONCE as a single merged mesh, NOT a tile-streamed manager like
// vectortiles.js's buildings/fields (81→31 polygons is far too small to
// justify that machinery — see the SOP handoff note on this layer).
//
// Per-zone geometry mirrors vectortiles.js's building extrusion technique
// (classifyRings→earcut roof cap + one quad per ring edge for walls — see
// decodeBuildingLayer's comment block) with two differences:
//   1. Every kept zone's ring is a single closed exterior ring with no holes
//      (verified against the current dataset), so plain
//      THREE.ShapeUtils.triangulateShape(contour, []) is enough — no
//      classifyRings needed.
//   2. floor_m/ceiling_m are ABSOLUTE elevations (meters AMSL) already, not
//      terrain-relative — so unlike buildings' baseY (sampled from
//      heightField.heightAtWorld), a zone's floor/ceiling Y comes straight
//      from metersToWorldY(heightField, floorM/ceilingM, exaggeration). This
//      also means the fence needs NO live terrain sampling at all: once
//      heightField exists (datumM frozen, projection ready) the mesh can be
//      built immediately, with no dependency on which terrain chunks happen
//      to be streamed in yet (contrast buildings/roads/fields, which must
//      re-drape via chunkManager.onChunksChanged's markDemDirty hook).
//      Only a demExaggeration change requires recomputing Y (cheap — X/Z
//      never move), done in update() every call, same spirit as
//      water.js's applyWaterLevels.
//
// Both a top AND bottom cap are built (buildings only builds a roof — a
// building's underside is never visible from above ground, but a floating
// fence is seen from below and from odd banked angles during a fly-through).
//
// Rendering: translucent walls (禁航/P red, 限航/R orange, 危險/D purple —
// baked per-vertex like buildings' height ramp; CLASS_COLORS also includes
// 'P' even though the current bake never emits it, so a future data
// revision adding a real Prohibited class needs no code change here).
// transparent + depthWrite:false (typhoon/region-plane convention — an
// overlapping stack of translucent volumes must not fight itself in the
// depth buffer) + DoubleSide (both caps and all four wall orientations need
// to read correctly regardless of view angle/winding, same reasoning as
// buildings' side choice). renderOrder 7 — after the sea plane (1), region
// lines (2), water sheets (3), markers (4), trains (5), typhoon (6), so the
// fence composites correctly over every other translucent layer.

const CLASS_COLORS = {
  P: { r: 0xd3 / 255, g: 0x2f / 255, b: 0x2f / 255 }, // 禁航 Prohibited — red (not currently emitted, see bake_airspace.py)
  R: { r: 0xff / 255, g: 0x98 / 255, b: 0x00 / 255 }, // 限航 Restricted — orange
  D: { r: 0x8e / 255, g: 0x24 / 255, b: 0xaa / 255 }, // 危險 Danger — purple
}
const FALLBACK_COLOR = { r: 0.6, g: 0.6, b: 0.6 }
const CLASS_LABELS = { P: '禁航 Prohibited', R: '限航 Restricted', D: '危險 Danger' }

const VK_FLOOR = 0
const VK_CEIL = 1

const AIRSPACE_LIFT = 7 // renderOrder, not a world-unit lift — see module header

// build the static per-vertex geometry data (positions in world XZ, colors,
// index, and the per-vertex zone/kind tags writeY needs) — done ONCE when
// zones arrive AND the projection exists; never rebuilt afterward (only Y
// gets rewritten, by writeY, on exaggeration changes).
function buildGeometryData(zones, projection) {
  const pos = []
  const col = []
  const idx = []
  const faceZone = [] // one entry per triangle -> zone index (pick())
  const vertZone = [] // one entry per vertex -> zone index (writeY)
  const vertKind = [] // one entry per vertex -> VK_FLOOR | VK_CEIL

  zones.forEach((z, zi) => {
    const ring = z.ring
    if (!ring || ring.length < 3) return
    const contour = ring.map(([lon, lat]) => {
      const w = projection.lonLatToWorld(lon, lat)
      return new THREE.Vector2(w.x, w.z)
    })
    if (contour.length > 3 && contour[0].equals(contour[contour.length - 1])) contour.pop() // drop closing dup
    if (contour.length < 3) return
    let faces
    try {
      faces = THREE.ShapeUtils.triangulateShape(contour, [])
    } catch (err) {
      return // malformed ring — skip this zone, never crash the whole build
    }
    if (!faces.length) return

    const c = CLASS_COLORS[z.cls] ?? FALLBACK_COLOR
    const n = contour.length

    // ceiling cap
    const topBase = pos.length / 3
    for (const v of contour) {
      pos.push(v.x, 0, v.y)
      col.push(c.r, c.g, c.b)
      vertZone.push(zi)
      vertKind.push(VK_CEIL)
    }
    for (const f of faces) {
      idx.push(topBase + f[0], topBase + f[1], topBase + f[2])
      faceZone.push(zi)
    }

    // floor cap (DoubleSide handles the reversed view from below — same
    // "no manual winding flip needed" reasoning as buildings' roof cap)
    const botBase = pos.length / 3
    for (const v of contour) {
      pos.push(v.x, 0, v.y)
      col.push(c.r, c.g, c.b)
      vertZone.push(zi)
      vertKind.push(VK_FLOOR)
    }
    for (const f of faces) {
      idx.push(botBase + f[0], botBase + f[1], botBase + f[2])
      faceZone.push(zi)
    }

    // walls: one quad (2 triangles) per ring edge
    for (let e = 0; e < n; e++) {
      const p0 = contour[e]
      const p1 = contour[(e + 1) % n]
      const base = pos.length / 3
      pos.push(p0.x, 0, p0.y); col.push(c.r, c.g, c.b); vertZone.push(zi); vertKind.push(VK_FLOOR)
      pos.push(p1.x, 0, p1.y); col.push(c.r, c.g, c.b); vertZone.push(zi); vertKind.push(VK_FLOOR)
      pos.push(p1.x, 0, p1.y); col.push(c.r, c.g, c.b); vertZone.push(zi); vertKind.push(VK_CEIL)
      pos.push(p0.x, 0, p0.y); col.push(c.r, c.g, c.b); vertZone.push(zi); vertKind.push(VK_CEIL)
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
      faceZone.push(zi, zi)
    }
  })

  return {
    pos: new Float32Array(pos),
    col: new Float32Array(col),
    idx,
    faceZone: new Int32Array(faceZone),
    vertZone: new Int32Array(vertZone),
    vertKind: new Uint8Array(vertKind),
    nVerts: pos.length / 3,
  }
}

// rewrite every vertex's Y from its zone's floorM/ceilingM — the only thing a
// demExaggeration change touches (X/Z are fixed forever once projected).
function writeY(bd, zones, heightField, exaggeration) {
  for (let i = 0; i < bd.nVerts; i++) {
    const z = zones[bd.vertZone[i]]
    const m = bd.vertKind[i] === VK_CEIL ? z.ceilingM : z.floorM
    bd.pos[i * 3 + 1] = metersToWorldY(heightField, m, exaggeration)
  }
}

const AIRSPACE_STYLE = {
  opacity: { type: 'slider', label: '不透明度 Opacity', min: 0.05, max: 1, step: 0.02, format: (v) => v.toFixed(2) },
}

const fmtM = (m) => (typeof m === 'number' ? `${Math.round(m)} m` : '—')

export function createAirspaceLayer(params) {
  const group = new THREE.Group()
  group.visible = false

  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: params.airspaceOpacity ?? 0.25,
    depthTest: true,
    depthWrite: false, // stacked translucent volumes — never fight each other or the terrain in the depth buffer
    side: THREE.DoubleSide,
    fog: true,
  })

  let mesh = null
  let bd = null
  let zones = [] // baked zone specs (code/nameZh/nameEn/cls/floorM/ceilingM/ring)
  let built = false
  let hf = null

  function gate() {
    return params.source === 'real' && !!hf && !!params.airspaceVisible
  }

  // "先空後填": nothing is built until BOTH the zone data (setData) and a
  // live heightField/projection exist. No chunk/DEM-coverage dependency at
  // all (see module header) — builds the instant heightField appears.
  function buildMesh() {
    if (built || !hf || !zones.length) return
    bd = buildGeometryData(zones, hf.projection)
    if (!bd.nVerts) return
    writeY(bd, zones, hf, params.demExaggeration)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(bd.pos, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(bd.col, 3))
    geo.setIndex(bd.idx)
    mesh = new THREE.Mesh(geo, material)
    mesh.renderOrder = AIRSPACE_LIFT
    mesh.userData.faceZone = bd.faceZone
    group.add(mesh)
    built = true
  }

  function redrape() {
    if (!built || !hf) return
    writeY(bd, zones, hf, params.demExaggeration)
    mesh.geometry.attributes.position.needsUpdate = true
    mesh.geometry.computeBoundingSphere()
  }

  return {
    id: 'airspace',
    kind: 'area',
    label: 'Airspace',
    rowLabel: '空域 Airspace',
    object3d: group,
    visibleParam: 'airspaceVisible',
    paramMap: { visible: 'airspaceVisible', opacity: 'airspaceOpacity' },

    build() {},

    // deferred data arrival (onActivate → index.js loadAirspaceData → here).
    // Builds nothing yet — materialized in update() once heightField exists
    // (mirrors water.js's reservoirs setData/build split).
    setData(loadedZones) {
      zones = loadedZones
      built = false
    },

    update(ctx) {
      hf = ctx.heightField
      const show = gate()
      if (show && hf) {
        if (!built) buildMesh()
        else redrape() // cheap (Y-only, ~31 zones) — same unconditional-recompute style as water.js applyWaterLevels
        material.opacity = params.airspaceOpacity ?? 0.25
      }
      group.visible = show && built
    },

    tickView() {},

    setStyle(patch) {
      if (patch.opacity !== undefined) {
        params.airspaceOpacity = patch.opacity
        material.opacity = patch.opacity
      }
    },

    // click-to-inspect: real triangle-mesh raycast (the fence is a proper 3D
    // volume at any zoom, unlike markers.js's sub-pixel dots — no need for
    // the screen-space-proximity workaround those use).
    pick(raycaster) {
      if (!group.visible || !mesh) return null
      const hits = raycaster.intersectObject(mesh, false)
      if (!hits.length) return null
      const zi = mesh.userData.faceZone[hits[0].faceIndex]
      const z = zones[zi]
      if (!z) return null
      return {
        title: z.nameZh || z.nameEn || z.code || '空域 Airspace',
        rows: [
          ['代碼 Code', z.code || '—'],
          ['類別 Class', CLASS_LABELS[z.cls] ?? z.cls],
          ['高度範圍 Floor–Ceiling', `${fmtM(z.floorM)} – ${fmtM(z.ceilingM)}`],
        ],
        worldPos: hits[0].point.clone(),
      }
    },

    describe() {
      return {
        id: 'airspace',
        kind: 'area',
        label: 'Airspace',
        rowLabel: '空域 Airspace',
        count: zones.length,
        visible: params.airspaceVisible,
        styleSchema: AIRSPACE_STYLE,
        style: { opacity: params.airspaceOpacity ?? 0.25 },
      }
    },

    dispose() {
      if (mesh) mesh.geometry.dispose()
      material.dispose()
    },
  }
}
