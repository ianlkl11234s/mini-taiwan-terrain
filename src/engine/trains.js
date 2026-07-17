import * as THREE from 'three'
import { metersToWorldY, zFightLift } from './geo.js'
import * as timeStore from '../state/timeStore.js'

// Trains: real timetable-driven InstancedMesh light dots gliding along
// rail_lines.json polylines, driven by the timeline's time store (src/state/
// timeStore.js, see docs/TIMELINE_DESIGN.md) instead of the live wall clock —
// play/pause/seek/speed all flow through timeStore.getDaySeconds(). Manifest-
// driven deferred layer, same fail-quiet pattern as rail/trails (see index.js
// loadTrainsData/loadThsrData): registers empty at startup, fed real data via
// setData() once its tracks.json + schedule.json + rail_lines.json have all
// landed (first switch-on).
//
// createTrainsLayer is a parametrized factory — one call = one network. The
// TRA (台鐵) instance (index.js's `createTrainsLayer(params)`, 992 trains,
// scripts/bake_trains.py) was the original/only caller; the THSR (高鐵)
// instance (`createTrainsLayer(params, { id: 'thsr', ... })`, 212 trains,
// same bake script's bake_thsr()) reuses every piece of machinery below —
// see `config` below and its `singleCorridor` flag for the one place their
// data shapes actually diverge.
//
// Data contract (baked by scripts/bake_trains.py — see its header comment):
//   <net>_tracks.json   parts[]     index-aligned 1:1 with rail_lines.json's
//                                  system==<railNetwork> filter (same order
//                                  — 37 tra entries, 2 thsr entries). Each
//                                  part carries its station→ratio table
//                                  (ratio = EPSG:3826 arc-length fraction
//                                  0..1 along THAT part's own polyline — see
//                                  distance_metric in its meta).
//   <net>_schedule.json schedules[] one real train per entry: stops[] with
//                                  arr_sec/dep_sec relative to the train's own
//                                  first departure, + dep_sec_of_day (Asia/
//                                  Taipei wall-clock seconds-since-midnight
//                                  anchoring that first departure — added by
//                                  this repo's bake script; not present in
//                                  pulse's upstream master_schedule.json).
//
// Placement pipeline (mirrors bake_trains.py's own leg_progress_at(), which
// doubles as the reference algorithm — see its docstring):
//   1. build(): once, per rail_lines.json part (this network's railNetwork
//      filter) — reproject every vertex to EPSG:3826 (same metric the bake
//      script used for its station ratios) and accumulate arc length, so
//      ratio 0..1 can be converted back to a lon/lat/elev point by walking
//      the SAME metric. Naive lon/lat Euclidean distance would NOT reproduce
//      the baked ratios (1° lon != 1° lat in meters, and both vary with
//      latitude) — the train would run crooked and at uneven speed along
//      curves.
//   2. build(): once, per train — resolve each adjacent-stop leg to a part
//      index (see `singleCorridor` below for the two resolution strategies)
//      and cache ratio_from/ratio_to. A leg that can't be resolved is left
//      unresolved: the train simply isn't rendered for that leg's time
//      window rather than guessing a wrong position.
//   3. tickView(): every frame — find which trains are currently in service
//      (sweep-line index, not a full-roster scan), locate each one's current
//      leg/ratio, sample the part's arc-length table, project to world space.
//
// Dual-mode LOD (2026-07): at the P0/P1 default view (camDist ~26 world
// units) and beyond, trains render exactly as before — one light dot per
// train (layoutDots). Dolly in past CAR_LOD_ENTER_DIST and each train
// switches to a chain of `carCount` instanced boxes (layoutCars): car i's
// center sits at ratio `headRatio − dir·i·(carLenM/part.lengthM)` — a real
// arc-length offset behind the head, walked along the SAME part the head is
// on, so the chain naturally hugs curves instead of cutting corners like a
// rigid rod would. `dir` (see locateTrain's _loc.dir) is the sign of the
// current leg's ratioTo−ratioFrom: which way ratio increases isn't always
// "forward" (depends on the part's own vertex order vs the train's travel
// direction), so the tail offset has to follow it or it'd extend the wrong
// way on roughly half of all legs. Car orientation comes from the chain
// itself (tail→head vector between adjacent car centers), not a fresh
// per-car tangent sample — cheap and correct since the cars are already laid
// out along the curve. camDist crosses back out past CAR_LOD_EXIT_DIST
// (> CAR_LOD_ENTER_DIST) before reverting to dots — the gap is deliberate
// hysteresis so a small dolly wobble near the boundary can't flap the mode
// every frame. Both InstancedMeshes are built once, up front, at full
// capacity ("先空後填" — see module CLAUDE.md) — only mesh.count toggles
// between 0 and real per frame; only one of dotMesh/carMesh is ever nonzero
// at a time.

const DEFAULT_MAX_INSTANCES = 320 // TRA default: ~3x the observed weekday concurrent peak, margin for safety
const DOT_R = 0.11 // world units at fogScale 1
const LIFT_BASE = 0.08 // sits above the rail line's own 0.05 lift (polyline.js createRailLayer)
const REBUILD_ON_BACKWARD_JUMP = true
// Dual-mode LOD thresholds — raw camera-target distance (world units, NOT
// fogScale: fogScale stays clamped to 1 across this entire near range, see
// scene.js's `Math.max(1, camDist / LOD_D0)`, so it can't distinguish "just
// dollied in a bit" from "right on top of the tracks"). ENTER < EXIT is the
// hysteresis band (see module header) — a plain single threshold would flap
// every frame a dolly sat right on the boundary.
const CAR_LOD_ENTER_DIST = 7 // world units (~3.4km) — camDist below this: dots -> car chains
const CAR_LOD_EXIT_DIST = 10 // world units (~4.8km) — camDist above this: car chains -> dots
// click-to-inspect hit radius, CSS px — same fixed-screen-space rationale as
// markers.js's PICK_PX (dots are a few px on screen regardless of zoom, via
// the fogScale-scaled DOT_R; a world-space tolerance wouldn't track that)
const PICK_PX = 16

// HH:MM (Asia/Taipei) formatter for pick()'s info card — sec is seconds-
// since-midnight, wrapped so a value that rolled past 86400 (late-night train
// still running after midnight) still reads correctly.
function fmtHHMM(sec) {
  const s = ((Math.round(sec) % 86400) + 86400) % 86400
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// pick()'s "目前區間" (current section): which adjacent stop pair `elapsedSec`
// (seconds since the train's own first departure) currently sits between —
// dwelling at a station counts as between that station and the next. Walks
// stops[] (not legs[]/partIdx like locateTrain) since the info card only
// needs station names + arr_sec, not track geometry.
function sectionAt(stops, elapsedSec) {
  const n = stops.length
  if (elapsedSec >= stops[n - 1].arr_sec) return { prevIdx: n - 1, nextIdx: n - 1 }
  for (let i = 0; i < n - 1; i++) {
    if (elapsedSec <= stops[i + 1].arr_sec) return { prevIdx: i, nextIdx: i + 1 }
  }
  return { prevIdx: n - 1, nextIdx: n - 1 }
}

// point-layer styleSchema (size/opacity sliders) — same shape as markers.js's
// POINT_STYLE, plus the light-dot's own color swatch (trains have no baked
// per-line color the way rail does, see trains.js's material below). `size`
// pulls double duty: far view (dots) scales DOT_R same as always; near view
// (car chains, see layoutCars) scales the car cross-section (width/height)
// only — a real-scale 3m-wide car is sub-pixel at any distance a human would
// call "close", so this slider is the near-view legibility control too.
const TRAIN_STYLE = {
  color: { type: 'color', label: '光點顏色 Color' },
  size: { type: 'slider', label: '大小 Size', min: 0.5, max: 3.0, step: 0.05, format: (v) => v.toFixed(2) },
  opacity: { type: 'slider', label: '不透明度 Opacity', min: 0, max: 1, step: 0.02, format: (v) => v.toFixed(2) },
}

// ---------------------------------------------------------------- EPSG:3826 (TWD97 TM2 zone 121)
// Forward transverse-Mercator projection (GRS80 ellipsoid, k0=0.9999, central
// meridian 121°E, false easting 250000, false northing 0) — reproduces
// pyproj's EPSG:4326→EPSG:3826 to within ~10cm across Taiwan (verified against
// pyproj numerically while building this module). Used ONLY to build each
// part's arc-length table once; never called per frame.
function lonLatToTWD97(lon, lat) {
  const a = 6378137.0
  const b = 6356752.314245
  const long0 = (121 * Math.PI) / 180
  const k0 = 0.9999
  const falseEasting = 250000
  const e = Math.sqrt(1 - (b * b) / (a * a))
  const lon1 = (lon * Math.PI) / 180
  const lat1 = (lat * Math.PI) / 180

  const e2 = (e * e) / (1 - e * e)
  const n = (a - b) / (a + b)
  const nu = a / Math.sqrt(1 - (e * Math.sin(lat1)) ** 2)
  const p = lon1 - long0

  const A = a * (1 - n + ((5 * n * n) / 4) * (1 - n) + ((81 * n ** 4) / 64) * (1 - n))
  const B = ((3 * a * n) / 2) * (1 - n - ((7 * n * n) / 8) * (1 - n) + (55 * n ** 4) / 64)
  const C = ((15 * a * n * n) / 16) * (1 - n + ((3 * n * n) / 4) * (1 - n))
  const D = ((35 * a * n ** 3) / 48) * (1 - n + (11 * n * n) / 16)
  const E = ((315 * a * n ** 4) / 51) * (1 - n)

  const S = A * lat1 - B * Math.sin(2 * lat1) + C * Math.sin(4 * lat1) - D * Math.sin(6 * lat1) + E * Math.sin(8 * lat1)

  const K1 = S * k0
  const K2 = (k0 * nu * Math.sin(lat1) * Math.cos(lat1)) / 2
  const K3 =
    ((k0 * nu * Math.sin(lat1) * Math.cos(lat1) ** 3) / 24) *
    (5 - Math.tan(lat1) ** 2 + 9 * e2 * Math.cos(lat1) ** 2 + 4 * e2 ** 2 * Math.cos(lat1) ** 4)
  const y = K1 + K2 * p * p + K3 * p ** 4

  const K4 = k0 * nu * Math.cos(lat1)
  const K5 = ((k0 * nu * Math.cos(lat1) ** 3) / 6) * (1 - Math.tan(lat1) ** 2 + e2 * Math.cos(lat1) ** 2)
  const x = K4 * p + K5 * p ** 3 + falseEasting

  return { x, y }
}

// ---------------------------------------------------------------- per-part arc-length table
// pts: rail_lines.json point array for ONE tra part, [[lon,lat,elev], ...].
// Returns typed arrays + a 0..1 arc-length ratio per vertex (EPSG:3826
// metric) so ratioToPoint (below) can walk it with a binary search.
function buildPartGeometry(pts) {
  const n = pts.length
  const lon = new Float64Array(n)
  const lat = new Float64Array(n)
  const elev = new Float32Array(n)
  const cum = new Float64Array(n)
  let px = 0
  let py = 0
  for (let i = 0; i < n; i++) {
    const p = pts[i]
    lon[i] = p[0]
    lat[i] = p[1]
    elev[i] = p[2] ?? 0
    const { x, y } = lonLatToTWD97(p[0], p[1])
    cum[i] = i === 0 ? 0 : cum[i - 1] + Math.hypot(x - px, y - py)
    px = x
    py = y
  }
  const total = cum[n - 1] || 1
  const ratio = new Float32Array(n)
  for (let i = 0; i < n; i++) ratio[i] = cum[i] / total
  // lengthM: real arc length (meters) — layoutCars converts a car's real
  // length (carLenM) into a ratio delta via carLenM / lengthM, so the car
  // chain's on-track spacing matches its baked geometry exactly regardless
  // of how long this particular part happens to be.
  return { lon, lat, elev, ratio, n, lengthM: cum[n - 1] || 0 }
}

// ratio (0..1) -> lon/lat/elev along one part's polyline, via binary search +
// lerp on the arc-length table above. Writes into the shared `out` scratch
// object (zero allocation on the hot per-frame path).
function sampleAlongPart(part, ratio, out) {
  const r = part.ratio
  const n = part.n
  if (ratio <= r[0]) {
    out.lon = part.lon[0]
    out.lat = part.lat[0]
    out.elev = part.elev[0]
    return out
  }
  if (ratio >= r[n - 1]) {
    out.lon = part.lon[n - 1]
    out.lat = part.lat[n - 1]
    out.elev = part.elev[n - 1]
    return out
  }
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (r[mid] <= ratio) lo = mid
    else hi = mid
  }
  const span = r[hi] - r[lo]
  const t = span > 0 ? (ratio - r[lo]) / span : 0
  out.lon = part.lon[lo] + (part.lon[hi] - part.lon[lo]) * t
  out.lat = part.lat[lo] + (part.lat[hi] - part.lat[lo]) * t
  out.elev = part.elev[lo] + (part.elev[hi] - part.elev[lo]) * t
  return out
}

// resolveCorridorPart: singleCorridor networks only (THSR — a single
// physical corridor split into 2 full-length mirrored-direction parts, so
// EVERY station sits on BOTH parts and the TRA-style "lowest common part"
// search below would always resolve to part 0 regardless of actual travel
// direction). Resolves the WHOLE train's part once, via the same test
// bake_trains.py's match_thsr_track_to_part() uses: whichever part has
// ratio(first stop) < ratio(last stop). Every leg of that train then shares
// this one partIdx. Returns -1 if no part qualifies (leg left unresolved,
// same fail-quiet convention as the TRA path).
function resolveCorridorPart(stops, stationParts) {
  const mFirst = stationParts.get(stops[0].station)
  const mLast = stationParts.get(stops[stops.length - 1].station)
  if (!mFirst || !mLast) return -1
  for (const [partIdx, rFirst] of mFirst) {
    const rLast = mLast.get(partIdx)
    if (rLast !== undefined && rFirst < rLast) return partIdx
  }
  return -1
}

// config (all optional, defaults reproduce the original TRA-only behavior —
// see module header):
//   id            param-key prefix — visible/color/size/opacity params are
//                 `${id}Visible`/`${id}Color`/`${id}Size`/`${id}Opacity`.
//                 id='trains' (default) derives trainsVisible/trainsColor,
//                 the pre-existing TRA param names — zero migration.
//   label         English fallback label (Layers.jsx uses rowLabel first)
//   rowLabel      Layers panel row label (中文名 English name)
//   railNetwork   rail_lines.json `system` filter this network's tracks/
//                 schedule were baked against (see index.js's loader) — used
//                 here only for the setData() mismatch-warning message
//   maxInstances  InstancedMesh capacity (concurrent-in-service headroom)
//   singleCorridor  true for THSR: resolve one part per WHOLE train (see
//                 resolveCorridorPart) instead of TRA's per-leg lowest-
//                 common-part search
//   netLabel      short Chinese network name for pick()'s info-card title
//                 (e.g. "台鐵 1234 自強" / "高鐵 0803" — the type suffix is
//                 dropped when train_type already equals netLabel, which is
//                 always true for THSR's single "高鐵" train_type)
//   carLenM/carCount/widthM/heightM  near-view car-chain dimensions (see
//                 module header's dual-mode LOD section) — real per-car
//                 length in meters (drives on-track spacing, never resized:
//                 the chain must stay glued to its true arc length or it'd
//                 drift off the track as the train moves) and count, plus
//                 the cross-section (width/height) that DOES scale with the
//                 size param + demExaggeration (see layoutCars) since a
//                 true-scale 3m-wide box is sub-pixel at any distance a
//                 human would call "close". Defaults reproduce TRA's numbers.
export function createTrainsLayer(params, config = {}) {
  const {
    id = 'trains',
    label = 'Trains',
    rowLabel = '台鐵列車 Trains',
    railNetwork = 'tra',
    maxInstances = DEFAULT_MAX_INSTANCES,
    singleCorridor = false,
    netLabel = '台鐵',
    carLenM = 20,
    carCount = 6,
    widthM = 3,
    heightM = 4,
  } = config
  const visibleKey = `${id}Visible`
  const colorKey = `${id}Color`
  const sizeKey = `${id}Size`
  const opacityKey = `${id}Opacity`
  const KEY_TO_PARAM = { color: colorKey, size: sizeKey, opacity: opacityKey }

  const group = new THREE.Group()
  group.visible = false

  const geo = new THREE.IcosahedronGeometry(1, 1)
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(params[colorKey]),
    transparent: true,
    opacity: params[opacityKey] ?? 0.95,
    depthWrite: false,
    fog: true,
  })
  const dotMesh = new THREE.InstancedMesh(geo, material, maxInstances)
  dotMesh.count = 0 // "先空後填": nothing drawn until real schedule data lands (see setData)
  dotMesh.renderOrder = 5
  group.add(dotMesh)

  // car-chain mesh (near-view LOD, see module header) — same "先空後填"
  // discipline: built once at full capacity (maxInstances × carCount, see
  // config doc above) with count 0, never rebuilt. depthWrite true (unlike
  // the dot material): these are meant to read as solid boxes sitting on the
  // track, not billboard-style glow dots, so cars need to occlude each other
  // and the terrain correctly.
  const carGeo = new THREE.BoxGeometry(1, 1, 1)
  const carMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color(params[colorKey]),
    transparent: true,
    opacity: params[opacityKey] ?? 0.95,
    depthWrite: true,
    fog: true,
  })
  const carMesh = new THREE.InstancedMesh(carGeo, carMaterial, maxInstances * carCount)
  carMesh.count = 0
  carMesh.renderOrder = 5
  group.add(carMesh)
  const maxCarInstances = maxInstances * carCount
  // car-chain position scratch (layoutCars) — carCount is fixed for this
  // layer instance, so one flat Float64Array reused across every train/frame
  const _carPos = new Float64Array(carCount * 3)

  let hf = null
  let fogScale = 1
  let lift = LIFT_BASE
  let carMode = false // dot chain vs car chain — see updateCarMode

  // ---- data (populated once by setData; leg→part resolution happens HERE,
  // not per tick — see module header)
  let parts = null // Array<{lon,lat,elev,ratio,n}>, index-aligned tra_00..tra_36
  let trainsByStart = [] // every resolvable train, sorted ascending by dep_sec_of_day
  let dataReady = false

  // ---- sweep-line "currently in service" index (avoids a 992-train scan
  // every frame during normal forward playback — see module header)
  let active = []
  let startPtr = 0
  let lastQueryT = null
  let lastActiveCount = 0

  // ---- zero-allocation scratch (reused every tick)
  const _dummy = new THREE.Matrix4()
  const _sample = { lon: 0, lat: 0, elev: 0 }
  // dir: sign of ratioTo-ratioFrom for whichever leg supplied this fix — the
  // direction "forward" runs in ratio-space (see locateTrain). Only consumed
  // by layoutCars (car i's tail offset needs to know which way is "behind"
  // the head along the part's own ratio parametrization); layoutDots ignores it.
  const _loc = { partIdx: -1, ratio: 0, dir: 1 }
  const _pickWorld = new THREE.Vector3()
  const _pickProj = new THREE.Vector3()
  // car-chain scratch (layoutCars) — sized once per layer instance (carCount
  // is fixed per network, see config below), reused every train every frame
  const _carScale = new THREE.Vector3()
  // ride view scratch (getEntityLookahead, called from ride.js AFTER this
  // frame's layout() has already run) — kept separate from _sample so a
  // lookahead query can never alias whatever layout()'s own per-instance
  // sampling left in _sample
  const _sampleAhead = { lon: 0, lat: 0, elev: 0 }

  // click-to-inspect candidates (pick() below), refreshed every layout() call
  // — one entry per instance actually drawn this pass, carrying the train ref
  // + elapsed (for the info card) alongside its rendered world position
  // (markers.js's proximity-pick pattern: dots are a few px on screen, too
  // small for a true raycast, so pick() projects these with the raycaster's
  // own camera and compares to the click's screen pixel).
  let lastHits = []
  // trainNo -> {x,y,z}, refreshed every layout() call alongside lastHits —
  // O(1) lookup for getEntityPosition() (follow camera, see index.js/
  // follow.js), keyed by the SCHEDULE's train_no (stable across rebuilds,
  // unlike an instance index — see module header's getEntityPosition doc).
  // Dot mode: one entry per active train. Car mode: the HEAD car only (c===0)
  // — that's "the train's position" for a chained car-mesh the same way the
  // single dot was for the far-view LOD.
  const hitByTrainNo = new Map()
  // trainNo -> {partIdx, ratio, dir}, refreshed every layout() call alongside
  // hitByTrainNo — ride view's getEntityLookahead below needs the SAME
  // part/ratio/direction locateTrain resolved for this train this frame (not
  // just its resulting world position) to walk further along the track.
  const locByTrainNo = new Map()
  // ride view (src/engine/ride.js): trainNo currently hidden from rendering
  // because the camera is riding it — position/ratio bookkeeping above keeps
  // running regardless (ride still needs a live position), only the instance
  // matrix write is skipped (see layoutDots/layoutCars)
  let hiddenTrainNo = null

  function gate() {
    return params.source === 'real' && !!hf && params[visibleKey] && dataReady
  }

  // Asia/Taipei wall-clock seconds-since-midnight, driven by the timeline's
  // time store instead of the live wall clock — the Taipei conversion now
  // lives there as the single definition source (see
  // docs/TIMELINE_DESIGN.md §2.3). getDaySeconds() reads getTime() fresh
  // every call, so this stays correct through play/pause/seek/speed changes
  // with zero extra bookkeeping here.
  function currentDaySeconds() {
    return timeStore.getDaySeconds()
  }

  // elapsed seconds since a train's first departure, wrapped into [0, 86400)
  // so a train that departed late last night and is still running past
  // midnight is still found correctly (see rebuildActive/advanceActive below)
  function elapsedFor(train, t) {
    return (((t - train.firstDep) % 86400) + 86400) % 86400
  }

  // full 992-train scan: only on first activation, any backward time jump
  // (debug offset moved back, or the daily midnight wrap) — never during
  // normal forward playback (advanceActive handles that incrementally).
  function rebuildActive(t) {
    active = []
    let lo = 0
    let hi = trainsByStart.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (trainsByStart[mid].firstDep <= t) lo = mid + 1
      else hi = mid
    }
    startPtr = lo
    for (let i = 0; i < trainsByStart.length; i++) {
      const tr = trainsByStart[i]
      if (elapsedFor(tr, t) <= tr.lastArr) active.push(tr)
    }
  }

  // normal forward tick: add newcomers whose scheduled departure just passed,
  // drop finished trains from the active set — touches only the active set +
  // any newly-started trains, never the full 992.
  function advanceActive(t) {
    while (startPtr < trainsByStart.length && trainsByStart[startPtr].firstDep <= t) {
      active.push(trainsByStart[startPtr])
      startPtr++
    }
    for (let i = active.length - 1; i >= 0; i--) {
      if (elapsedFor(active[i], t) > active[i].lastArr) {
        active[i] = active[active.length - 1]
        active.pop()
      }
    }
  }

  function updateActiveSet(t) {
    if (lastQueryT === null || (REBUILD_ON_BACKWARD_JUMP && t < lastQueryT)) rebuildActive(t)
    else advanceActive(t)
    lastQueryT = t
  }

  // sign of ratioTo-ratioFrom — which way ratio increases as the train moves
  // forward along this leg's part (see _loc.dir doc above). Ties (a
  // degenerate zero-length ratio span) default to +1; never 0, so layoutCars
  // always has a well-defined "behind the head" direction to walk.
  function legDir(leg) {
    return leg.ratioTo >= leg.ratioFrom ? 1 : -1
  }

  // find a train's current [partIdx, ratio, dir] at `elapsedSec` (seconds
  // since its own first departure) — dwelling at a station or moving along a
  // leg. Writes into the shared _loc scratch; returns false if elapsedSec is
  // outside the journey or falls in an unresolved (no common part) leg.
  function locateTrain(train, elapsedSec) {
    const stops = train.stops
    const legs = train.legs
    const lastArr = stops[stops.length - 1].arr_sec
    if (elapsedSec < stops[0].dep_sec || elapsedSec > lastArr) return false
    for (let i = 0; i < legs.length; i++) {
      const a = stops[i]
      const b = stops[i + 1]
      // dwelling at station i itself (arr <= t < dep; empty window for i=0)
      if (elapsedSec >= a.arr_sec && elapsedSec < a.dep_sec) {
        const prev = i > 0 ? legs[i - 1] : null
        if (prev && prev.partIdx >= 0) {
          _loc.partIdx = prev.partIdx
          _loc.ratio = prev.ratioTo
          _loc.dir = legDir(prev)
          return true
        }
        const next = legs[i]
        if (next.partIdx >= 0) {
          _loc.partIdx = next.partIdx
          _loc.ratio = next.ratioFrom
          _loc.dir = legDir(next)
          return true
        }
        return false
      }
      // travelling leg i (dep of a -> arr of b)
      if (elapsedSec >= a.dep_sec && elapsedSec <= b.arr_sec) {
        const leg = legs[i]
        if (leg.partIdx < 0) return false
        const span = b.arr_sec - a.dep_sec
        const frac = span > 0 ? (elapsedSec - a.dep_sec) / span : 0
        _loc.partIdx = leg.partIdx
        _loc.ratio = leg.ratioFrom + (leg.ratioTo - leg.ratioFrom) * frac
        _loc.dir = legDir(leg)
        return true
      }
    }
    // exactly at final arrival
    const lastLeg = legs[legs.length - 1]
    if (lastLeg && lastLeg.partIdx >= 0) {
      _loc.partIdx = lastLeg.partIdx
      _loc.ratio = lastLeg.ratioTo
      _loc.dir = legDir(lastLeg)
      return true
    }
    return false
  }

  // camDist (world units, raw camera-target distance — NOT fogScale, see
  // CAR_LOD_ENTER_DIST's doc) crossing the hysteresis band flips carMode.
  // ENTER < EXIT: dolly in past ENTER to switch to car chains, dolly back out
  // past the (farther) EXIT before reverting to dots — the gap between them
  // is what stops a dolly sitting near the boundary from flapping every frame.
  function updateCarMode(camDist) {
    if (camDist == null) return
    if (carMode && camDist > CAR_LOD_EXIT_DIST) carMode = false
    else if (!carMode && camDist < CAR_LOD_ENTER_DIST) carMode = true
  }

  // per-frame: place every currently-active train's instance matrix, in
  // whichever of the two InstancedMeshes carMode currently selects (the
  // other one's count is forced to 0 so it draws nothing — see module header).
  function layout() {
    if (!hf || !parts) return 0
    const proj = hf.projection
    const exaggeration = params.demExaggeration
    lastHits.length = 0
    hitByTrainNo.clear()
    locByTrainNo.clear()
    return carMode ? layoutCars(proj, exaggeration) : layoutDots(proj, exaggeration)
  }

  function layoutDots(proj, exaggeration) {
    const r = DOT_R * fogScale * (params[sizeKey] ?? 1)
    let count = 0
    for (let i = 0; i < active.length && count < maxInstances; i++) {
      const tr = active[i]
      const elapsed = elapsedFor(tr, lastQueryT)
      if (!locateTrain(tr, elapsed)) continue
      const part = parts[_loc.partIdx]
      if (!part) continue
      sampleAlongPart(part, _loc.ratio, _sample)
      const w = proj.lonLatToWorld(_sample.lon, _sample.lat)
      const y = metersToWorldY(hf, _sample.elev, exaggeration) + lift
      hitByTrainNo.set(tr.trainNo, { x: w.x, y, z: w.z })
      locByTrainNo.set(tr.trainNo, { partIdx: _loc.partIdx, ratio: _loc.ratio, dir: _loc.dir })
      // ride view (src/engine/ride.js): the followed train's own dot would
      // otherwise render right at the camera — skip the instance write, keep
      // the position bookkeeping above (see layoutCars for the same pattern)
      if (tr.trainNo === hiddenTrainNo) continue
      _dummy.makeScale(r, r, r)
      _dummy.setPosition(w.x, y, w.z)
      dotMesh.setMatrixAt(count, _dummy)
      lastHits.push({ train: tr, elapsed, x: w.x, y, z: w.z })
      count++
    }
    dotMesh.count = count
    if (count > 0) {
      dotMesh.instanceMatrix.needsUpdate = true
      dotMesh.computeBoundingSphere()
    }
    carMesh.count = 0
    return count
  }

  // near-view LOD: every active train becomes a chain of carCount instanced
  // boxes (see module header for the placement algorithm). Two passes per
  // train: (1) walk the part's arc-length table to get every car's real
  // world-space center (headRatio offset backward by i·carLenM, converted to
  // this part's own ratio units via carLenM/part.lengthM — the same real
  // arc-length metric buildPartGeometry used to bake the table, so the chain
  // never drifts off-track regardless of how sharply the part curves); (2)
  // derive each car's yaw from the vector between its neighbors' ALREADY-
  // COMPUTED centers (tail->head), not a fresh tangent sample — the chain is
  // already the curve, sampling it again would be redundant work for the
  // same answer. Budget-capped by instances (maxCarInstances = maxInstances
  // × carCount), never by a per-train camera-distance check: the LOD
  // decision is global (one dolly-distance switch for the whole layer, see
  // updateCarMode), not per-train — matches how layoutDots has always
  // rendered every active train regardless of where it sits on-screen.
  function layoutCars(proj, exaggeration) {
    const sizeMult = params[sizeKey] ?? 1
    const lengthWorld = carLenM * proj.K // true arc length — never scaled by size, see config doc
    const widthWorld = widthM * proj.K * sizeMult
    const heightWorld = heightM * proj.K * exaggeration * sizeMult
    let trainCount = 0
    let instCount = 0
    for (let i = 0; i < active.length; i++) {
      if (instCount + carCount > maxCarInstances) break
      const tr = active[i]
      const elapsed = elapsedFor(tr, lastQueryT)
      if (!locateTrain(tr, elapsed)) continue
      const part = parts[_loc.partIdx]
      if (!part) continue
      const headRatio = _loc.ratio
      const dir = _loc.dir
      const deltaRatio = part.lengthM > 0 ? carLenM / part.lengthM : 0

      // pass 1: every car's world-space center (front car i=0 .. tail i=carCount-1)
      for (let c = 0; c < carCount; c++) {
        const ratioC = THREE.MathUtils.clamp(headRatio - dir * c * deltaRatio, 0, 1)
        sampleAlongPart(part, ratioC, _sample)
        const w = proj.lonLatToWorld(_sample.lon, _sample.lat)
        _carPos[c * 3] = w.x
        _carPos[c * 3 + 1] = metersToWorldY(hf, _sample.elev, exaggeration) + lift + heightWorld / 2
        _carPos[c * 3 + 2] = w.z
      }

      // pass 2: orient + emit — yaw from the tail->head vector between
      // neighboring already-computed centers (see function doc)
      let yaw = 0
      for (let c = 0; c < carCount; c++) {
        const bx = _carPos[c * 3]
        const by = _carPos[c * 3 + 1]
        const bz = _carPos[c * 3 + 2]
        if (c === 0) {
          // head car = "the train's position" (also the ride-view lookahead baseline)
          hitByTrainNo.set(tr.trainNo, { x: bx, y: by, z: bz })
          locByTrainNo.set(tr.trainNo, { partIdx: _loc.partIdx, ratio: _loc.ratio, dir: _loc.dir })
        }
        // ride view (src/engine/ride.js): the followed train's own car chain
        // would otherwise render right where/under the camera sits — skip
        // this train's instance writes while it's the ride-hidden entity,
        // but keep the bookkeeping above (ride still needs a live position)
        if (tr.trainNo === hiddenTrainNo) continue
        let dx
        let dz
        if (c < carCount - 1) {
          dx = bx - _carPos[(c + 1) * 3]
          dz = bz - _carPos[(c + 1) * 3 + 2]
        } else if (c > 0) {
          dx = _carPos[(c - 1) * 3] - bx
          dz = _carPos[(c - 1) * 3 + 2] - bz
        } else {
          dx = 0
          dz = 1 // single-car degenerate fallback (carCount === 1)
        }
        if (dx !== 0 || dz !== 0) yaw = Math.atan2(dx, dz) // else: reuse previous car's yaw (adjacent samples clamped to the same point)
        _dummy.makeRotationY(yaw)
        _dummy.scale(_carScale.set(widthWorld, heightWorld, lengthWorld))
        _dummy.setPosition(bx, by, bz)
        carMesh.setMatrixAt(instCount, _dummy)
        lastHits.push({ train: tr, elapsed, x: bx, y: by, z: bz })
        instCount++
      }
      trainCount++
    }
    carMesh.count = instCount
    if (instCount > 0) {
      carMesh.instanceMatrix.needsUpdate = true
      carMesh.computeBoundingSphere()
    }
    dotMesh.count = 0
    return trainCount
  }

  function applyStyle() {
    material.color.set(params[colorKey])
    material.opacity = params[opacityKey] ?? 0.95
    carMaterial.color.set(params[colorKey])
    carMaterial.opacity = params[opacityKey] ?? 0.95
  }

  return {
    id,
    kind: 'point',
    label,
    rowLabel,
    object3d: group,
    visibleParam: visibleKey,
    paramMap: { visible: visibleKey, color: colorKey, size: sizeKey, opacity: opacityKey },

    build() {},

    update(ctx) {
      hf = ctx.heightField
      const show = gate()
      if (show) applyStyle()
      group.visible = show
    },

    // per-frame: advance the sweep-line active set against the timeline
    // clock (timeStore.getDaySeconds()) and re-place every in-service train.
    // The engine keeps the render loop non-idle while this layer is visible
    // AND the timeline is playing (see index.js isAnimating).
    tickView(ctx) {
      fogScale = ctx.fogScale
      lift = zFightLift(LIFT_BASE, ctx.fogScale)
      if (!gate()) return
      updateCarMode(ctx.camDist)
      const t = currentDaySeconds()
      updateActiveSet(t)
      lastActiveCount = layout()
    },

    setStyle(patch) {
      for (const k in patch) if (KEY_TO_PARAM[k]) params[KEY_TO_PARAM[k]] = patch[k]
      applyStyle()
    },

    // follow camera (src/engine/follow.js, docs/FOLLOW_CAMERA_DESIGN.md §2):
    // entityId = train_no, stable across rebuilds (unlike an instance index).
    // group.visible check FIRST — a hidden layer must read as "entity gone"
    // (null) even though hitByTrainNo may still hold last-active-frame data,
    // otherwise follow would keep carrying a camera on a layer nobody can see.
    getEntityPosition(trainNo) {
      if (!group.visible) return null
      return hitByTrainNo.get(trainNo) ?? null
    },

    // ride view (src/engine/ride.js, docs/FOLLOW_CAMERA_DESIGN.md §Ride
    // view): forward-looking sample along the SAME part/direction locateTrain
    // resolved for this train THIS frame (locByTrainNo, kept fresh by
    // layout() above) — walking the real arc-length table is what lets the
    // ride camera track the actual curve instead of guessing a straight line.
    // aheadMeters is real-world meters (same unit carLenM/part.lengthM
    // already use elsewhere in this module). Known limitation: clamps to
    // [0,1] on the CURRENT part only — the same simplification layoutCars'
    // own car-chain tail offset already makes (see module header) — so near a
    // part boundary (a rail_lines.json segment join) the look-ahead point
    // freezes at that part's end vertex instead of continuing onto the next
    // part, until the train itself crosses over and locByTrainNo updates.
    getEntityLookahead(trainNo, aheadMeters) {
      if (!group.visible || !hf) return null
      const loc = locByTrainNo.get(trainNo)
      if (!loc || !parts) return null
      const part = parts[loc.partIdx]
      if (!part || !part.lengthM) return null
      const ratioAhead = THREE.MathUtils.clamp(loc.ratio + loc.dir * (aheadMeters / part.lengthM), 0, 1)
      sampleAlongPart(part, ratioAhead, _sampleAhead)
      const w = hf.projection.lonLatToWorld(_sampleAhead.lon, _sampleAhead.lat)
      return { x: w.x, y: metersToWorldY(hf, _sampleAhead.elev, params.demExaggeration) + lift, z: w.z }
    },

    // ride view debug hook only (window.__exp.rideState, see index.js's debug
    // block) — current arc-length fraction (0..1) along whichever part the
    // train is on right now. Not consumed by ride.js's own logic.
    getEntityRatio(trainNo) {
      return locByTrainNo.get(trainNo)?.ratio ?? null
    },

    // ride view: hide/show this train's own rendered instance(s) — see
    // layoutDots/layoutCars' hiddenTrainNo checks. Guards against a stale
    // unhide clobbering a DIFFERENT train that got hidden after this call was
    // queued (shouldn't happen — ride.js only ever hides one entity at a
    // time — but cheap to make safe).
    setEntityHidden(trainNo, hidden) {
      if (hidden) hiddenTrainNo = trainNo
      else if (hiddenTrainNo === trainNo) hiddenTrainNo = null
    },

    // click-to-inspect (see index.js pointerup handler / layers.pickAll).
    // Same proximity-pick approach as markers.js's pick(): the dots are only
    // a few px on screen (DOT_R), too small for a real raycast, so this
    // projects every currently-drawn train's world position (lastHits, kept
    // fresh by layout() above) with the raycaster's own camera and compares
    // to the click's screen pixel. The card's content is a snapshot of
    // whichever train was nearest at click time — it does not keep tracking
    // the moving train afterward (that's the future camera-follow feature,
    // see docs/HANDOFF.md backlog #2), and if the timeline is later scrubbed
    // past that train's service window the already-open card just keeps its
    // existing content (index.js only recomputes on the next click).
    pick(raycaster) {
      if (!group.visible || lastHits.length === 0) return null
      const camera = raycaster.camera
      const clickPx = raycaster.pickPx
      if (!camera || !clickPx) return null
      const w = window.innerWidth
      const h = window.innerHeight
      let best = null
      for (const hit of lastHits) {
        _pickWorld.set(hit.x, hit.y, hit.z)
        _pickProj.copy(_pickWorld).project(camera)
        if (_pickProj.z < -1 || _pickProj.z > 1) continue // behind camera / clipped
        const sx = (_pickProj.x * 0.5 + 0.5) * w
        const sy = (-_pickProj.y * 0.5 + 0.5) * h
        const d = Math.hypot(sx - clickPx.x, sy - clickPx.y)
        if (d < PICK_PX && (!best || d < best.d)) best = { d, hit }
      }
      if (!best) return null
      const { train, elapsed, x, y, z } = best.hit
      const { prevIdx, nextIdx } = sectionAt(train.stops, elapsed)
      const sectionStr =
        prevIdx === nextIdx ? train.stops[prevIdx].station : `${train.stops[prevIdx].station} → ${train.stops[nextIdx].station}`
      const nextEtaSec = train.firstDep + train.stops[nextIdx].arr_sec
      const sameAsNetLabel = train.trainType === netLabel
      const title = sameAsNetLabel ? `${netLabel} ${train.trainNo}` : `${netLabel} ${train.trainNo} ${train.trainType || ''}`.trim()
      return {
        title,
        rows: [
          ['車次 No.', train.trainNo],
          ['車種 Type', train.trainType || '—'],
          ['方向 Direction', train.direction || '—'],
          ['目前區間 Section', sectionStr],
          ['下一站到達 Next ETA', fmtHHMM(nextEtaSec)],
          ['發車時刻 Departure', fmtHHMM(train.firstDep)],
        ],
        worldPos: new THREE.Vector3(x, y, z),
        // follow camera opt-in (src/engine/follow.js) — entityId = train_no,
        // resolved back to a live position each frame via getEntityPosition above
        followable: { layerId: id, entityId: train.trainNo },
      }
    },

    // (re)supply real data once <net>_tracks.json + <net>_schedule.json +
    // rail_lines.json (this network's railNetwork filter) have all landed —
    // see index.js loadTrainsData/loadThsrData. Resolves every leg→part
    // ratio ONCE here, never in tick.
    setData({ tracks, schedules, lines }) {
      if (tracks.parts.length !== lines.length) {
        console.warn(`[${id}] part count mismatch: tracks.json parts=${tracks.parts.length} rail_lines(${railNetwork})=${lines.length}`)
      }
      parts = lines.map((pts) => buildPartGeometry(pts))

      // stationName -> Map(partIdx -> ratio), mirrors bake_trains.py's station_parts
      const stationParts = new Map()
      tracks.parts.forEach((part, i) => {
        for (const st of part.stations) {
          let m = stationParts.get(st.station)
          if (!m) {
            m = new Map()
            stationParts.set(st.station, m)
          }
          m.set(i, st.ratio)
        }
      })

      const built = []
      for (const sch of schedules) {
        const stops = sch.stops
        if (!stops || stops.length < 2) continue
        // singleCorridor (THSR): resolve the WHOLE train's part once (see
        // resolveCorridorPart's docstring for why per-leg lowest-common-part
        // doesn't work here); every leg below then reuses it.
        const corridorPartIdx = singleCorridor ? resolveCorridorPart(stops, stationParts) : -1
        const legs = new Array(stops.length - 1)
        for (let i = 0; i < stops.length - 1; i++) {
          const a = stops[i]
          const b = stops[i + 1]
          const ma = stationParts.get(a.station)
          const mb = stationParts.get(b.station)
          let partIdx = -1
          if (singleCorridor) {
            partIdx = corridorPartIdx
          } else if (ma && mb) {
            // lowest common part index — mirrors bake_trains.py's sorted(common)[0]
            for (const k of ma.keys()) {
              if (mb.has(k) && (partIdx === -1 || k < partIdx)) partIdx = k
            }
          }
          legs[i] = {
            partIdx,
            ratioFrom: partIdx >= 0 && ma ? ma.get(partIdx) : 0,
            ratioTo: partIdx >= 0 && mb ? mb.get(partIdx) : 0,
          }
        }
        built.push({
          trainNo: sch.train_no,
          trainType: sch.train_type,
          direction: sch.direction, // pick()'s "方向 Direction" row (already "A→B" formatted by bake_trains.py)
          firstDep: sch.dep_sec_of_day,
          lastArr: stops[stops.length - 1].arr_sec,
          stops,
          legs,
        })
      }
      built.sort((a, b) => a.firstDep - b.firstDep)
      trainsByStart = built
      active = []
      startPtr = 0
      lastQueryT = null
      lastActiveCount = 0
      lastHits = []
      hiddenTrainNo = null // a new schedule invalidates any stale ride-hide flag
      dataReady = trainsByStart.length > 0
    },

    describe() {
      return {
        id,
        kind: 'point',
        label,
        rowLabel,
        count: lastActiveCount,
        visible: params[visibleKey],
        styleSchema: TRAIN_STYLE,
        style: {
          color: params[colorKey],
          size: params[sizeKey] ?? 1,
          opacity: params[opacityKey] ?? 0.95,
        },
      }
    },

    dispose() {
      geo.dispose()
      material.dispose()
      carGeo.dispose()
      carMaterial.dispose()
    },
  }
}
