import * as THREE from 'three'
import { metersToWorldY, zFightLift } from './geo.js'
import * as timeStore from '../state/timeStore.js'

// Trains: real TRA (台鐵) timetable (992 trains, scripts/bake_trains.py) —
// InstancedMesh light dots gliding along rail_lines.json's tra polylines,
// driven by the timeline's time store (src/state/timeStore.js, see
// docs/TIMELINE_DESIGN.md) instead of the live wall clock — play/pause/seek/
// speed all flow through timeStore.getDaySeconds(). Manifest-driven deferred
// layer, same fail-quiet pattern as rail/trails (see index.js
// loadTrainsData): registers empty at startup, fed real data via setData()
// once train_tracks.json + train_schedule.json + rail_lines.json have all
// landed (first switch-on).
//
// Data contract (baked by scripts/bake_trains.py — see its header comment):
//   train_tracks.json  parts[]     index-aligned 1:1 with rail_lines.json's
//                                  system=='tra' filter (same order, 37
//                                  entries). Each part carries its
//                                  station→ratio table (ratio = EPSG:3826 arc-
//                                  length fraction 0..1 along THAT part's own
//                                  polyline — see distance_metric in its meta).
//   train_schedule.json schedules[] one real train per entry: stops[] with
//                                  arr_sec/dep_sec relative to the train's own
//                                  first departure, + dep_sec_of_day (Asia/
//                                  Taipei wall-clock seconds-since-midnight
//                                  anchoring that first departure — added by
//                                  this repo's bake script; not present in
//                                  pulse's upstream master_schedule.json).
//
// Placement pipeline (mirrors bake_trains.py's own leg_progress_at(), which
// doubles as the reference algorithm — see its docstring):
//   1. build(): once, per rail_lines.json tra part — reproject every vertex
//      to EPSG:3826 (same metric the bake script used for its station ratios)
//      and accumulate arc length, so ratio 0..1 can be converted back to a
//      lon/lat/elev point by walking the SAME metric. Naive lon/lat Euclidean
//      distance would NOT reproduce the baked ratios (1° lon != 1° lat in
//      meters, and both vary with latitude) — the train would run crooked and
//      at uneven speed along curves.
//   2. build(): once, per train — resolve each adjacent-stop leg to the
//      lowest-index part both stations share (mirrors the bake script's
//      `sorted(common)[0]`) and cache ratio_from/ratio_to. A leg with no
//      common part (~1.3% of legs, see train_schedule.json meta.leg_coverage)
//      is left unresolved: the train simply isn't rendered for that leg's
//      time window rather than guessing a wrong position.
//   3. tickView(): every frame — find which trains are currently in service
//      (sweep-line index, not a 992-train scan), locate each one's current
//      leg/ratio, sample the part's arc-length table, project to world space.

const MAX_INSTANCES = 320 // ~3x the observed weekday concurrent peak, margin for safety
const DOT_R = 0.11 // world units at fogScale 1
const LIFT_BASE = 0.08 // sits above the rail line's own 0.05 lift (polyline.js createRailLayer)
const REBUILD_ON_BACKWARD_JUMP = true

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

export function createTrainsLayer(params) {
  const group = new THREE.Group()
  group.visible = false

  const geo = new THREE.IcosahedronGeometry(1, 1)
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(params.trainsColor),
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    fog: true,
  })
  const mesh = new THREE.InstancedMesh(geo, material, MAX_INSTANCES)
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

  function gate() {
    return params.source === 'real' && !!hf && params.trainsVisible && dataReady
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
    const r = DOT_R * fogScale
    let count = 0
    for (let i = 0; i < active.length && count < MAX_INSTANCES; i++) {
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
    material.color.set(params.trainsColor)
  }

  return {
    id: 'trains',
    kind: 'point',
    label: 'Trains',
    rowLabel: '台鐵列車 Trains',
    object3d: group,
    visibleParam: 'trainsVisible',
    paramMap: { visible: 'trainsVisible', color: 'trainsColor' },

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
      if (patch.color !== undefined) params.trainsColor = patch.color
      applyStyle()
    },

    // (re)supply real data once train_tracks.json + train_schedule.json +
    // rail_lines.json (tra-filtered) have all landed — see index.js
    // loadTrainsData. Resolves every leg→part ratio ONCE here, never in tick.
    setData({ tracks, schedules, traLines }) {
      if (tracks.parts.length !== traLines.length) {
        console.warn(`[trains] part count mismatch: train_tracks.json=${tracks.parts.length} rail_lines(tra)=${traLines.length}`)
      }
      parts = traLines.map((pts) => buildPartGeometry(pts))

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
        const legs = new Array(stops.length - 1)
        for (let i = 0; i < stops.length - 1; i++) {
          const a = stops[i]
          const b = stops[i + 1]
          const ma = stationParts.get(a.station)
          const mb = stationParts.get(b.station)
          let partIdx = -1
          if (ma && mb) {
            // lowest common part index — mirrors bake_trains.py's sorted(common)[0]
            for (const k of ma.keys()) {
              if (mb.has(k) && (partIdx === -1 || k < partIdx)) partIdx = k
            }
          }
          legs[i] = {
            partIdx,
            ratioFrom: partIdx >= 0 ? ma.get(partIdx) : 0,
            ratioTo: partIdx >= 0 ? mb.get(partIdx) : 0,
          }
        }
        built.push({
          trainNo: sch.train_no,
          trainType: sch.train_type,
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
      dataReady = trainsByStart.length > 0
    },

    describe() {
      return {
        id: 'trains',
        kind: 'point',
        label: 'Trains',
        rowLabel: `台鐵列車 Trains（目前行駛中 ${lastActiveCount} 班）`,
        count: lastActiveCount,
        visible: params.trainsVisible,
        styleSchema: {
          color: { type: 'color', label: '光點顏色 Color' },
        },
        style: {
          color: params.trainsColor,
        },
      }
    },

    dispose() {
      geo.dispose()
      material.dispose()
    },
  }
}
