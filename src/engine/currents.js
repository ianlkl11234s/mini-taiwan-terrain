import * as THREE from 'three'
import { metersToWorldY, zFightLift, TAIWAN_BBOX } from './geo.js'

// Ocean Currents — CPU-advected particle streaklines over a baked CMEMS
// surface-current raster (R→u, G→v, alpha≥128=ocean), ported from
// mini-taiwan-pulse's climateParticleLineLayer.ts (see that file's step/
// respawn/ring-buffer/bilinear-sample logic — this module keeps the same
// algorithm shape but swaps pulse's WebGL-instanced-quad renderer for a
// single dynamic LineSegments geometry sized for a fixed particle count, and
// swaps mapbox mercator-space math for this engine's lon/lat degree-space
// advection formula (see step() below).
//
// Data contract (decoded once in setData(), never touched again):
//   PNG  R,G channels → u,v (m/s) via meta.u_min/u_max/v_min/v_max linear
//        decode; alpha channel ≥128 = ocean, <128 = land/no-data.
//   JSON meta: { width, height, u_min, u_max, v_min, v_max, bbox:
//        [lonMin, latMin, lonMax, latMax] } — raster covers a WIDE box
//        (90–180E / -15–55N); particles are constrained to the much
//        smaller TAIWAN_BBOX (geo.js) at spawn AND survival time, so the
//        field only ever shows currents in the terrain's own coverage.
//   Ocean mask is eroded by 1px (3×3 all-valid test) once at decode time —
//   sampleValid() below is then a single array lookup per particle per
//   frame instead of pulse's runtime 3×3 box scan — same "avoid near-shore
//   false current, cf. pulse's maskErodePx" effect, cheaper per-frame cost.
//
// Advection: N=2000 CPU-simulated particles (fixed — see N below), each
// carrying a 16-point ring-buffer trail (TRAIL) in lon/lat degrees. Every
// tickView(): step() advects one dt worth of flow per particle (bilinear
// u/v sample → degrees/step via the standard equirectangular meters-per-
// degree approximation), then buildGeometry() re-projects every trail
// point through the terrain's own projection.lonLatToWorld() and rewrites
// the ONE shared BufferGeometry's position+color attributes (setUsage
// DynamicDrawUsage, needsUpdate every frame — see module docs in geo.js /
// water.js for the shared drape convention this still honours: Y comes
// from metersToWorldY(hf, 0, exaggeration), i.e. sea level, recomputed
// fresh each frame like ships.js's seaY — no separate "on exaggeration
// change" hook needed).
//
// Tail fade: instead of alpha (which would need sorting against terrain/
// ships/sea-ripple, or a 4th vertex-color channel THREE's LineBasicMaterial
// doesn't expose per-vertex), the tail fades by multiplying its RGB toward
// black and relying on AdditiveBlending — adding (0,0,0) to the framebuffer
// is a no-op regardless of draw order, so there is no sorting problem and
// no depthWrite fight with the sea plane/ships. Layer opacity (styleSchema)
// is a plain material.opacity uniform on top. See docs/OCEAN_CURRENTS_DESIGN.md.

const N = 2000 // fixed particle count (not a style param — CPU advection cost scales with this)
const TRAIL = 16 // ring-buffer points per particle → TRAIL-1 = 15 segments/particle
const SEGMENTS_PER_PARTICLE = TRAIL - 1
const LIFESPAN_MIN = 6 // seconds
const LIFESPAN_MAX = 10 // seconds
const RESPAWN_TRIES = 64 // rejection-sampling attempts before falling back to an unchecked point (mirrors pulse's randomParticle)

// world-units lift above sea level: clears region.js's sea plane (0.06 base
// + 0.03 coastline = 0.09 combined lift) and ships.js's dot lift (0.05) so
// the current streaklines always draw on top of both without z-fighting.
const LIFT_BASE = 0.12

// meters-per-degree (equirectangular approx — same constants pulse uses)
const M_PER_DEG_LAT = 110540
const M_PER_DEG_LON_EQ = 111320

// flowScale: dt(real s) × flowScale × styleSchema.speed = "advection
// seconds" fed into u,v (m/s) → degrees. Pulse's own reference value
// (timeScaleSeconds=86_400, one flow-day per real second) is tuned for its
// continental/global mapbox view; this engine's view is a much closer
// zoomed-in Taiwan corridor (K anchor ~26.9km per 56 world units, see
// geo.js), so the same multiplier would sweep a particle across the whole
// visible coast in a fraction of a second. Tuned by eye in-browser (see
// docs/OCEAN_CURRENTS_DESIGN.md "flowScale tuning") so a 1–2 m/s Kuroshio
// current visibly advances along the east coast without looking manic —
// FINAL VALUE, do not restore pulse's 86_400 here. NOTE: the TRAIL (16
// points) is a fixed FRAME count, not a fixed time window, so its on-screen
// length is inversely proportional to fps (see rebuildGeometry) — this
// value is tuned for a ~60fps reference; at the test machine's uncapped
// ~120fps the streak is ~2x shorter, at a future 30fps throttle ~2x longer.
const FLOW_SCALE = 9000

// HDR boost: the scene's post-processing chain (scene.js) runs an
// ACES_FILMIC tonemap on a HalfFloat HDR buffer — plain 0..1 additive colors
// get compressed heavily (verified in-browser: even a full-bright 1,0,1
// debug color with depthTest/opacity maxed was barely a gray speck after the
// tonemap). Push the emitted color well over 1 so it still reads as a bright
// streak after compression — see docs/OCEAN_CURRENTS_DESIGN.md "HDR boost".
const HDR_BOOST = 10

// speed color ramp (climateRamps.ts OCEAN_CURRENTS_RAMP, ported verbatim) —
// deep blue (0 m/s) → bright blue → cyan → pale yellow → orange (OCEAN_SPEED_MAX).
const OCEAN_SPEED_MAX = 2.0
const RAMP_STOPS = [
  [0.0, new THREE.Color('#0c4a6e')],
  [0.3, new THREE.Color('#0ea5e9')],
  [0.6, new THREE.Color('#67e8f9')],
  [0.85, new THREE.Color('#fef3c7')],
  [1.0, new THREE.Color('#fb923c')],
]

const _rampOut = new THREE.Color()
function rampColor(t) {
  t = t < 0 ? 0 : t > 1 ? 1 : t
  for (let i = 1; i < RAMP_STOPS.length; i++) {
    const [t1, c1] = RAMP_STOPS[i]
    if (t <= t1) {
      const [t0, c0] = RAMP_STOPS[i - 1]
      const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0
      _rampOut.r = c0.r + (c1.r - c0.r) * f
      _rampOut.g = c0.g + (c1.g - c0.g) * f
      _rampOut.b = c0.b + (c1.b - c0.b) * f
      return _rampOut
    }
  }
  return RAMP_STOPS[RAMP_STOPS.length - 1][1]
}

const CURRENTS_STYLE = {
  opacity: { type: 'slider', label: '不透明度 Opacity', min: 0, max: 1, step: 0.02, format: (v) => v.toFixed(2) },
  speed: { type: 'slider', label: '流速倍率 Speed', min: 0.2, max: 3, step: 0.1, format: (v) => v.toFixed(1) },
}

// Decoded raster + eroded ocean mask — built once in setData(), read-only afterwards.
class CurrentsField {
  constructor(meta, imageData) {
    const { width, height } = meta
    this.width = width
    this.height = height
    this.lonMin = meta.bbox[0]
    this.latMin = meta.bbox[1]
    this.lonMax = meta.bbox[2]
    this.latMax = meta.bbox[3]
    this.lonSpan = this.lonMax - this.lonMin
    this.latSpan = this.latMax - this.latMin

    const n = width * height
    const u = new Float32Array(n)
    const v = new Float32Array(n)
    const rawValid = new Uint8Array(n)
    const { u_min, u_max, v_min, v_max } = meta
    const data = imageData.data // Uint8ClampedArray RGBA
    for (let i = 0; i < n; i++) {
      const r = data[i * 4]
      const g = data[i * 4 + 1]
      const a = data[i * 4 + 3]
      u[i] = u_min + (r / 255) * (u_max - u_min)
      v[i] = v_min + (g / 255) * (v_max - v_min)
      rawValid[i] = a >= 128 ? 1 : 0
    }
    this.u = u
    this.v = v
    // erode ocean mask by 1px (3×3 all-valid test) once — see module header
    const eroded = new Uint8Array(n)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let ok = 1
        for (let oy = -1; oy <= 1 && ok; oy++) {
          const yy = y + oy < 0 ? 0 : y + oy >= height ? height - 1 : y + oy
          for (let ox = -1; ox <= 1; ox++) {
            const xx = x + ox < 0 ? 0 : x + ox >= width ? width - 1 : x + ox
            if (!rawValid[yy * width + xx]) {
              ok = 0
              break
            }
          }
        }
        eroded[y * width + x] = ok
      }
    }
    this.validMask = eroded
  }

  // lon/lat degrees -> fractional pixel coords (float, for bilinear taps)
  _px(lon) {
    return ((lon - this.lonMin) / this.lonSpan) * (this.width - 1)
  }
  _py(lat) {
    return ((this.latMax - lat) / this.latSpan) * (this.height - 1)
  }

  // eroded-mask lookup at nearest pixel — cheap per-particle gate
  validAt(lon, lat) {
    const px = Math.round(this._px(lon))
    const py = Math.round(this._py(lat))
    if (px < 0 || px >= this.width || py < 0 || py >= this.height) return false
    return this.validMask[py * this.width + px] === 1
  }

  // bilinear u/v sample (raw arrays, not mask-gated — caller checks validAt first)
  sampleUV(lon, lat) {
    const fx = this._px(lon)
    const fy = this._py(lat)
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const x1 = Math.min(x0 + 1, this.width - 1)
    const y1 = Math.min(y0 + 1, this.height - 1)
    const tx = fx - x0
    const ty = fy - y0
    const w = this.width
    const i00 = y0 * w + x0
    const i10 = y0 * w + x1
    const i01 = y1 * w + x0
    const i11 = y1 * w + x1
    const u = (this.u[i00] * (1 - tx) + this.u[i10] * tx) * (1 - ty) + (this.u[i01] * (1 - tx) + this.u[i11] * tx) * ty
    const v = (this.v[i00] * (1 - tx) + this.v[i10] * tx) * (1 - ty) + (this.v[i01] * (1 - tx) + this.v[i11] * tx) * ty
    return { u, v }
  }

  randomOceanPoint() {
    for (let i = 0; i < RESPAWN_TRIES; i++) {
      const lon = TAIWAN_BBOX.minLon + Math.random() * (TAIWAN_BBOX.maxLon - TAIWAN_BBOX.minLon)
      const lat = TAIWAN_BBOX.minLat + Math.random() * (TAIWAN_BBOX.maxLat - TAIWAN_BBOX.minLat)
      if (this.validAt(lon, lat)) return { lon, lat }
    }
    // fallback: unchecked point — self-corrects next step() (invalid sample -> respawn again)
    return {
      lon: TAIWAN_BBOX.minLon + Math.random() * (TAIWAN_BBOX.maxLon - TAIWAN_BBOX.minLon),
      lat: TAIWAN_BBOX.minLat + Math.random() * (TAIWAN_BBOX.maxLat - TAIWAN_BBOX.minLat),
    }
  }
}

export function createCurrentsLayer(params) {
  const visibleKey = 'currentsVisible'
  const opacityKey = 'currentsOpacity'
  const speedKey = 'currentsSpeed'

  const group = new THREE.Group()
  group.visible = false

  let field = null // CurrentsField, set by setData()
  let mesh = null // THREE.LineSegments, built once field lands ("先空後填")
  let geometry = null
  let posAttr = null
  let colAttr = null

  // particle state (typed arrays, allocated once field lands)
  let historyLon = null
  let historyLat = null
  let ages = null
  let lifespans = null
  let speedT = null

  let hf = null
  let fogScale = 1
  let dataLoaded = false

  // per-particle projection scratch (reused every frame — avoids projecting
  // the same trail point twice: segment s's "to" point is segment s+1's
  // "from" point, so each of the TRAIL points is projected once, not twice)
  const _wx = new Float32Array(TRAIL)
  const _wz = new Float32Array(TRAIL)

  function gate() {
    return params.source === 'real' && !!hf && params[visibleKey] && dataLoaded
  }

  function resetParticle(i) {
    const p = field.randomOceanPoint()
    const base = i * TRAIL
    for (let s = 0; s < TRAIL; s++) {
      historyLon[base + s] = p.lon
      historyLat[base + s] = p.lat
    }
    lifespans[i] = LIFESPAN_MIN + Math.random() * (LIFESPAN_MAX - LIFESPAN_MIN)
    ages[i] = Math.random() * lifespans[i] // stagger initial ages so respawns don't wave in sync
    speedT[i] = 0
  }

  function buildParticles() {
    historyLon = new Float32Array(N * TRAIL)
    historyLat = new Float32Array(N * TRAIL)
    ages = new Float32Array(N)
    lifespans = new Float32Array(N)
    speedT = new Float32Array(N)
    for (let i = 0; i < N; i++) resetParticle(i)
  }

  function buildMesh() {
    const vertCount = N * SEGMENTS_PER_PARTICLE * 2
    geometry = new THREE.BufferGeometry()
    posAttr = new THREE.BufferAttribute(new Float32Array(vertCount * 3), 3)
    colAttr = new THREE.BufferAttribute(new Float32Array(vertCount * 3), 3)
    posAttr.setUsage(THREE.DynamicDrawUsage)
    colAttr.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('position', posAttr)
    geometry.setAttribute('color', colAttr)

    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: params[opacityKey] ?? 0.7,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      fog: false, // additive blend + scene fog would double-tint; storm/typhoon takes the same fog:false path
    })
    mesh = new THREE.LineSegments(geometry, material)
    mesh.frustumCulled = false
    mesh.renderOrder = 4 // above sea plane (region.js ~3) / ships (5 draws after, fine either order given additive+depthWrite:false)
    group.add(mesh)
  }

  // advect every particle by dt, respawning on expiry/land/out-of-bbox
  function step(dt) {
    const flowSecondsBase = dt * FLOW_SCALE * (params[speedKey] ?? 1)
    for (let i = 0; i < N; i++) {
      const base = i * TRAIL
      ages[i] += dt
      const x = historyLon[base]
      const y = historyLat[base]
      if (
        ages[i] > lifespans[i] ||
        x < TAIWAN_BBOX.minLon || x > TAIWAN_BBOX.maxLon || y < TAIWAN_BBOX.minLat || y > TAIWAN_BBOX.maxLat ||
        !field.validAt(x, y)
      ) {
        resetParticle(i)
        continue
      }
      const { u, v } = field.sampleUV(x, y)
      const speed = Math.hypot(u, v)
      speedT[i] = speed / OCEAN_SPEED_MAX
      const metersPerDegLon = Math.max(1000, M_PER_DEG_LON_EQ * Math.cos((y * Math.PI) / 180))
      const nx = x + (u * flowSecondsBase) / metersPerDegLon
      const ny = y + (v * flowSecondsBase) / M_PER_DEG_LAT
      if (
        nx < TAIWAN_BBOX.minLon || nx > TAIWAN_BBOX.maxLon || ny < TAIWAN_BBOX.minLat || ny > TAIWAN_BBOX.maxLat ||
        !field.validAt(nx, ny)
      ) {
        resetParticle(i)
        continue
      }
      // shift ring buffer (index 0 = newest) and prepend the new position
      for (let s = TRAIL - 1; s >= 1; s--) {
        historyLon[base + s] = historyLon[base + s - 1]
        historyLat[base + s] = historyLat[base + s - 1]
      }
      historyLon[base] = nx
      historyLat[base] = ny
    }
  }

  // rewrite the shared position/color buffers from current particle state
  function rebuildGeometry(currentsY) {
    const proj = hf.projection
    const pos = posAttr.array
    const col = colAttr.array
    let vi = 0 // vertex float index
    for (let i = 0; i < N; i++) {
      const base = i * TRAIL
      // project every trail point once (not once per adjacent segment — see _wx/_wz doc)
      for (let s = 0; s < TRAIL; s++) {
        const w = proj.lonLatToWorld(historyLon[base + s], historyLat[base + s])
        _wx[s] = w.x
        _wz[s] = w.z
      }
      const c = rampColor(speedT[i])
      for (let s = 0; s < SEGMENTS_PER_PARTICLE; s++) {
        // fade toward black with tail age; older segment (larger s) -> darker
        const fade = Math.pow(1 - s / SEGMENTS_PER_PARTICLE, 1.6) * HDR_BOOST
        // collapse (zero-length, invisible) if the segment's midpoint crosses land
        const midLon = (historyLon[base + s] + historyLon[base + s + 1]) * 0.5
        const midLat = (historyLat[base + s] + historyLat[base + s + 1]) * 0.5
        const valid = field.validAt(midLon, midLat)
        pos[vi] = _wx[s]
        pos[vi + 1] = currentsY
        pos[vi + 2] = _wz[s]
        pos[vi + 3] = valid ? _wx[s + 1] : _wx[s]
        pos[vi + 4] = currentsY
        pos[vi + 5] = valid ? _wz[s + 1] : _wz[s]
        col[vi] = c.r * fade
        col[vi + 1] = c.g * fade
        col[vi + 2] = c.b * fade
        col[vi + 3] = c.r * fade
        col[vi + 4] = c.g * fade
        col[vi + 5] = c.b * fade
        vi += 6
      }
    }
    posAttr.needsUpdate = true
    colAttr.needsUpdate = true
  }

  function applyStyle() {
    if (mesh) mesh.material.opacity = params[opacityKey] ?? 0.7
  }

  return {
    id: 'currents',
    kind: 'line',
    label: 'Ocean Currents',
    rowLabel: '海流 Ocean Currents',
    object3d: group,
    visibleParam: visibleKey,
    paramMap: { visible: visibleKey, opacity: opacityKey, speed: speedKey },

    build() {},

    update(ctx) {
      hf = ctx.heightField
      const show = gate()
      if (show) applyStyle()
      group.visible = show
    },

    // per-frame advection + geometry rewrite while visible (mirrors ships.js's
    // tickView->layout() pattern; gated so idle/hidden costs nothing)
    tickView(ctx) {
      fogScale = ctx.fogScale
      if (!gate()) return
      // ctx.dt already clamped to <=0.05s by index.js's clock cap — no extra clamp needed here
      step(ctx.dt)
      const currentsY = metersToWorldY(hf, 0, params.demExaggeration) + zFightLift(LIFT_BASE, fogScale)
      rebuildGeometry(currentsY)
    },

    setStyle(patch) {
      if ('opacity' in patch) params[opacityKey] = patch.opacity
      if ('speed' in patch) params[speedKey] = patch.speed
      applyStyle()
    },

    // decoded raster + meta -> build particle state + mesh once ("先空後填":
    // no geometry exists before this lands, so there's no empty-geometry-
    // frozen-at-0 trap to avoid — see markers.js's InstancedMesh version of
    // the same trap this sidesteps by construction)
    setData(meta, imageData) {
      field = new CurrentsField(meta, imageData)
      buildParticles()
      buildMesh()
      dataLoaded = true
    },

    describe() {
      return {
        id: 'currents',
        kind: 'line',
        label: 'Ocean Currents',
        rowLabel: '海流 Ocean Currents',
        count: N,
        visible: params[visibleKey],
        styleSchema: CURRENTS_STYLE,
        style: {
          opacity: params[opacityKey] ?? 0.7,
          speed: params[speedKey] ?? 1,
        },
        note: 'CMEMS © Copernicus Marine Service',
      }
    },

    dispose() {
      geometry?.dispose()
      mesh?.material.dispose()
    },
  }
}
