import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { metersToWorldY, drapeAt } from './geo.js'

// Power towers + wind turbines: two InstancedMesh point layers of simplified
// low-poly 3D silhouettes (kind 'point'), draped on the real terrain like
// markers.js's flat dots but with actual extruded geometry instead of a flat
// disc — the near-view equivalent of trains.js's car-chain LOD, minus the
// timeline animation.
//
// ---- geometry convention (both layers) ----------------------------------
// Every "unit" geometry is built in REAL METERS for its horizontal (X/Z)
// dimensions but with Y running 0..1 — i.e. "1 world-meter of real height,
// to be multiplied by this instance's real height in meters". Per-instance
// THREE.Matrix4 scale is then:
//   scale.x = scale.z = K * sizeMult                (footprint: true meters, size-slider only — never exaggeration)
//   scale.y = K * exaggeration * sizeMult * heightM  (height: true meters × vertical exaggeration, like buildings/trains)
// (K = heightField.projection.K, world units per ground meter — see geo.js).
// A fixed local Y position (e.g. the crossarm at 0.82) always lands at 82%
// of THAT instance's real height after scaling, so taller/shorter towers
// keep their crossarm proportionally near the top without extra bookkeeping.
//
// No vertex colors / lighting: like vectortiles.js's buildings these use
// flat MeshBasicMaterial (one solid color per layer) — a recognizable
// silhouette is the goal, not photorealism, and the app has no per-object
// dynamic lighting model for small props.
//
// ---- power towers (26,589 points) ----------------------------------------
// Far too many to keep resident (see module docs handoff) — a uniform
// spatial grid (built ONCE, right after positions are computed) lets tickView
// gather only the points within TOWER_GATHER_RADIUS of the camera's pan
// center in O(cells-in-radius), not O(26,589), every time that center moves
// more than TOWER_REBUILD_DELTA (small pans/orbits re-use the existing
// instance buffer for free — the steady-state idle-camera cost is zero,
// same on-demand-render discipline as the rest of the engine). The whole
// layer additionally hides beyond TOWER_NEAR_EXIT_DIST world units of camera-
// to-target distance (dual-mode hysteresis identical in spirit to trains.js's
// CAR_LOD_ENTER/EXIT_DIST) AND below lodZoom 12 — an island-wide view must
// never try to place thousands of towers.
//
// ---- wind turbines (812 points) -------------------------------------------
// Small enough to build ALL instances once (no spatial subset needed); still
// gated behind the same near/far camDist hysteresis so a zoomed-out view
// doesn't clutter with 812 tiny silhouettes ("防遠景雜訊" in the brief).
// Blades are static — no rotation animation this pass (see TODO below); this
// keeps the layer OUT of the render loop's isAnimating() set, matching the
// on-demand-render mandate (an animated blade would force continuous
// rendering exactly like typhoon/seaAnimated do, which nothing here asked for).
//
// ---- two display "sets" per layer: 立體 3D / 點位 Dots (2026-07-12) ------
// Both layers now follow the ports/hospitals/medical "sets" panel convention
// (see medical.js header) instead of a single visibleParam/paramMap toggle:
//   立體 3D    — the near-view InstancedMesh silhouettes described above,
//                unchanged mechanics, just wrapped as one independently-
//                toggleable set.
//   點位 Dots  — ALL points, ALWAYS resident, NO camDist/lodZoom gate at all
//                (the whole point is to see nationwide distribution at any
//                zoom, including the far views where 立體 3D never
//                activates). One THREE.Points cloud per layer — a single
//                draw call regardless of count (26,589 towers / 812
//                turbines), sizeAttenuation OFF so each dot stays a small
//                constant ~3px on screen instead of ballooning as the camera
//                dollies in. Built once positions + a live heightField exist
//                (先空後填 — see ensureDotsBuilt/computeDotPositions below);
//                only the Y column is ever recomputed after that (on a
//                demExaggeration change), never rebuilt from scratch.
// Both sets default to visible: true (medical.js's makeCatState convention)
// — the brief's design: far away you see the dots' spread, dolly in and the
// 3D silhouettes fade in on top of the same points (deliberately allowed to
// overlap; a nearby dot sitting inside its own 3D tower's footprint reads as
// "this is the same object at two LODs", not as clutter). Activation
// (fetching the manifest JSON) is the same one-shot onActivate/setVisible
// hook medical.js/markers.js use: the panel shows a single plain toggle
// until first switched on, then the two per-set rows take over (see
// describe()'s `sets` field).

const TOWER_HEIGHT_BY_CLASS = { 0: 25, 1: 40, 2: 55 } // meters — MUST mirror bake_energy.py's TOWER_HEIGHT_BY_CLASS
const TOWER_BASE_RADIUS_M = 2.2
const TOWER_TOP_RADIUS_M = 0.5
const TOWER_ARM_LEN_M = 5
const TOWER_ARM_THICK_M = 0.35
const TOWER_ARM_Y = 0.82 // fraction of real height
const TOWER_COLOR = '#5c6670'

const TOWER_NEAR_ENTER_DIST = 6 // world units (~2.9 km) — camDist below this: towers appear
const TOWER_NEAR_EXIT_DIST = 9 // world units (~4.3 km) — above this: towers hide (hysteresis, mirrors trains.js)
const TOWER_LOD_ZOOM_MIN = 12
const TOWER_GATHER_RADIUS = 9 // world units around the pan center — subset actually instanced
const TOWER_REBUILD_DELTA = 1.5 // world units the pan center must move before re-scanning the grid
const TOWER_MAX_INSTANCES = 3000 // generous headroom over measured corridor density — see handoff report
const TOWER_GRID_CELL = 2 // world units
// 點位 Dots set: same steel-gray as the 3D silhouette's TOWER_COLOR — visually
// checked (2026-07-12) against both the tan mountain color ramp and the pale
// low-elevation plains: a lighter tint washed out badly on the plains, this
// exact color reads clearly on both.
const TOWER_DOT_COLOR = TOWER_COLOR
const TOWER_DOT_PX = 4 // base gl_PointSize (sizeAttenuation off, in device px) — devicePixelRatio 2 -> ~2 CSS px

const TURBINE_HEIGHT_M = 80 // fixed per the design brief — capacity_mw does not change tower height
const TURBINE_TOWER_RADIUS_M = 2
const TURBINE_NACELLE_LEN_M = 6
const TURBINE_NACELLE_W_M = 2.4
const TURBINE_BLADE_LEN_M = 38
const TURBINE_BLADE_W_M = 1.4
const TURBINE_HUB_Y = 0.97 // fraction of real height
const TURBINE_COLOR = '#f2f4f6'

const TURBINE_NEAR_ENTER_DIST = 10 // world units — a bit further than towers (visually larger, sparser, more notable)
const TURBINE_NEAR_EXIT_DIST = 14
const TURBINE_LOD_ZOOM_MIN = 12
// 點位 Dots set: a clear saturated cyan, same "白/青" family as the 3D
// silhouette's near-white TURBINE_COLOR but pulled further from white —
// visually checked (2026-07-12): TURBINE_COLOR itself (near-white) all but
// vanished against both the pale low-elevation plains and light fog; this
// cyan reads clearly against terrain tan, mountain gray, AND white plains.
const TURBINE_DOT_COLOR = '#29b6d8'
const TURBINE_DOT_PX = 4.5 // slightly larger than towers' dot — turbines are the sparser, more "notable" set (mirrors TURBINE_NEAR_ENTER_DIST's own reasoning)

const PICK_PX = 16 // click-to-inspect screen-space tolerance (markers.js/trains.js proximity-pick convention)
const SET_3D = '立體 3D' // panel set id (shown directly as the row label — medical.js CAT_NAMES convention)
const SET_DOTS = '點位 Dots'

// ---------------------------------------------------------------- shared geometry builders

// simplified lattice-tower silhouette: a tapered hexagonal cone body + a
// crossarm "十字" pair near the top. Triangle budget: cone 6 segs × 2 = 12
// tris, 2 arms × 12 tris (BoxGeometry) = 24 tris -> 36 tris/instance, well
// under the ≤80 spec ceiling.
function buildTowerUnitGeometry() {
  const cone = new THREE.CylinderGeometry(TOWER_TOP_RADIUS_M, TOWER_BASE_RADIUS_M, 1, 6, 1, true)
  cone.translate(0, 0.5, 0) // base at y=0, tip at y=1

  const armA = new THREE.BoxGeometry(TOWER_ARM_LEN_M, TOWER_ARM_THICK_M, TOWER_ARM_THICK_M)
  armA.translate(0, TOWER_ARM_Y, 0)
  const armB = new THREE.BoxGeometry(TOWER_ARM_THICK_M, TOWER_ARM_THICK_M, TOWER_ARM_LEN_M)
  armB.translate(0, TOWER_ARM_Y, 0)

  const merged = mergeGeometries([cone, armA, armB], false)
  cone.dispose()
  armA.dispose()
  armB.dispose()
  return merged
}

// simplified wind turbine: thin tower cylinder + a small nacelle box + 3 flat
// static blades fanned 120° apart at the hub. No rotation (see module TODO).
// Triangle budget: tower 8×2=16, nacelle 12, 3 blades × 12 = 36 -> 64 tris.
function buildTurbineUnitGeometry() {
  const tower = new THREE.CylinderGeometry(TURBINE_TOWER_RADIUS_M * 0.6, TURBINE_TOWER_RADIUS_M, 1, 8, 1, true)
  tower.translate(0, 0.5, 0)

  const nacelle = new THREE.BoxGeometry(TURBINE_NACELLE_LEN_M, TURBINE_NACELLE_W_M, TURBINE_NACELLE_W_M)
  nacelle.translate(TURBINE_NACELLE_LEN_M * 0.25, TURBINE_HUB_Y, 0)

  const parts = [tower, nacelle]
  for (let b = 0; b < 3; b++) {
    const blade = new THREE.BoxGeometry(TURBINE_BLADE_LEN_M, TURBINE_BLADE_W_M, TURBINE_BLADE_W_M * 0.3)
    blade.translate(TURBINE_BLADE_LEN_M / 2, 0, 0) // root at the hub, extending outward along +X
    blade.rotateZ(THREE.MathUtils.degToRad(b * 120))
    blade.translate(0, TURBINE_HUB_Y, 0)
    parts.push(blade)
  }
  const merged = mergeGeometries(parts, false)
  for (const p of parts) p.dispose()
  return merged
  // TODO(anim): real turbines spin their blades continuously — deliberately
  // static this pass (an animated blade would force the render loop out of
  // idle exactly like typhoon/seaAnimated do; nothing in this task's scope
  // asked for that ambient-animation cost). Revisit alongside a broader
  // "ambient decorations" budget review if wanted later.
}

// ---------------------------------------------------------------- spatial grid (towers only)

// exported so other high-count point layers (medical.js) can reuse the same
// gather-near-camera pattern instead of re-deriving it
export function buildGrid(points, cellSize) {
  const grid = new Map()
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const key = Math.floor(p._x / cellSize) + ',' + Math.floor(p._z / cellSize)
    let arr = grid.get(key)
    if (!arr) {
      arr = []
      grid.set(key, arr)
    }
    arr.push(i)
  }
  return grid
}

export function gatherNear(grid, cellSize, cx, cz, radius, points, maxCount) {
  const r2 = radius * radius
  const cMin = Math.floor((cx - radius) / cellSize)
  const cMax = Math.floor((cx + radius) / cellSize)
  const rMin = Math.floor((cz - radius) / cellSize)
  const rMax = Math.floor((cz + radius) / cellSize)
  const candidates = []
  for (let gx = cMin; gx <= cMax; gx++) {
    for (let gz = rMin; gz <= rMax; gz++) {
      const arr = grid.get(gx + ',' + gz)
      if (!arr) continue
      for (const idx of arr) {
        const p = points[idx]
        const dx = p._x - cx
        const dz = p._z - cz
        const d2 = dx * dx + dz * dz
        if (d2 <= r2) candidates.push({ idx, d2 })
      }
    }
  }
  candidates.sort((a, b) => a.d2 - b.d2)
  const n = Math.min(candidates.length, maxCount)
  const out = new Array(n)
  for (let i = 0; i < n; i++) out[i] = candidates[i].idx
  return out
}

const ENERGY_STYLE = {
  size: { type: 'slider', label: '大小 Size', min: 0.5, max: 3.0, step: 0.05, format: (v) => v.toFixed(2) },
  opacity: { type: 'slider', label: '不透明度 Opacity', min: 0.1, max: 1, step: 0.02, format: (v) => v.toFixed(2) },
}

// ---------------------------------------------------------------- 點位 Dots (shared, both layers)

// world XYZ for every point, in a flat Float32Array ready for a
// THREE.BufferAttribute — the whole "點位 Dots" set is one draw call, no
// per-instance matrix (a Points cloud only needs position). Caches lon/lat ->
// world x/z on each point the same way ensurePositions()/layoutAll() already
// do elsewhere in this module, so whichever code path (grid build, dots
// build) runs first pays that one-time cost.
function computeDotPositions(points, hf, exaggeration) {
  const proj = hf.projection
  const arr = new Float32Array(points.length * 3)
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (p._x === undefined) {
      const w = proj.lonLatToWorld(p.lon, p.lat)
      p._x = w.x
      p._z = w.z
    }
    const y = p.elev != null ? metersToWorldY(hf, p.elev, exaggeration) : drapeAt(hf, p._x, p._z, exaggeration)
    arr[i * 3] = p._x
    arr[i * 3 + 1] = y
    arr[i * 3 + 2] = p._z
  }
  return arr
}

// one THREE.Points cloud, always fully resident once built (no camDist/
// lodZoom gate — "全量常駐" is the whole point of this set) — shared builder
// for both power towers (26,589 pts) and wind turbines (812 pts). Returns a
// small handle the caller stores and drives from its own update()/setStyle().
function createDotsCloud(color, basePx) {
  const material = new THREE.PointsMaterial({
    color: new THREE.Color(color),
    size: basePx,
    sizeAttenuation: false, // constant ~2-3 px screen size at any zoom, not a world-unit radius
    transparent: false,
    opacity: 1,
    depthTest: true, // respect terrain occlusion — these sit ON the real surface, not a HUD overlay
    depthWrite: true,
    fog: true,
  })
  let mesh = null // THREE.Points — created lazily once positions + a heightField exist (先空後填)
  let built = false
  let lastExaggeration = null
  return {
    material,
    get object() {
      return mesh
    },
    get built() {
      return built
    },
    // (re)build or refresh positions. No-op until `points`+`hf` are ready;
    // cheap re-entrant call from update() every frame — the two guards
    // (built, exaggeration-unchanged) make the steady-state cost a single
    // comparison, matching the on-demand-render mandate.
    ensure(group, points, hf, exaggeration) {
      if (!hf || !points.length) return
      if (!built) {
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.BufferAttribute(computeDotPositions(points, hf, exaggeration), 3))
        mesh = new THREE.Points(geo, material)
        group.add(mesh)
        built = true
        lastExaggeration = exaggeration
        return
      }
      if (lastExaggeration === exaggeration) return
      const attr = mesh.geometry.attributes.position
      attr.array.set(computeDotPositions(points, hf, exaggeration))
      attr.needsUpdate = true
      mesh.geometry.computeBoundingSphere()
      lastExaggeration = exaggeration
    },
    setSize(px) {
      material.size = px
    },
    setOpacity(v) {
      material.opacity = v
      material.transparent = v < 1
    },
    dispose() {
      mesh?.geometry.dispose()
      material.dispose()
    },
  }
}

function applyOpacity(material, opacity) {
  material.opacity = opacity
  material.transparent = opacity < 1
}

// ================================================================== 電塔 Power Towers
export function createPowerTowersLayer(params, { onActivate } = {}) {
  const group = new THREE.Group()
  group.visible = false

  const geo = buildTowerUnitGeometry()
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(TOWER_COLOR),
    opacity: params.powerTowersOpacity ?? 0.9,
    transparent: (params.powerTowersOpacity ?? 0.9) < 1,
    depthWrite: true,
    fog: true,
  })
  const mesh = new THREE.InstancedMesh(geo, material, TOWER_MAX_INSTANCES)
  mesh.count = 0 // 先空後填 — nothing drawn until data + a near-enough view exist
  group.add(mesh)
  // 點位 Dots set (see module header) — full 26,589-point cloud, no camDist
  // gate, one draw call. ensure()'d lazily in update() once data+hf exist.
  const dots = createDotsCloud(TOWER_DOT_COLOR, TOWER_DOT_PX * (params.powerTowersSize ?? 1))

  let points = [] // baked {lon,lat,elev,v,vc,op}
  let operators = []
  let grid = null
  let hf = null
  let dataReady = false
  let positionsReady = false
  let activated = false // one-shot onActivate guard (medical.js/markers.js contract)
  const setState = { threeD: true, dots: true } // per-set panel toggle, both default on (see module header)
  let nearMode = false
  let lastCenter = null
  let lastExaggeration = null
  let lastSizeMult = null
  let visibleList = [] // parallel to instance slots: {idx, x, y, z, topY}
  const _m = new THREE.Matrix4()

  // layer-level gate: no more single powerTowersVisible boolean — visibility
  // is now per-set (setState.threeD / setState.dots), applied independently
  // in tickView()/update() below.
  function active() {
    return params.source === 'real' && !!hf && dataReady
  }

  // lon/lat -> world x/z, once per point, the first time a live projection
  // exists — then builds the spatial grid over those cached coordinates.
  function ensurePositions() {
    if (positionsReady || !hf) return
    const proj = hf.projection
    for (const p of points) {
      const w = proj.lonLatToWorld(p.lon, p.lat)
      p._x = w.x
      p._z = w.z
    }
    grid = buildGrid(points, TOWER_GRID_CELL)
    positionsReady = true
  }

  function layoutVisible(center) {
    const exaggeration = params.demExaggeration
    const sizeMult = params.powerTowersSize ?? 1
    const K = hf.projection.K
    const radialScale = K * sizeMult
    const idxList = gatherNear(grid, TOWER_GRID_CELL, center.x, center.z, TOWER_GATHER_RADIUS, points, TOWER_MAX_INSTANCES)
    visibleList = new Array(idxList.length)
    for (let i = 0; i < idxList.length; i++) {
      const p = points[idxList[i]]
      const heightM = TOWER_HEIGHT_BY_CLASS[p.vc] ?? TOWER_HEIGHT_BY_CLASS[0]
      const baseY = p.elev != null ? metersToWorldY(hf, p.elev, exaggeration) : drapeAt(hf, p._x, p._z, exaggeration)
      const heightWorld = K * exaggeration * sizeMult * heightM
      _m.makeScale(radialScale, heightWorld, radialScale)
      _m.setPosition(p._x, baseY, p._z)
      mesh.setMatrixAt(i, _m)
      visibleList[i] = { idx: idxList[i], x: p._x, y: baseY, z: p._z, topY: baseY + heightWorld }
    }
    mesh.count = idxList.length
    if (idxList.length > 0) {
      mesh.instanceMatrix.needsUpdate = true
      mesh.computeBoundingSphere()
    }
    lastCenter = { x: center.x, z: center.z }
    lastExaggeration = exaggeration
    lastSizeMult = sizeMult
  }

  return {
    id: 'power_towers',
    kind: 'point',
    label: 'Power Towers',
    rowLabel: '電塔 Power Towers',
    object3d: group,

    build() {},

    // deferred data arrival (onActivate -> index.js loadPowerTowersData). No
    // mesh work here — positions/grid materialize lazily in update() once a
    // live heightField exists (mirrors airspace.js/reservoirs' setData/build split).
    setData(loadedPoints, loadedOperators) {
      points = loadedPoints
      operators = loadedOperators ?? []
      positionsReady = false
      dataReady = points.length > 0
    },

    // one-shot activation trigger (medical.js/markers.js contract): the panel
    // shows a single plain toggle until describe()'s `sets` first appears —
    // flipping it calls this, which fires the manifest fetch exactly once.
    setVisible(v) {
      if (!v || activated || !onActivate) return
      activated = true
      Promise.resolve(onActivate()).catch((err) => {
        console.warn('[layers] power_towers activation failed', err)
        activated = false
      })
    },

    // panel per-set toggle (立體 3D / 點位 Dots independently) — index.js's
    // setLayerSet forwards here; def is always {visible} from the panel.
    setSet(setId, def = {}) {
      if (setId === SET_3D) {
        if (def.visible !== undefined) setState.threeD = def.visible
      } else if (setId === SET_DOTS) {
        if (def.visible !== undefined) setState.dots = def.visible
      }
    },

    update(ctx) {
      hf = ctx.heightField
      const on = active()
      if (on) {
        ensurePositions()
        applyOpacity(material, params.powerTowersOpacity ?? 0.9)
        dots.ensure(group, points, hf, params.demExaggeration)
        dots.setOpacity(params.powerTowersOpacity ?? 0.9)
      }
      // group.visible alone fully hides everything when off (three.js skips
      // invisible objects entirely) — mesh.count/visibleList are deliberately
      // left as-is so re-showing without an intervening camera move redraws
      // instantly instead of waiting for tickView's moved-delta to trip.
      group.visible = on
      if (dots.object) dots.object.visible = on && setState.dots
    },

    // per-frame (only while non-idle): hysteresis near/far switch + throttled
    // spatial re-gather for the 立體 3D set. 點位 Dots has no per-frame work —
    // its visibility is set once in update() above and its geometry is static
    // once built (only demExaggeration changes touch it, handled by
    // dots.ensure's own staleness check).
    tickView(ctx) {
      if (!active() || !positionsReady) return
      const zoomOk = (ctx.lodZoom ?? TOWER_LOD_ZOOM_MIN) >= TOWER_LOD_ZOOM_MIN
      if (nearMode && (ctx.camDist > TOWER_NEAR_EXIT_DIST || !zoomOk)) nearMode = false
      else if (!nearMode && ctx.camDist < TOWER_NEAR_ENTER_DIST && zoomOk) nearMode = true

      const show3D = nearMode && setState.threeD
      mesh.visible = show3D
      if (!show3D) {
        if (mesh.count !== 0) {
          mesh.count = 0
          visibleList = []
        }
        lastCenter = null // force a fresh gather next time 立體 3D/nearMode turns back on
        return
      }
      const center = ctx.labelCenter ?? { x: ctx.camera.position.x, z: ctx.camera.position.z }
      const sizeMult = params.powerTowersSize ?? 1
      const moved = !lastCenter || Math.hypot(center.x - lastCenter.x, center.z - lastCenter.z) > TOWER_REBUILD_DELTA
      const styleChanged = lastExaggeration !== params.demExaggeration || lastSizeMult !== sizeMult
      if (moved || styleChanged) layoutVisible(center)
    },

    setStyle(patch) {
      if (patch.size !== undefined) {
        params.powerTowersSize = patch.size
        dots.setSize(TOWER_DOT_PX * patch.size) // one shared slider scales both sets (brief's requirement)
      }
      if (patch.opacity !== undefined) {
        params.powerTowersOpacity = patch.opacity
        applyOpacity(material, patch.opacity)
        dots.setOpacity(patch.opacity)
      }
    },

    // click-to-inspect: proximity-pick over the currently-instanced 立體 3D
    // subset only (markers.js/trains.js convention — these are a few px on
    // screen; 點位 Dots stays unclickable, same scale problem doubled).
    pick(raycaster) {
      if (!group.visible || !mesh.visible || visibleList.length === 0) return null
      const camera = raycaster.camera
      const clickPx = raycaster.pickPx
      if (!camera || !clickPx) return null
      const w = window.innerWidth
      const h = window.innerHeight
      const _world = new THREE.Vector3()
      const _proj = new THREE.Vector3()
      let best = null
      for (const v of visibleList) {
        _world.set(v.x, v.y + (v.topY - v.y) * 0.5, v.z)
        _proj.copy(_world).project(camera)
        if (_proj.z < -1 || _proj.z > 1) continue
        const sx = (_proj.x * 0.5 + 0.5) * w
        const sy = (-_proj.y * 0.5 + 0.5) * h
        const d = Math.hypot(sx - clickPx.x, sy - clickPx.y)
        if (d < PICK_PX && (!best || d < best.d)) best = { d, v }
      }
      if (!best) return null
      const p = points[best.v.idx]
      const voltageStr = p.v ? `${Math.round(Number(p.v) / 1000)} kV` : '未知 Unknown'
      const opName = p.op != null ? operators[p.op] : null
      return {
        title: '電塔 Power Tower',
        rows: [
          ['電壓 Voltage', voltageStr],
          ['經營者 Operator', opName || '—'],
        ],
        worldPos: new THREE.Vector3(best.v.x, best.v.y, best.v.z),
      }
    },

    describe() {
      const sets = dataReady
        ? [
            { id: SET_3D, count: visibleList.length, visible: setState.threeD },
            { id: SET_DOTS, count: points.length, visible: setState.dots },
          ]
        : []
      return {
        id: 'power_towers',
        kind: 'point',
        label: 'Power Towers',
        rowLabel: '電塔 Power Towers',
        count: points.length,
        visible: dataReady && (setState.threeD || setState.dots),
        styleSchema: ENERGY_STYLE,
        style: { size: params.powerTowersSize ?? 1, opacity: params.powerTowersOpacity ?? 0.9 },
        sets: sets.length > 0 || activated ? sets : undefined,
      }
    },

    dispose() {
      geo.dispose()
      material.dispose()
      dots.dispose()
    },
  }
}

// ================================================================== 風機 Wind Turbines
export function createWindTurbinesLayer(params, { onActivate } = {}) {
  const group = new THREE.Group()
  group.visible = false

  const geo = buildTurbineUnitGeometry()
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(TURBINE_COLOR),
    opacity: params.windTurbinesOpacity ?? 0.95,
    transparent: (params.windTurbinesOpacity ?? 0.95) < 1,
    depthWrite: true,
    fog: true,
  })
  let mesh = null // 先空後填: created only once data + heightField exist (capacity == point count, known then)
  // 點位 Dots set (see module header) — full 812-point cloud, no camDist gate.
  const dots = createDotsCloud(TURBINE_DOT_COLOR, TURBINE_DOT_PX * (params.windTurbinesSize ?? 1))

  let points = [] // baked {lon,lat,elev,cap,op}
  let hf = null
  let dataReady = false
  let built = false
  let activated = false // one-shot onActivate guard (medical.js/markers.js contract)
  const setState = { threeD: true, dots: true } // per-set panel toggle, both default on (see module header)
  let nearMode = false
  let lastExaggeration = null
  let lastSizeMult = null
  const hitList = [] // parallel to instance slots: {x,y,z,topY}
  const _m = new THREE.Matrix4()

  // layer-level gate: no more single windTurbinesVisible boolean — visibility
  // is now per-set (setState.threeD / setState.dots), applied independently
  // in tickView()/update() below.
  function active() {
    return params.source === 'real' && !!hf && dataReady
  }

  function layoutAll() {
    const proj = hf.projection
    const exaggeration = params.demExaggeration
    const sizeMult = params.windTurbinesSize ?? 1
    const K = proj.K
    const radialScale = K * sizeMult
    const heightWorld = K * exaggeration * sizeMult * TURBINE_HEIGHT_M
    hitList.length = 0
    for (let i = 0; i < points.length; i++) {
      const p = points[i]
      if (p._x === undefined) {
        const w = proj.lonLatToWorld(p.lon, p.lat)
        p._x = w.x
        p._z = w.z
      }
      const baseY = p.elev != null ? metersToWorldY(hf, p.elev, exaggeration) : drapeAt(hf, p._x, p._z, exaggeration)
      _m.makeScale(radialScale, heightWorld, radialScale)
      _m.setPosition(p._x, baseY, p._z)
      mesh.setMatrixAt(i, _m)
      hitList.push({ idx: i, x: p._x, y: baseY, z: p._z, topY: baseY + heightWorld })
    }
    mesh.count = points.length
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
    lastExaggeration = exaggeration
    lastSizeMult = sizeMult
  }

  function buildMesh() {
    if (built || !hf || !points.length) return
    mesh = new THREE.InstancedMesh(geo, material, points.length)
    mesh.count = 0
    group.add(mesh)
    layoutAll()
    built = true
  }

  return {
    id: 'wind_turbines',
    kind: 'point',
    label: 'Wind Turbines',
    rowLabel: '風機 Wind Turbines',
    object3d: group,

    build() {},

    setData(loadedPoints) {
      points = loadedPoints
      built = false
      dataReady = points.length > 0
    },

    // one-shot activation trigger (medical.js/markers.js contract): the panel
    // shows a single plain toggle until describe()'s `sets` first appears —
    // flipping it calls this, which fires the manifest fetch exactly once.
    setVisible(v) {
      if (!v || activated || !onActivate) return
      activated = true
      Promise.resolve(onActivate()).catch((err) => {
        console.warn('[layers] wind_turbines activation failed', err)
        activated = false
      })
    },

    // panel per-set toggle (立體 3D / 點位 Dots independently) — index.js's
    // setLayerSet forwards here; def is always {visible} from the panel.
    setSet(setId, def = {}) {
      if (setId === SET_3D) {
        if (def.visible !== undefined) setState.threeD = def.visible
      } else if (setId === SET_DOTS) {
        if (def.visible !== undefined) setState.dots = def.visible
      }
    },

    update(ctx) {
      hf = ctx.heightField
      const on = active()
      if (on) {
        if (!built) buildMesh()
        else if (lastExaggeration !== params.demExaggeration || lastSizeMult !== (params.windTurbinesSize ?? 1)) layoutAll()
        applyOpacity(material, params.windTurbinesOpacity ?? 0.95)
        dots.ensure(group, points, hf, params.demExaggeration)
        dots.setOpacity(params.windTurbinesOpacity ?? 0.95)
      }
      // group.visible alone fully hides everything when off — mesh.count/
      // nearMode are deliberately left as-is (see power-towers' update() for
      // the same reasoning): re-showing without an intervening camera move
      // redraws instantly.
      group.visible = on && built
      if (dots.object) dots.object.visible = on && setState.dots
    },

    // per-frame: same near/far camDist hysteresis as towers ("仍掛距離 gate
    // 防遠景雜訊") but no spatial subset — all 812 instances are already laid
    // out (layoutAll), this just flips mesh.count between 0 and the full
    // count so idle-camera cost is a single distance compare. 點位 Dots has no
    // per-frame work (see power-towers' tickView doc).
    tickView(ctx) {
      if (!active() || !built) return
      const zoomOk = (ctx.lodZoom ?? TURBINE_LOD_ZOOM_MIN) >= TURBINE_LOD_ZOOM_MIN
      if (nearMode && (ctx.camDist > TURBINE_NEAR_EXIT_DIST || !zoomOk)) nearMode = false
      else if (!nearMode && ctx.camDist < TURBINE_NEAR_ENTER_DIST && zoomOk) nearMode = true
      const show3D = nearMode && setState.threeD
      mesh.visible = show3D
      const wantCount = show3D ? points.length : 0
      if (mesh.count !== wantCount) mesh.count = wantCount
    },

    setStyle(patch) {
      if (patch.size !== undefined) {
        params.windTurbinesSize = patch.size
        if (built) layoutAll()
        dots.setSize(TURBINE_DOT_PX * patch.size) // one shared slider scales both sets (brief's requirement)
      }
      if (patch.opacity !== undefined) {
        params.windTurbinesOpacity = patch.opacity
        applyOpacity(material, patch.opacity)
        dots.setOpacity(patch.opacity)
      }
    },

    // click-to-inspect: 立體 3D subset only (點位 Dots stays unclickable, same
    // scale problem as power towers' dots — see that layer's pick() doc).
    pick(raycaster) {
      if (!group.visible || !mesh || !mesh.visible || mesh.count === 0) return null
      const camera = raycaster.camera
      const clickPx = raycaster.pickPx
      if (!camera || !clickPx) return null
      const w = window.innerWidth
      const h = window.innerHeight
      const _world = new THREE.Vector3()
      const _proj = new THREE.Vector3()
      let best = null
      for (const v of hitList) {
        _world.set(v.x, v.y + (v.topY - v.y) * 0.6, v.z)
        _proj.copy(_world).project(camera)
        if (_proj.z < -1 || _proj.z > 1) continue
        const sx = (_proj.x * 0.5 + 0.5) * w
        const sy = (-_proj.y * 0.5 + 0.5) * h
        const d = Math.hypot(sx - clickPx.x, sy - clickPx.y)
        if (d < PICK_PX && (!best || d < best.d)) best = { d, v }
      }
      if (!best) return null
      const p = points[best.v.idx]
      return {
        title: '風機 Wind Turbine',
        rows: [
          ['裝置容量 Capacity', p.cap != null ? `${p.cap} MW` : '未知 Unknown'],
          ['經營者 Operator', p.op || '—'],
        ],
        worldPos: new THREE.Vector3(best.v.x, best.v.y, best.v.z),
      }
    },

    describe() {
      const sets = dataReady
        ? [
            { id: SET_3D, count: nearMode ? points.length : 0, visible: setState.threeD },
            { id: SET_DOTS, count: points.length, visible: setState.dots },
          ]
        : []
      return {
        id: 'wind_turbines',
        kind: 'point',
        label: 'Wind Turbines',
        rowLabel: '風機 Wind Turbines',
        count: points.length,
        visible: dataReady && (setState.threeD || setState.dots),
        styleSchema: ENERGY_STYLE,
        style: { size: params.windTurbinesSize ?? 1, opacity: params.windTurbinesOpacity ?? 0.95 },
        sets: sets.length > 0 || activated ? sets : undefined,
      }
    },

    dispose() {
      geo.dispose()
      material.dispose()
      dots.dispose()
    },
  }
}
