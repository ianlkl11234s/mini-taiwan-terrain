import * as THREE from 'three'
import { metersToWorldY, worldYScale } from './geo.js'
import { mulberry32, smoothstep, lerp } from './noise.js'
import { WIND_BY_WEATHER } from './rain.js'
import { TILE_PX } from './dem.js'

// Grass — Phase 3 work package B (docs/PHASE3_VISUAL_DESIGN.md §工作包 B).
// Chunked InstancedMesh of procedural blade tufts scattered on the real DEM,
// visible only in near-ground views (ctx.camGroundM < CAM_GROUND_LIMIT_M) —
// the layer is a no-op (no cells, mesh.count 0) at any overview/orbit
// distance, so it never touches on-demand render's idle freeze there.
//
// Streaming model: world XZ is divided into CELL_SIZE cells (deterministic
// mulberry32(seed^cellHash) point placement per cell — reproducible, no
// Math.random on the hot path). Cells within RADIUS_UNITS of the camera XZ
// get queued and generated at most MAX_CELLS_PER_FRAME/tick (never a hitch
// while streaming in); cells that fall outside the radius are dropped from
// the map (their points GC'd) and the next repack() drops them from the
// instance buffer. "先空後填" (see new-layer SKILL / CLAUDE.md): the
// InstancedMesh is built ONCE at full CAPACITY here (like ships.js), mesh.count
// starts at 0 and only ever grows/shrinks via repack() — never a deferred
// zero-capacity geometry.
//
// Wind: MeshStandardMaterial (NOT a hand-rolled ShaderMaterial like rain/
// typhoon) so the sun/hemi lights from environment.js light it automatically,
// zero extra plumbing. onBeforeCompile injects a wind-sway displacement at
// `#include <begin_vertex>` — see buildTuftGeometry's header for how a
// blade's own un-transformed `position.y` (0 base..1 tip) doubles as the tip
// weight with no extra attribute, and the onBeforeCompile block below for how
// the per-instance rotation is inverted so every blade leans the same WORLD
// wind direction regardless of its own random yaw.

const CELL_SIZE = 0.5 // world units (~240 m — see docs/PHASE3_VISUAL_DESIGN.md 工作包 B)
const RADIUS_UNITS = 1.5 // world units — cell-streaming radius around the camera XZ anchor
const R_CELLS = Math.ceil(RADIUS_UNITS / CELL_SIZE)
const CAPACITY = 40000 // InstancedMesh hard cap — built once, never resized (see module header)
const MAX_CELLS_PER_FRAME = 2 // generation budget — "每幀最多處理 1–2 個 cell（防 hitch）"
const CAM_GROUND_LIMIT_M = 1500 // ctx.camGroundM ≥ this ⇒ whole layer hidden + generation stops + isAnimating() false
const GRID_N = 30 // jittered candidate grid per cell (900 candidates before density/terrain filtering)
const MAX_POINTS_PER_CELL = 1200 // safety cap so one dense cell can't alone blow the CAPACITY budget
const MIN_ELEV_M = 0.5 // 佈點過濾: 海/灘不放
const MAX_ELEV_M = 3000 // 佈點過濾: 高山不放
const SLOPE_PROBE_M = 6 // meters — neighbour-sample offset for the slope estimate
const MAX_SLOPE_TAN = Math.tan(THREE.MathUtils.degToRad(35)) // 坡度 > 35° 不放
const LIFT_M = 0.05 // meters — tiny constant lift off the exact DEM sample so tuft bases never embed in the terrain skin (not a zFightLift: this is proud 3D geometry, not a coincident overlay)

// blade-tip sway amplitude multiplier by weather (docs/PHASE3_VISUAL_DESIGN.md
// 工作包 B: "晴 0.3 / 雨 0.7 / 颱風 1.6") — a SEPARATE table from rain.js's
// WIND_BY_WEATHER (imported below only for its DIRECTION vector, so grass
// leans the same way rain slants; that table's own magnitude is rain-streak
// tilt, not grass sway amplitude — reusing it for both would make "clear"
// weather grass perfectly still, contradicting the 0.3 baseline breeze here).
const GRASS_WIND_STRENGTH = { clear: 0.3, rain: 0.7, typhoon: 1.6 }

const GRASS_STYLE = {
  density: { type: 'slider', label: '密度 Density', min: 0, max: 1, step: 0.05, format: (v) => v.toFixed(2) },
  height: { type: 'slider', label: '高度 Height', min: 0.5, max: 5, step: 0.1, format: (v) => `${v.toFixed(1)}m` },
}

// low/high-elevation tint endpoints — low-saturation yellow-green so it
// doesn't fight the terrain's own hypsometric ramp (spec: "別跟地形 ramp 打架
// ——偏黃綠、飽和度低")
const LOW_COLOR = new THREE.Color().setHSL(100 / 360, 0.4, 0.3)
const HIGH_COLOR = new THREE.Color().setHSL(75 / 360, 0.28, 0.42)

// Is the DEM tile under (x,z) actually resident (fetched-and-resolved, land
// OR sea)? Copied verbatim from walk.js's tileResident (not exported there —
// see that module's header for the full rationale: heightAtWorld() reads
// exactly 0m for BOTH "tile missing" and "resolved as sea", so a cell whose
// tiles haven't streamed in yet must be retried, not cached as a
// permanently-empty patch of "sea"). A grass cell (240 m) is far smaller than
// one DEM tile (~8.9 km at z12), so checking just the cell CENTER's tile is
// sufficient — see generateCell's caller.
function tileResident(hf, x, z) {
  const { px, py } = hf.projection.worldToPixel(x, z)
  return hf.tiles.has(hf.key(Math.floor(px / TILE_PX), Math.floor(py / TILE_PX)))
}

function hashCell(cx, cz) {
  // 2D → 32-bit deterministic combine (large-prime multiply + xor) — stable
  // across runs, no Math.random, so a cell regenerated later (recycled then
  // re-entered) reproduces the exact same points.
  return (Math.imul(cx | 0, 374761393) ^ Math.imul(cz | 0, 668265263)) | 0
}

// One shared tuft = a few curved blades merged into ONE BufferGeometry,
// reused by every instance — only the per-instance transform (position/yaw/
// scale, see writeInstance) and instanceColor vary. Local space convention:
// X/Z in REAL METERS (an instance's scale.xz is K-only, no demExaggeration —
// "水平寬度用 hf.projection.K 換算（不吃 exaggeration）"), Y normalized
// 0 (base)..1 (tip) so a blade's own un-transformed `position.y` doubles as
// the wind shader's tip weight with no extra attribute (spec offers either
// "每頂點 0–1 權重 attribute 或用 uv.y" — this is the equivalent-but-simpler
// "use an existing per-vertex value" option).
const BLADE_HALF_W = 0.045 // meters, base half-width
const BLADE_CURVE = 0.22 // meters, static forward lean baked into the resting shape
const BLADE_DEFS = [
  // fixed (not randomized) fan-out within one tuft — this geometry is shared
  // by all 40,000 instances, so any "randomness" here would just repeat
  // identically every time; per-instance variety comes from the transform's
  // yaw/scale/color instead (see writeInstance below)
  { angle: 0.2, ox: 0.02, oz: 0.01 },
  { angle: 1.7, ox: -0.03, oz: 0.02 },
  { angle: 3.4, ox: 0.01, oz: -0.03 },
  { angle: 5.0, ox: -0.02, oz: -0.01 },
]

function buildTuftGeometry() {
  const positions = []
  const indices = []
  for (const { angle, ox, oz } of BLADE_DEFS) {
    const base = positions.length / 3
    const ca = Math.cos(angle)
    const sa = Math.sin(angle)
    const pt = (lx, ly, lz) => {
      positions.push(lx * ca - lz * sa + ox, ly, lx * sa + lz * ca + oz)
    }
    pt(-BLADE_HALF_W, 0, 0) // 0 base-left
    pt(BLADE_HALF_W, 0, 0) // 1 base-right
    pt(-BLADE_HALF_W * 0.45, 0.55, BLADE_CURVE * 0.4) // 2 mid-left
    pt(BLADE_HALF_W * 0.45, 0.55, BLADE_CURVE * 0.4) // 3 mid-right
    pt(0, 1.0, BLADE_CURVE) // 4 tip — 3 triangles/blade (spec: "每片 2–4 三角形")
    indices.push(base, base + 1, base + 3, base, base + 3, base + 2, base + 2, base + 3, base + 4)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setIndex(indices)
  geo.computeVertexNormals()
  return geo
}

export function createGrassLayer(params) {
  const group = new THREE.Group()
  group.visible = false

  const tuftGeo = buildTuftGeometry()
  const material = new THREE.MeshStandardMaterial({
    roughness: 0.88,
    metalness: 0,
    side: THREE.DoubleSide, // random per-instance yaw means any blade may face away from the camera
    envMapIntensity: params.envMapIntensity,
  })
  // three's automatic program-cache key already folds in instancing/
  // instancingColor/light-count parameters (WebGLPrograms.getProgramCacheKeyBooleans)
  // regardless of this override — it's ONLY appended (see WebGLRenderer.getProgramCacheKey),
  // never replaced — but it does NOT fingerprint onBeforeCompile's own GLSL
  // content (r172), so a distinct key still guards against a future material
  // silently sharing this compiled program (same rationale as region.js's
  // 'region-sea-ripple' key).
  material.customProgramCacheKey = () => 'grass-wind'
  const windUniforms = {
    uGrassTime: { value: 0 },
    uWindDir: { value: new THREE.Vector2(1, 0) },
    uWindStrength: { value: GRASS_WIND_STRENGTH.clear },
  }
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, windUniforms)
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uGrassTime;
uniform vec2 uWindDir;
uniform float uWindStrength;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  // tip weight: position.y is the RAW (un-transformed) blade attribute, 0 at
  // the base .. 1 at the tip by construction (buildTuftGeometry) — squared so
  // the base stays rigid and sway eases in toward the tip.
  float tipWeight = clamp(position.y, 0.0, 1.0);
  float ease = tipWeight * tipWeight;
  // instanceMatrix's rotation inverted (transpose ≈ inverse for a
  // rotation-only 3x3) turns the WORLD-space wind direction into this
  // instance's own local frame, so every blade leans the SAME world
  // direction despite each tuft's random yaw (see writeInstance).
  vec3 worldWind = vec3(uWindDir.x, 0.0, uWindDir.y);
  vec3 localWind = transpose(mat3(instanceMatrix)) * worldWind;
  float phase = instanceMatrix[3].x * 0.6 + instanceMatrix[3].z * 1.1;
  float sway = sin(uGrassTime * 1.7 + phase) * 0.7 + sin(uGrassTime * 3.4 + phase * 1.9) * 0.3;
  transformed.xz += localWind.xz * ease * uWindStrength * sway * 0.4;
}`
      )
  }

  // "先空後填": full capacity from the start (never resized — see module
  // header), count explicitly zeroed so nothing draws until a cell actually
  // finishes generating (InstancedMesh's own constructor default is
  // count = capacity, which WOULD draw 40,000 garbage-transformed instances
  // for one frame if left untouched).
  const mesh = new THREE.InstancedMesh(tuftGeo, material, CAPACITY)
  mesh.count = 0
  // range just streams with the camera — culling saves nothing (it's always
  // roughly camera-centered) and per-frame boundingSphere recompute over up
  // to 40k instances would cost more than the culling it enables, so this
  // intentionally skips computeBoundingSphere() entirely (see repack below).
  mesh.frustumCulled = false
  group.add(mesh)

  let hf = null
  const cells = new Map() // "cx,cz" -> { cx, cz, dist, state: 'pending'|'ready', points: [] }
  const pendingQueue = [] // cell keys awaiting generateCell (may contain stale keys — see processPending)
  let flatPoints = [] // concatenation of every 'ready' cell's points, in repack() order — instance index i reads flatPoints[i]
  let dirty = false // a cell was added/removed/(re)generated since the last repack()
  let windTime = 0
  let warnedOverflow = false
  let lastGenMs = 0 // debug/verify: most recent generateCell() wall time

  function applyGate(ctx) {
    hf = ctx.heightField
    const real = ctx.params.source === 'real' && !!hf
    const show = real && ctx.params.grassVisible && ctx.camGroundM < CAM_GROUND_LIMIT_M
    group.visible = show
    return show
  }

  function applyWeatherWind(weather) {
    const [wx, wy] = WIND_BY_WEATHER[weather] ?? WIND_BY_WEATHER.clear
    const mag = Math.hypot(wx, wy)
    if (mag > 1e-4) windUniforms.uWindDir.value.set(wx / mag, wy / mag)
    // rain.js's own tilt vector is (0,0) for 'clear' — grass still sways
    // gently at GRASS_WIND_STRENGTH.clear, so fall back to a fixed breeze
    // direction rather than collapsing the wind vector (and all sway) to zero.
    else windUniforms.uWindDir.value.set(0.8, 0.4).normalize()
    windUniforms.uWindStrength.value = GRASS_WIND_STRENGTH[weather] ?? GRASS_WIND_STRENGTH.clear
  }

  function generateCell(entry, params) {
    const t0 = performance.now()
    const { cx, cz } = entry
    const x0 = cx * CELL_SIZE
    const z0 = cz * CELL_SIZE
    const rng = mulberry32((params.seed ^ hashCell(cx, cz)) | 0)
    const density = THREE.MathUtils.clamp(params.grassDensity, 0, 1)
    const points = []
    if (density > 0) {
      const K = hf.projection.K
      const probeWorld = SLOPE_PROBE_M * K
      const falloff = lerp(1, 0.15, smoothstep(0, RADIUS_UNITS, entry.dist)) // 距離 anchor 越遠密度衰減 (never fully 0 — smooth edge, not a hard wall)
      outer: for (let j = 0; j < GRID_N; j++) {
        for (let i = 0; i < GRID_N; i++) {
          if (rng() > density * falloff) continue // cheap pre-filter before the expensive height/slope sampling below
          const x = x0 + ((i + rng()) / GRID_N) * CELL_SIZE
          const z = z0 + ((j + rng()) / GRID_N) * CELL_SIZE
          const h = hf.heightAtWorld(x, z)
          if (h <= MIN_ELEV_M || h > MAX_ELEV_M) continue // 海/灘 or 高山之上 不放
          const dhdx = (hf.heightAtWorld(x + probeWorld, z) - hf.heightAtWorld(x - probeWorld, z)) / (2 * SLOPE_PROBE_M)
          const dhdz = (hf.heightAtWorld(x, z + probeWorld) - hf.heightAtWorld(x, z - probeWorld)) / (2 * SLOPE_PROBE_M)
          if (Math.sqrt(dhdx * dhdx + dhdz * dhdz) > MAX_SLOPE_TAN) continue // 坡度 > 35° 不放
          points.push({
            x,
            z,
            groundM: h,
            yaw: rng() * Math.PI * 2,
            widthJitter: 0.8 + rng() * 0.4,
            heightJitter: 0.75 + rng() * 0.5,
            tint: rng(),
          })
          if (points.length >= MAX_POINTS_PER_CELL) break outer
        }
      }
    }
    entry.points = points
    lastGenMs = performance.now() - t0
  }

  function ensureCellsAround(ax, az) {
    const cx0 = Math.floor(ax / CELL_SIZE)
    const cz0 = Math.floor(az / CELL_SIZE)
    const wanted = new Set()
    for (let dz = -R_CELLS; dz <= R_CELLS; dz++) {
      for (let dx = -R_CELLS; dx <= R_CELLS; dx++) {
        const cx = cx0 + dx
        const cz = cz0 + dz
        const ccx = (cx + 0.5) * CELL_SIZE
        const ccz = (cz + 0.5) * CELL_SIZE
        const dist = Math.hypot(ccx - ax, ccz - az)
        if (dist > RADIUS_UNITS) continue
        const key = cx + ',' + cz
        wanted.add(key)
        const existing = cells.get(key)
        if (!existing) {
          cells.set(key, { cx, cz, dist, state: 'pending', points: [] })
          pendingQueue.push(key)
        } else {
          existing.dist = dist
        }
      }
    }
    // recycle: drop any tracked cell that fell outside the radius this frame
    for (const key of cells.keys()) {
      if (!wanted.has(key)) {
        cells.delete(key)
        dirty = true
      }
    }
  }

  function processPending(params) {
    let budget = MAX_CELLS_PER_FRAME
    while (budget > 0 && pendingQueue.length > 0) {
      const key = pendingQueue.shift()
      const entry = cells.get(key)
      if (!entry || entry.state !== 'pending') continue // stale — recycled before its turn came up (see ensureCellsAround)
      budget--
      const ccx = (entry.cx + 0.5) * CELL_SIZE
      const ccz = (entry.cz + 0.5) * CELL_SIZE
      // one DEM tile (~8.9 km at z12) dwarfs one grass cell (240 m), so the
      // cell CENTER's tile residency stands in for the whole cell (see
      // tileResident's header) — cheap single check instead of 4 corners.
      if (!tileResident(hf, ccx, ccz)) {
        pendingQueue.push(key) // tiles not streamed in yet — retry later, NOT cached as permanently empty (see tileResident header)
        continue
      }
      generateCell(entry, params)
      entry.state = 'ready'
      dirty = true
    }
  }

  const _pos = new THREE.Vector3()
  const _quat = new THREE.Quaternion()
  const _scale = new THREE.Vector3()
  const _mat = new THREE.Matrix4()
  const _color = new THREE.Color()
  const _up = new THREE.Vector3(0, 1, 0)

  function writeInstance(i, p, params) {
    const ex = params.demExaggeration
    const K = hf.projection.K
    const y = metersToWorldY(hf, p.groundM, ex) + LIFT_M * K
    const heightWorld = Math.max(params.grassHeight, 0) * worldYScale(hf, ex) * p.heightJitter
    const widthWorld = K * p.widthJitter
    _pos.set(p.x, y, p.z)
    _quat.setFromAxisAngle(_up, p.yaw)
    _scale.set(widthWorld, heightWorld, widthWorld)
    _mat.compose(_pos, _quat, _scale)
    mesh.setMatrixAt(i, _mat)
    const t = THREE.MathUtils.clamp(p.groundM / 2500, 0, 1)
    _color.copy(LOW_COLOR).lerp(HIGH_COLOR, t).multiplyScalar(0.82 + p.tint * 0.32)
    mesh.setColorAt(i, _color)
  }

  // full repack — spec's own suggested first approach ("最簡單做法：全量重排
  // count；40k 重排一次的成本先實測，>5ms 就做增量 swap-remove"); only ever
  // called when the active cell SET changed (dirty flag, at most once/frame —
  // see tickView), not per-point, so its cost is bounded by however many
  // instances are currently active (typically well under CAPACITY — see
  // generateCell's density/falloff budget), not by the 40k ceiling.
  function repack(params) {
    flatPoints = []
    for (const entry of cells.values()) {
      if (entry.state === 'ready') for (const p of entry.points) flatPoints.push(p)
    }
    let n = flatPoints.length
    if (n > CAPACITY) {
      if (!warnedOverflow) {
        console.warn(`[grass] ${n} instances exceeds capacity ${CAPACITY} — truncating`)
        warnedOverflow = true
      }
      n = CAPACITY
    }
    for (let i = 0; i < n; i++) writeInstance(i, flatPoints[i], params)
    mesh.count = n
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }

  // cheap re-layout of the CURRENTLY active instances from their already-
  // generated point records — no new sampling/filtering. Point positions and
  // groundM are demExaggeration-INDEPENDENT (heightAtWorld always returns
  // real DEM meters), so a demExaggeration/grassHeight change only needs its
  // vertical placement/scale recomputed, not a full cell regeneration.
  function layoutAll(params) {
    const n = mesh.count
    for (let i = 0; i < n; i++) writeInstance(i, flatPoints[i], params)
    if (n > 0) {
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
  }

  return {
    id: 'grass',
    kind: 'area',
    label: 'Grass',
    rowLabel: '草地 Grass',
    object3d: group,
    visibleParam: 'grassVisible',
    paramMap: { visible: 'grassVisible', density: 'grassDensity', height: 'grassHeight' },

    build() {},

    // regenerateTerrain path (demExaggeration rebuild) + grassVisible/
    // grassHeight HANDLERS — always cheap (layoutAll, see its own header),
    // never re-samples points. grassDensity needs real point regeneration
    // instead — see regenerate() below, called directly by its own HANDLER.
    update(ctx) {
      applyGate(ctx)
      if (ctx.heightField && mesh.count > 0) layoutAll(ctx.params)
    },

    // grassDensity change: clears every tracked cell so ensureCellsAround
    // treats the whole streamed area as freshly wanted again next tick, re-
    // queuing it through the normal MAX_CELLS_PER_FRAME budget (never a
    // synchronous full-density rebuild). The CURRENT instance buffer is left
    // untouched here on purpose — old (stale-density) tufts keep rendering
    // until enough newly-generated cells replace them via the next repack(),
    // avoiding a flash-to-empty on a slider drag.
    regenerate(ctx) {
      cells.clear()
      pendingQueue.length = 0
      dirty = false
      applyGate(ctx)
    },

    tickView(ctx) {
      const show = applyGate(ctx)
      if (!show) return // "camGroundM ≥ 1500 時...停止生成" — no ensureCellsAround/processPending while gated off
      windTime += ctx.dt
      applyWeatherWind(ctx.params.weather)
      windUniforms.uGrassTime.value = windTime
      const ax = ctx.camera.position.x
      const az = ctx.camera.position.z
      ensureCellsAround(ax, az)
      processPending(ctx.params)
      if (dirty) {
        repack(ctx.params)
        dirty = false
      }
    },

    // index.js's isAnimating(): "可見 && 有 instance && 在距離門檻內" — the
    // third condition already collapses into group.visible (applyGate only
    // turns it on inside CAM_GROUND_LIMIT_M), so this is exactly those two
    // checks. False whenever hidden (roundview, grassVisible off, or too
    // high) — the on-demand loop correctly idles/freezes in all those cases.
    isAnimating() {
      return group.visible && mesh.count > 0
    },

    describe() {
      return {
        id: 'grass',
        kind: 'area',
        label: 'Grass',
        rowLabel: '草地 Grass',
        count: mesh.count,
        visible: params.grassVisible,
        styleSchema: GRASS_STYLE,
        style: {
          density: params.grassDensity,
          height: params.grassHeight,
        },
      }
    },

    // debug/verify hook (window.__exp scripts) — cell/instance counts and the
    // last measured generateCell() wall time, not part of the Layer interface.
    debugStats() {
      return { cells: cells.size, pending: pendingQueue.length, instances: mesh.count, lastGenMs }
    },

    dispose() {
      tuftGeo.dispose()
      material.dispose()
    },
  }
}
