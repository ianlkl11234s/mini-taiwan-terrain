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

const DEFAULT_MAX_INSTANCES = 320 // TRA default: ~3x the observed weekday concurrent peak, margin for safety
const DOT_R = 0.11 // world units at fogScale 1
const LIFT_BASE = 0.08 // sits above the rail line's own 0.05 lift (polyline.js createRailLayer)
const REBUILD_ON_BACKWARD_JUMP = true
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
// per-line color the way rail does, see trains.js's material below).
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
  return { lon, lat, elev, ratio, n }
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
export function createTrainsLayer(params, config = {}) {
  const {
    id = 'trains',
    label = 'Trains',
    rowLabel = '台鐵列車 Trains',
    railNetwork = 'tra',
    maxInstances = DEFAULT_MAX_INSTANCES,
    singleCorridor = false,
    netLabel = '台鐵',
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
  const mesh = new THREE.InstancedMesh(geo, material, maxInstances)
  mesh.count = 0 // "先空後填": nothing drawn until real schedule data lands (see setData)
  mesh.renderOrder = 5
  group.add(mesh)

  let hf = null
  let fogScale = 1
  let lift = LIFT_BASE

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
  const _loc = { partIdx: -1, ratio: 0 }
  const _pickWorld = new THREE.Vector3()
  const _pickProj = new THREE.Vector3()

  // click-to-inspect candidates (pick() below), refreshed every layout() call
  // — one entry per instance actually drawn this pass, carrying the train ref
  // + elapsed (for the info card) alongside its rendered world position
  // (markers.js's proximity-pick pattern: dots are a few px on screen, too
  // small for a true raycast, so pick() projects these with the raycaster's
  // own camera and compares to the click's screen pixel).
  let lastHits = []

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

  // find a train's current [partIdx, ratio] at `elapsedSec` (seconds since
  // its own first departure) — dwelling at a station or moving along a leg.
  // Writes into the shared _loc scratch; returns false if elapsedSec is
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
          return true
        }
        const next = legs[i]
        if (next.partIdx >= 0) {
          _loc.partIdx = next.partIdx
          _loc.ratio = next.ratioFrom
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
        return true
      }
    }
    // exactly at final arrival
    const lastLeg = legs[legs.length - 1]
    if (lastLeg && lastLeg.partIdx >= 0) {
      _loc.partIdx = lastLeg.partIdx
      _loc.ratio = lastLeg.ratioTo
      return true
    }
    return false
  }

  // per-frame: place every currently-active train's instance matrix
  function layout() {
    if (!hf || !parts) return 0
    const proj = hf.projection
    const exaggeration = params.demExaggeration
    const r = DOT_R * fogScale * (params[sizeKey] ?? 1)
    let count = 0
    lastHits.length = 0
    for (let i = 0; i < active.length && count < maxInstances; i++) {
      const tr = active[i]
      const elapsed = elapsedFor(tr, lastQueryT)
      if (!locateTrain(tr, elapsed)) continue
      const part = parts[_loc.partIdx]
      if (!part) continue
      sampleAlongPart(part, _loc.ratio, _sample)
      const w = proj.lonLatToWorld(_sample.lon, _sample.lat)
      const y = metersToWorldY(hf, _sample.elev, exaggeration) + lift
      _dummy.makeScale(r, r, r)
      _dummy.setPosition(w.x, y, w.z)
      mesh.setMatrixAt(count, _dummy)
      lastHits.push({ train: tr, elapsed, x: w.x, y, z: w.z })
      count++
    }
    mesh.count = count
    if (count > 0) {
      mesh.instanceMatrix.needsUpdate = true
      mesh.computeBoundingSphere()
    }
    return count
  }

  function applyStyle() {
    material.color.set(params[colorKey])
    material.opacity = params[opacityKey] ?? 0.95
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
      const t = currentDaySeconds()
      updateActiveSet(t)
      lastActiveCount = layout()
    },

    setStyle(patch) {
      for (const k in patch) if (KEY_TO_PARAM[k]) params[KEY_TO_PARAM[k]] = patch[k]
      applyStyle()
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
    },
  }
}
