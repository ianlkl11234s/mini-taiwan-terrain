import * as THREE from 'three'
import { metersToWorldY, zFightLift } from './geo.js'
import * as timeStore from '../state/timeStore.js'

// Ships: AIS-tracked light dots gliding along real vessel trails, driven by
// the timeline's time store exactly like trains.js (src/state/timeStore.js,
// see docs/TIMELINE_DESIGN.md) — but unlike trains (a daily-repeating
// timetable keyed on seconds-since-midnight), a ship's trail is ONE calendar
// day's worth of real AIS pings keyed on absolute unix-epoch seconds, so
// tickView reads timeStore.getTime() directly (no Taipei day-seconds
// conversion) and interpolates between the two pings bracketing it — a ship
// outside its own trail's [first, last] window that day is simply not drawn.
//
// Data contract (see docs/MARINE_DESIGN.md §1.1):
//   CDN snapshot  {VITE_TILE_BASE}/ships/trails/{YYYY-MM-DD}.json
//                 { meta, trails: [{ mmsi, name?, ship_type,
//                   points: [[lat,lng,ts], ...] }] } — points already
//                 GPS-filtered by the bake script, ts ascending.
//   RPC fallback  get_ship_trails(target_date) — anon key, rows of
//                 { mmsi, ship_type, trail: "lat,lng,ts;lat,lng,ts;..." } —
//                 NOT pre-filtered (see parseTrailString/filterGpsAnomalies
//                 below, ported from mini-taiwan-pulse's shipLoader.ts).
// Both paths are normalized by index.js's loader into the same shape before
// calling setData() — see index.js's loadShipsForDate.
//
// Deferred/manifest-driven pattern (same fail-quiet convention as trains):
// registers empty at startup (mesh.count = 0, "先空後填" — the InstancedMesh
// itself is built once at full capacity so setData() never needs a new
// geometry, only a repopulated matrix buffer), fed real data via setData()
// once the current date's trails have landed — see index.js's shipsVisible
// HANDLER (loadShipsForDate + subscribeDate wiring, docs/MARINE_DESIGN.md §1.2).

const MAX_INSTANCES = 2048 // render cap (opus M4: NOT a memory cap — see module header of MARINE_DESIGN.md §1.3)
const DOT_R = 0.1 // world units at fogScale 1 — a touch smaller than trains' light dots
// sits above the sea-level ring (geo.js's zFightLift doc: "sea-level ring
// 0.03") so ship dots clear the region sea plane without fighting it
const LIFT_BASE = 0.05
const PICK_PX = 16 // click-to-inspect hit radius, CSS px (same rationale as trains.js's PICK_PX)
const RESORT_INTERVAL_MS = 1000 // opus M4: distance-to-camera resort throttled to 1/s, not per-frame
const MAX_SPEED_KNOTS = 40 // GPS anomaly filter threshold (ported from pulse's shipLoader.ts)
const EARTH_R_KM = 6371

const SHIP_STYLE = {
  color: { type: 'color', label: '光點顏色 Color' },
  size: { type: 'slider', label: '大小 Size', min: 0.5, max: 3.0, step: 0.05, format: (v) => v.toFixed(2) },
  opacity: { type: 'slider', label: '不透明度 Opacity', min: 0, max: 1, step: 0.02, format: (v) => v.toFixed(2) },
}

// great-circle distance (km) — used both by filterGpsAnomalies below and by
// pick()'s live knots readout, so the two agree with each other.
function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180
  const dLat = (lat2 - lat1) * toRad
  const dLon = (lon2 - lon1) * toRad
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2
  return EARTH_R_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function knotsBetween(lat1, lon1, ts1, lat2, lon2, ts2) {
  const dtHours = (ts2 - ts1) / 3600
  if (dtHours <= 0) return 0
  return haversineKm(lat1, lon1, lat2, lon2) / dtHours / 1.852
}

// "lat,lng,ts;lat,lng,ts;..." -> [[lat,lon,ts], ...] (RPC's `trail` column
// format — see get_ship_trails, mirrors pulse shipLoader.ts's parseTrail)
export function parseTrailString(trail) {
  if (!trail) return []
  return trail.split(';').map((s) => {
    const parts = s.split(',')
    return [+parts[0], +parts[1], +parts[2]]
  })
}

// drops any point whose implied speed from the previous KEPT point exceeds
// MAX_SPEED_KNOTS (GPS jump artifacts) — ported from pulse's shipLoader.ts
// filterGpsAnomalies, but using true haversine distance instead of its fixed
// km-per-degree approximation. Only the RPC fallback path needs this (CDN
// snapshots are pre-filtered by the bake script — see module header).
export function filterGpsAnomalies(points) {
  if (points.length < 2) return points
  const out = [points[0]]
  for (let i = 1; i < points.length; i++) {
    const prev = out[out.length - 1]
    const cur = points[i]
    if (knotsBetween(prev[0], prev[1], prev[2], cur[0], cur[1], cur[2]) > MAX_SPEED_KNOTS) continue
    out.push(cur)
  }
  return out
}

// one ship's trail as typed arrays (zero-allocation binary search target) —
// mirrors trains.js's buildPartGeometry, but keyed on ts (epoch seconds)
// instead of arc-length ratio.
function buildShipTrack(t) {
  const pts = t.points || []
  const n = pts.length
  const lat = new Float64Array(n)
  const lon = new Float64Array(n)
  const ts = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    lat[i] = pts[i][0]
    lon[i] = pts[i][1]
    ts[i] = pts[i][2]
  }
  return {
    mmsi: t.mmsi,
    name: t.name || null,
    shipType: t.shipType || null,
    lat,
    lon,
    ts,
    n,
    first: n > 0 ? ts[0] : Infinity,
    last: n > 0 ? ts[n - 1] : -Infinity,
  }
}

// find a ship's interpolated lat/lon at time t (unix seconds) via binary
// search + lerp on its own ts[] — same shape as trains.js's sampleAlongPart.
// Writes into the shared `out` scratch; returns false if t falls outside
// this ship's trail for the day (ship not in service / not yet reporting).
function locateShip(ship, t, out) {
  if (ship.n === 0 || t < ship.first || t > ship.last) return false
  if (ship.n === 1) {
    out.lat = ship.lat[0]
    out.lon = ship.lon[0]
    out.i0 = 0
    out.i1 = 0
    return true
  }
  let lo = 0
  let hi = ship.n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (ship.ts[mid] <= t) lo = mid
    else hi = mid
  }
  const span = ship.ts[hi] - ship.ts[lo]
  const frac = span > 0 ? (t - ship.ts[lo]) / span : 0
  out.lat = ship.lat[lo] + (ship.lat[hi] - ship.lat[lo]) * frac
  out.lon = ship.lon[lo] + (ship.lon[hi] - ship.lon[lo]) * frac
  out.i0 = lo
  out.i1 = hi
  return true
}

function fmtDataTime(ts) {
  return new Date(ts * 1000).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export function createShipsLayer(params) {
  const visibleKey = 'shipsVisible'
  const colorKey = 'shipsColor'
  const sizeKey = 'shipsSize'
  const opacityKey = 'shipsOpacity'
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
  const mesh = new THREE.InstancedMesh(geo, material, MAX_INSTANCES)
  mesh.count = 0 // "先空後填": nothing drawn until a day's trails land (see setData)
  mesh.renderOrder = 5
  group.add(mesh)

  let hf = null
  let fogScale = 1
  let lift = LIFT_BASE

  let ships = [] // Array<{mmsi,name,shipType,lat,lon,ts,n,first,last}>
  let hasLoaded = false // true once setData has landed at least once (even if that day is empty — see gate())

  let lastRenderCount = 0
  let selectedMmsi = null // Set<mmsi> from the last distance resort, or null (no cap in effect)
  let lastSortAt = -Infinity
  let warnedOverflow = false

  const _dummy = new THREE.Matrix4()
  const _loc = { lat: 0, lon: 0, i0: -1, i1: -1 }
  const _pickWorld = new THREE.Vector3()
  const _pickProj = new THREE.Vector3()
  const _candidates = [] // scratch, refilled every layout() call

  // click-to-inspect candidates (pick() below), refreshed every layout() —
  // same proximity-pick pattern as trains.js/markers.js: dots are a few px
  // on screen, too small for a real raycast.
  let lastHits = []

  function gate() {
    return params.source === 'real' && !!hf && params[visibleKey] && hasLoaded
  }

  function applyStyle() {
    material.color.set(params[colorKey])
    material.opacity = params[opacityKey] ?? 0.95
  }

  // per-frame: locate every ship currently within its own trail's time
  // window, cap to MAX_INSTANCES by camera distance (resorted at most once a
  // second — opus M4), and place instance matrices.
  function layout(camera) {
    if (!hf || ships.length === 0) return 0
    const proj = hf.projection
    const exaggeration = params.demExaggeration
    const seaY = metersToWorldY(hf, 0, exaggeration) + lift // ships float at sea level (elev=0), not sampled terrain/bathymetry
    const t = timeStore.getTime()
    const r = DOT_R * fogScale * (params[sizeKey] ?? 1)

    _candidates.length = 0
    for (const ship of ships) {
      if (!locateShip(ship, t, _loc)) continue
      const w = proj.lonLatToWorld(_loc.lon, _loc.lat)
      _candidates.push({ ship, x: w.x, y: seaY, z: w.z, i0: _loc.i0, i1: _loc.i1 })
    }

    let toRender = _candidates
    if (_candidates.length > MAX_INSTANCES) {
      if (!warnedOverflow) {
        console.warn(`[ships] ${_candidates.length} ships active exceeds render cap ${MAX_INSTANCES} — showing nearest to camera (resorted every ${RESORT_INTERVAL_MS}ms)`)
        warnedOverflow = true
      }
      const now = performance.now()
      if (selectedMmsi === null || now - lastSortAt >= RESORT_INTERVAL_MS) {
        const cx = camera?.position.x ?? 0
        const cy = camera?.position.y ?? 0
        const cz = camera?.position.z ?? 0
        _candidates.sort((a, b) => (a.x - cx) ** 2 + (a.y - cy) ** 2 + (a.z - cz) ** 2 - ((b.x - cx) ** 2 + (b.y - cy) ** 2 + (b.z - cz) ** 2))
        toRender = _candidates.slice(0, MAX_INSTANCES)
        selectedMmsi = new Set(toRender.map((c) => c.ship.mmsi))
        lastSortAt = now
      } else {
        toRender = _candidates.filter((c) => selectedMmsi.has(c.ship.mmsi)).slice(0, MAX_INSTANCES)
      }
    } else {
      selectedMmsi = null // below cap — next overflow (if any) resorts fresh
    }

    lastHits.length = 0
    let count = 0
    for (const c of toRender) {
      _dummy.makeScale(r, r, r)
      _dummy.setPosition(c.x, c.y, c.z)
      mesh.setMatrixAt(count, _dummy)
      lastHits.push(c)
      count++
    }
    mesh.count = count
    if (count > 0) {
      mesh.instanceMatrix.needsUpdate = true
      mesh.computeBoundingSphere()
    }
    return count
  }

  return {
    id: 'ships',
    kind: 'point',
    label: 'Ships',
    rowLabel: '船舶 Ships',
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

    tickView(ctx) {
      fogScale = ctx.fogScale
      lift = zFightLift(LIFT_BASE, ctx.fogScale)
      if (!gate()) return
      lastRenderCount = layout(ctx.camera)
    },

    setStyle(patch) {
      for (const k in patch) if (KEY_TO_PARAM[k]) params[KEY_TO_PARAM[k]] = patch[k]
      applyStyle()
    },

    // click-to-inspect: 船名（無名顯示 MMSI）、MMSI、船種、當下航速（相鄰 trail
    // 點導出 knots）、資料時刻 — see docs/MARINE_DESIGN.md §1.3.
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
        if (_pickProj.z < -1 || _pickProj.z > 1) continue
        const sx = (_pickProj.x * 0.5 + 0.5) * w
        const sy = (-_pickProj.y * 0.5 + 0.5) * h
        const d = Math.hypot(sx - clickPx.x, sy - clickPx.y)
        if (d < PICK_PX && (!best || d < best.d)) best = { d, hit }
      }
      if (!best) return null
      const { ship, i0, i1 } = best.hit
      const knots = i0 !== i1 ? knotsBetween(ship.lat[i0], ship.lon[i0], ship.ts[i0], ship.lat[i1], ship.lon[i1], ship.ts[i1]) : 0
      return {
        title: ship.name || `MMSI ${ship.mmsi}`,
        rows: [
          ['船名 Name', ship.name || '—'],
          ['MMSI', ship.mmsi],
          ['船種 Type', ship.shipType || '—'],
          ['航速 Speed', `${knots.toFixed(1)} kt`],
          ['資料時刻 Time', fmtDataTime(ship.ts[i0])],
        ],
        worldPos: new THREE.Vector3(best.hit.x, best.hit.y, best.hit.z),
      }
    },

    // (re)supply one day's trails — see index.js's loadShipsForDate (CDN
    // snapshot first, RPC fallback, both normalized to the same
    // {mmsi,name,shipType,points:[[lat,lon,ts],...]} shape before this call).
    // trails=[] is a legitimate "this day has no ship data" result, not a
    // failure — hasLoaded still flips true so the layer shows correctly-empty
    // instead of staying gated off (docs/MARINE_DESIGN.md §1.2).
    setData(trails) {
      ships = trails.map(buildShipTrack)
      hasLoaded = true
      lastRenderCount = 0
      lastHits = []
      selectedMmsi = null
      lastSortAt = -Infinity
      warnedOverflow = false
    },

    describe() {
      return {
        id: 'ships',
        kind: 'point',
        label: 'Ships',
        rowLabel: '船舶 Ships',
        count: lastRenderCount,
        visible: params[visibleKey],
        styleSchema: SHIP_STYLE,
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
