import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { metersToWorldY, drapeAt } from './geo.js'
import { buildGrid, gatherNear } from './energy.js'

// 醫療設施 POI (F 棒): the FULL national roll of NHI-contracted medical
// institutions (bake_medical_poi.py -> nhi_institutions_geocoded.geojson,
// 29,896 points after the 3-category filter) — complements, does NOT
// replace, the existing "急救醫院 Hospitals" layer (markers.js/
// bake_poi_layers.py, 232 emergency-responsible hospitals only). Two very
// different questions: that layer answers "where do ambulances take
// trauma cases", this one answers "where is the nearest clinic/pharmacy".
//
// ---- why this is NOT a markers.js createPointLayer -------------------
// 21,765 診所 alone is far too many to keep resident as flat always-on
// dots (markers.js's convention for stations/ports/fire/hospitals, all
// low-hundreds to a couple-thousand). This follows energy.js's playbook
// instead, mixing its TWO patterns depending on each category's population:
//   醫院 (451 nationwide)   -> build ALL instances once, exactly like
//                              energy.js's wind turbines (812) — small
//                              enough that no spatial subsetting is needed.
//   診所 (21,765) / 藥局 (7,680) -> a uniform spatial grid (buildGrid/
//                              gatherNear, IMPORTED from energy.js rather
//                              than re-derived) restricts each frame's
//                              InstancedMesh to only the points within
//                              GATHER_RADIUS of the camera's pan center,
//                              capped at CAP[cat] — exactly power towers'
//                              (26,589 points) approach. Measured real-world
//                              density check (central Taipei, the densest
//                              cluster in the dataset) before picking caps:
//                              within a 4.3km radius (== GATHER_RADIUS)
//                              around Taipei Main Station there are ~2,018
//                              診所 / ~487 藥局 — CAP below leaves ~2x
//                              headroom over that, same "generous headroom
//                              over measured density" reasoning as
//                              TOWER_MAX_INSTANCES's own comment.
// All three categories share ONE camDist/lodZoom near/far hysteresis gate
// (nearMode below) — "近景才實體化" applies to the whole layer, not per
// category — but each has its OWN independent on/off toggle (the `sets`
// facade: describe().sets / setSet(), the same panel contract ports.js's
// port_class_group / bake_poi_layers.py's hospital-level sets already use),
// so a user can e.g. hide 診所 to declutter while keeping 醫院/藥局 visible.
//
// ---- geometry: "cross quad" billboard-ish icon -------------------------
// A real per-frame billboard (always rotate to face the camera) would force
// a matrix recompute for every resident instance on every orbit frame, not
// just on pan-center moves — fighting the on-demand-render/steady-state-
// cost discipline the rest of this engine holds to. Instead: TWO static
// perpendicular vertical planes (forming an "X" in plan view) — the classic
// cheap "cross-billboard" trick (grass/foliage impostors) that reads as a
// small flat icon from any horizontal viewing angle without ever needing to
// know where the camera is. 2 planes × 2 tris = 4 tris/instance — for
// 4,000+2,500+451 = 6,951 max resident instances that's under 28k triangles,
// trivial next to the terrain mesh itself.
//
// ---- vertical placement -------------------------------------------------
// Same convention as energy.js: baked `elev` -> metersToWorldY (exact,
// instant), no `elev` -> drapeAt (live-sample, for the it-never-happens
// case where a point predates the bake's DEM pass). Icon footprint/height
// are a fixed "readable icon" size — NOT tied to any real building
// dimension like towers/turbines are — so unlike those, exaggeration only
// moves the icon's base Y (via metersToWorldY), never its own scale.

const CAT_HOSPITAL = 0
const CAT_CLINIC = 1
const CAT_PHARMACY = 2
const CAT_NAMES = ['醫院', '診所', '藥局'] // index === bake_medical_poi.py's int enum; ALSO used as this layer's set ids (ports/hospitals convention: Chinese string set ids are shown directly as the panel row label)
const CAT_COLORS = ['#e63946', '#f4a300', '#00b8d9'] // 醫院紅 / 診所橘 / 藥局青 — deliberately distinct from hospitals.json's HOSPITAL_COLORS (all green shades), so the two "醫院"-flavored layers never read as the same thing when both are on

const ICON_SIZE_M = 14 // meters — arbitrary "readable icon" scale (not a real footprint)
const CAP = { [CAT_CLINIC]: 4000, [CAT_PHARMACY]: 2500 } // resident cap, grid+gather categories only (醫院 builds all — see header)

const NEAR_ENTER_DIST = 6 // world units (~2.9 km) — mirrors energy.js power towers
const NEAR_EXIT_DIST = 9 // world units (~4.3 km) — hysteresis
const LOD_ZOOM_MIN = 12
const GATHER_RADIUS = 9 // world units around the pan center (~4.3 km, same as NEAR_EXIT_DIST)
const REBUILD_DELTA = 1.5 // world units the pan center must move before re-gathering
const GRID_CELL = 2 // world units

const PICK_PX = 16

const MEDICAL_STYLE = {
  size: { type: 'slider', label: '大小 Size', min: 0.5, max: 3.0, step: 0.05, format: (v) => v.toFixed(2) },
  opacity: { type: 'slider', label: '不透明度 Opacity', min: 0.1, max: 1, step: 0.02, format: (v) => v.toFixed(2) },
}

function applyOpacity(material, opacity) {
  material.opacity = opacity
  material.transparent = opacity < 1
}

// two perpendicular unit vertical planes, base at y=0 / top at y=1 (X/Z
// span -0.5..0.5) — see header's "cross quad" note. DoubleSide because only
// 2 (not 4) planes stand in for a full billboard.
function buildCrossQuadGeometry() {
  const a = new THREE.PlaneGeometry(1, 1)
  a.translate(0, 0.5, 0)
  const b = a.clone()
  b.rotateY(Math.PI / 2)
  const merged = mergeGeometries([a, b], false)
  a.dispose()
  b.dispose()
  return merged
}

export function createMedicalLayer(params, { onActivate } = {}) {
  const group = new THREE.Group()
  group.visible = false

  const geo = buildCrossQuadGeometry()

  // per-category state. hospital: build-all (like energy.js wind turbines —
  // mesh created lazily once point count is known). clinic/pharmacy:
  // grid+gather+cap (like energy.js power towers — mesh created eagerly at a
  // FIXED capacity so there's never a deferred-empty-geometry moment where
  // three.js could freeze _maxInstanceCount at 0 — see module docs 陷阱).
  function makeCatState(cat) {
    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(CAT_COLORS[cat]),
      opacity: params.medicalOpacity ?? 0.92,
      transparent: (params.medicalOpacity ?? 0.92) < 1,
      side: THREE.DoubleSide,
      depthWrite: true,
      fog: true,
    })
    const st = {
      cat,
      points: [],
      grid: null,
      positionsReady: false,
      built: false, // hospital only: mesh created?
      visible: true, // this category's own on/off (panel per-set toggle)
      mesh: null,
      material,
      visibleList: [], // parallel to instance slots: {idx, x, y, z}
    }
    if (cat !== CAT_HOSPITAL) {
      st.mesh = new THREE.InstancedMesh(geo, material, CAP[cat])
      st.mesh.count = 0
      st.mesh.visible = false
      group.add(st.mesh)
    }
    return st
  }

  const cats = [makeCatState(CAT_HOSPITAL), makeCatState(CAT_CLINIC), makeCatState(CAT_PHARMACY)]

  let hf = null
  let dataReady = false
  let activated = false // one-shot onActivate guard (createPointLayer's exact contract — see setVisible below)
  let nearMode = false
  let lastCenter = null
  let lastExaggeration = null
  let lastSizeMult = null
  const _m = new THREE.Matrix4()

  function active() {
    return params.source === 'real' && !!hf && dataReady
  }

  // lon/lat -> world x/z (once per point, first time a live projection
  // exists), then a spatial grid for the two gather categories.
  function ensurePositions() {
    const proj = hf.projection
    for (const st of cats) {
      if (st.positionsReady) continue
      for (const p of st.points) {
        const w = proj.lonLatToWorld(p.lon, p.lat)
        p._x = w.x
        p._z = w.z
      }
      if (st.cat !== CAT_HOSPITAL) st.grid = buildGrid(st.points, GRID_CELL)
      st.positionsReady = true
    }
  }

  function pointY(p, exaggeration) {
    return p.elev != null ? metersToWorldY(hf, p.elev, exaggeration) : drapeAt(hf, p._x, p._z, exaggeration)
  }

  // grid+gather category (診所/藥局): subset near `center`, capped
  function layoutGathered(st, center, sizeMult, exaggeration) {
    const K = hf.projection.K
    const scale = K * sizeMult * ICON_SIZE_M
    const idxList = gatherNear(st.grid, GRID_CELL, center.x, center.z, GATHER_RADIUS, st.points, CAP[st.cat])
    st.visibleList = new Array(idxList.length)
    for (let i = 0; i < idxList.length; i++) {
      const p = st.points[idxList[i]]
      const y = pointY(p, exaggeration)
      _m.makeScale(scale, scale, scale)
      _m.setPosition(p._x, y, p._z)
      st.mesh.setMatrixAt(i, _m)
      st.visibleList[i] = { idx: idxList[i], x: p._x, y, z: p._z }
    }
    st.mesh.count = idxList.length
    if (idxList.length > 0) {
      st.mesh.instanceMatrix.needsUpdate = true
      st.mesh.computeBoundingSphere()
    }
  }

  // build-all category (醫院): mesh created lazily once the point count is
  // known (mirrors energy.js wind turbines' buildMesh/layoutAll split)
  function layoutHospitalAll(st, sizeMult, exaggeration) {
    if (!st.points.length) return
    if (!st.mesh) {
      st.mesh = new THREE.InstancedMesh(geo, st.material, st.points.length)
      st.mesh.count = 0
      st.mesh.visible = false
      group.add(st.mesh)
    }
    const K = hf.projection.K
    const scale = K * sizeMult * ICON_SIZE_M
    st.visibleList = new Array(st.points.length)
    for (let i = 0; i < st.points.length; i++) {
      const p = st.points[i]
      const y = pointY(p, exaggeration)
      _m.makeScale(scale, scale, scale)
      _m.setPosition(p._x, y, p._z)
      st.mesh.setMatrixAt(i, _m)
      st.visibleList[i] = { idx: i, x: p._x, y, z: p._z }
    }
    st.mesh.count = st.points.length
    st.mesh.instanceMatrix.needsUpdate = true
    st.mesh.computeBoundingSphere()
    st.built = true
  }

  function layoutAll(center) {
    const sizeMult = params.medicalSize ?? 1
    const exaggeration = params.demExaggeration
    layoutHospitalAll(cats[CAT_HOSPITAL], sizeMult, exaggeration)
    layoutGathered(cats[CAT_CLINIC], center, sizeMult, exaggeration)
    layoutGathered(cats[CAT_PHARMACY], center, sizeMult, exaggeration)
    lastCenter = { x: center.x, z: center.z }
    lastExaggeration = exaggeration
    lastSizeMult = sizeMult
  }

  // apply the "should this category actually be drawn right now" gate to
  // each mesh WITHOUT touching count/visibleList — toggling a set off/on (or
  // the shared nearMode flipping) is then just a mesh.visible flip, no
  // relayout needed, exactly energy.js's "re-showing without an intervening
  // camera move redraws instantly" convention (see power towers/turbines).
  function applyVisibility() {
    const show = active() && nearMode
    for (const st of cats) {
      if (st.mesh) st.mesh.visible = show && st.visible
    }
  }

  return {
    id: 'medical',
    kind: 'point',
    label: 'Medical',
    rowLabel: '醫療設施 Medical',
    object3d: group,

    build() {},

    // deferred data arrival (onActivate -> index.js loadMedicalData). Flat
    // {name,cat,county,lon,lat,elev} array (bake_medical_poi.py's schema) —
    // partitioned into the 3 category buckets once here so update()/tickView
    // never need to branch on `cat` per point.
    setData(flatPoints) {
      for (const st of cats) {
        st.points = []
        st.positionsReady = false
        st.built = false
      }
      for (const p of flatPoints ?? []) {
        const st = cats[p.cat]
        if (st) st.points.push(p)
      }
      dataReady = flatPoints != null && flatPoints.length > 0
    },

    // panel per-set toggle (醫院/診所/藥局 independently) — index.js's
    // setLayerSet(layerId, setId, def) forwards here; def is always
    // {visible} from the panel (see Layers.jsx's MarkerSetLayer)
    setSet(setId, def = {}) {
      const cat = CAT_NAMES.indexOf(setId)
      if (cat < 0) return
      if (def.visible !== undefined) cats[cat].visible = def.visible
    },

    // one-shot activation trigger: the panel shows a single plain toggle row
    // until `sets` first appears in describe() (see describe() below) —
    // flipping that toggle calls this, exactly createPointLayer's contract
    // (stations/ports/hospitals), so index.js wires onActivate the same way.
    setVisible(v) {
      if (!v || activated || !onActivate) return
      activated = true
      Promise.resolve(onActivate()).catch((err) => {
        console.warn('[layers] medical activation failed', err)
        activated = false
      })
    },

    update(ctx) {
      hf = ctx.heightField
      if (active()) {
        ensurePositions()
        for (const st of cats) applyOpacity(st.material, params.medicalOpacity ?? 0.92)
      }
      applyVisibility()
      group.visible = active()
    },

    // per-frame (only while non-idle): shared hysteresis + throttled gather,
    // same shape as energy.js power towers' tickView
    tickView(ctx) {
      if (!active()) return
      const zoomOk = (ctx.lodZoom ?? LOD_ZOOM_MIN) >= LOD_ZOOM_MIN
      if (nearMode && (ctx.camDist > NEAR_EXIT_DIST || !zoomOk)) nearMode = false
      else if (!nearMode && ctx.camDist < NEAR_ENTER_DIST && zoomOk) nearMode = true

      if (!nearMode) {
        applyVisibility()
        return
      }
      const center = ctx.labelCenter ?? { x: ctx.camera.position.x, z: ctx.camera.position.z }
      const sizeMult = params.medicalSize ?? 1
      const moved = !lastCenter || Math.hypot(center.x - lastCenter.x, center.z - lastCenter.z) > REBUILD_DELTA
      const styleChanged = lastExaggeration !== params.demExaggeration || lastSizeMult !== sizeMult
      if (moved || styleChanged) layoutAll(center)
      applyVisibility()
    },

    setStyle(patch) {
      if (patch.size !== undefined) params.medicalSize = patch.size
      if (patch.opacity !== undefined) {
        params.medicalOpacity = patch.opacity
        for (const st of cats) applyOpacity(st.material, patch.opacity)
      }
    },

    // click-to-inspect: proximity-pick over whichever categories are
    // currently actually drawn (mesh.visible — see applyVisibility)
    pick(raycaster) {
      if (!group.visible) return null
      const camera = raycaster.camera
      const clickPx = raycaster.pickPx
      if (!camera || !clickPx) return null
      const w = window.innerWidth
      const h = window.innerHeight
      const _world = new THREE.Vector3()
      const _proj = new THREE.Vector3()
      let best = null
      for (const st of cats) {
        if (!st.mesh || !st.mesh.visible) continue
        for (const v of st.visibleList) {
          _world.set(v.x, v.y, v.z)
          _proj.copy(_world).project(camera)
          if (_proj.z < -1 || _proj.z > 1) continue
          const sx = (_proj.x * 0.5 + 0.5) * w
          const sy = (-_proj.y * 0.5 + 0.5) * h
          const d = Math.hypot(sx - clickPx.x, sy - clickPx.y)
          if (d < PICK_PX && (!best || d < best.d)) best = { d, v, st }
        }
      }
      if (!best) return null
      const { v, st } = best
      const p = st.points[v.idx]
      return {
        title: p.name || CAT_NAMES[st.cat],
        rows: [
          ['類別 Category', CAT_NAMES[st.cat]],
          ['縣市 County', p.county || '—'],
        ],
        worldPos: new THREE.Vector3(v.x, v.y, v.z),
      }
    },

    describe() {
      const setsList = dataReady
        ? cats.map((st) => ({ id: CAT_NAMES[st.cat], count: st.points.length, color: CAT_COLORS[st.cat], visible: st.visible }))
        : []
      return {
        id: 'medical',
        kind: 'point',
        label: 'Medical',
        rowLabel: '醫療設施 Medical',
        count: setsList.reduce((n, s) => n + s.count, 0),
        visible: setsList.some((s) => s.visible),
        styleSchema: MEDICAL_STYLE,
        style: { size: params.medicalSize ?? 1, opacity: params.medicalOpacity ?? 0.92 },
        sets: setsList.length > 0 || activated ? setsList : undefined,
      }
    },

    dispose() {
      geo.dispose()
      for (const st of cats) st.material.dispose()
    },
  }
}
