import * as THREE from 'three'
import { Terrain } from './terrain.js'
import { createCoastline } from './coastline.js'
import { createCounties } from './counties.js'
import { createMarkers } from './markers.js'
import { createCone } from './cone.js'
import { createLabels, disposeLabels } from './labels.js'
import { createHud3D, findPois } from './hud3d.js'
import { makeProjection, HeightField, TAIWAN_BBOX } from './geo.js'
import { ChunkManager } from './chunks.js'
import { findRealPeaks } from './peaks.js'
import { createStage, LOD_MIN, LOD_MAX } from './scene.js'
import { createMotion } from './tour.js'
import { createKeyPan } from './keypan.js'

// Engine facade — the ONLY module the UI layer imports. Owns the whole 3D
// world (stage + terrain + chunk streaming + POIs + camera motion) and talks
// outward exclusively through:
//   - createEngine({ container, params }) → engine
//   - engine.setParams(patch) / getParams()  — parameter dispatch table
//   - engine.flyTo / startTour / stopTour / selectPoi / deselect / triggerScan
//   - engine.on(event, cb) — 'frame' 'stats' 'gps' 'pois' 'selection' 'loading' 'params'
// UI never reaches into scene internals; debug/verify scripts use engine.debug.

// Taiwan presets: [lat, lon, zoom]. P1: one streamed world locked to z12 —
// presets are fly-to targets inside it (zoom entries kept for the P2 LOD work)
export const DEM_PRESETS = {
  '玉山 Yushan': [23.47, 120.9575, 12],
  '雪山 Xueshan': [24.3836, 121.2317, 12],
  '大霸尖山 Dabajian': [24.4607, 121.2578, 13],
  '南湖大山 Nanhu': [24.362, 121.4383, 12],
  '合歡山 Hehuan': [24.1436, 121.2716, 12],
  '太魯閣 Taroko': [24.1735, 121.4906, 12],
  '嘉明湖 Jiaming Lake': [23.2907, 121.0325, 13],
  '七星山 Qixing': [25.17, 121.556, 13],
  Custom: null,
}

export const DEFAULT_PARAMS = {
  // terrain source
  source: 'real',
  demLocation: '玉山 Yushan',
  demLat: 23.47,
  demLon: 120.9575,
  demZoom: 12,
  demExaggeration: 1.6,
  chunkRes: 128, // per-chunk grid density (real mode; 25 chunks share it)
  detailBias: 0, // 0|1 — lifts the distance-LOD ladder one zoom (Settings 精緻度; read by scene.tickView)
  outerChunkRes: 64, // grid density for outer LOD-ring chunks (64 標準/高, 128 超高)

  // terrain generation
  seed: 7,
  scale: 0.055,
  octaves: 6,
  lacunarity: 2.2,
  gain: 0.55,
  amplitude: 1.8,
  warp: 2.0,
  detail: 0.0,
  detailScale: 1.9,
  resolution: 1024,

  // surface material
  color: '#c2c2c2',
  roughness: 1.0,
  roughnessVariation: 0.5,
  roughnessScale: 1,
  bumpScale: 0.2,
  envMapIntensity: 1.5,

  // camera & depth of field
  fov: 43,
  autoFocus: true,
  focusDistance: 24.74,
  focusRange: 25,
  bokehScale: 0,

  // map overlay
  mapTint: 1.0,
  heightContrast: 5.1,
  heightPivot: 0.53,
  gradLow: '#ffffff',
  gradMid1: '#ffffff',
  gradMid2: '#ffffff',
  gradHigh: '#ffa861',
  gradMid1Pos: 0.35,
  gradMid2Pos: 0.36,
  slopeTint: 0.5,
  contourInterval: 0.11,
  contourOpacity: 1,
  contourColor: '#000000',
  gridStep: 5,
  gridOpacity: 1,
  labels: true,
  coastline: true,
  coastlineWidth: 2.5,
  coastlineOpacity: 0.85,
  coastlineColor: '#1c1c1c',
  counties: true,
  countiesWidth: 1.5,
  countiesOpacity: 0.5,
  countiesColor: '#444444',

  // HUD
  hud: true,
  hudOpacity: 1,
  uiBlur: 9,
  uiBgOpacity: 0.4,
  hudAccent: '#ff4d00',
  hudInk: '#17191b',
  sweepSpeed: 2.5,
  scanColor: '#ccd6ff',
  scanDuration: 4.6,
  scanWidth: 0.8,
  scanBlur: 0.86,
  scanDispHeight: 1.16,
  scanDispFalloff: 1.2,

  // look
  exposure: 0.96,
  contrast: 0.07,
  saturation: -0.35,
  vignette: 0.6,
  grain: 0.35,
  fogNear: 35.5,
  fogFar: 50,
  fogColor: '#ffffff',
  // R2: multiplies the fog near/far baseline inside the fogScale computation
  // (scene.tickView) — pushes the fog wall out; chunk streaming, scan radius
  // and POI search all key off fogFar × fogScale so they follow automatically.
  viewRange: 1.0,
  surveyLines: true,

  // motion
  coneSpin: 0,
  coneTilt: 0,
  coneDrift: 0,
  bob: 0,
  ringSpeed: 1.0,
  flyDuration: 1.8,
  flyEasing: 'smooth',
  paused: false,

  // tour
  tourFrom: 'PK-01',
  tourTo: 'PK-02',
  tourDuration: 14,
  tourAltitude: 2.5,
  tourSmoothing: 0.7,
  tourLook: 0.1,
  tourBank: 0.8,

  // performance
  pixelRatio: Math.min(window.devicePixelRatio, 2),
  shadowMode: 'dynamic',
  shadowRes: 2048,

  // light
  sunIntensity: 8.3,
  sunAzimuth: 64,
  sunElevation: 19,
  hemiIntensity: 0.0,
  envLight: 0.3,
  shadowSoftness: 15,
}

// params whose change requires a full terrain rebuild
const REBUILD_KEYS = new Set([
  'seed',
  'scale',
  'octaves',
  'lacunarity',
  'gain',
  'amplitude',
  'warp',
  'detail',
  'detailScale',
  'resolution',
])
// rebuild only when a DEM world is active (detailBias needs none: scene.tickView
// re-targets the LOD next frame and the chunk rings re-stream incrementally)
const REAL_REBUILD_KEYS = new Set(['demExaggeration', 'chunkRes', 'outerChunkRes'])

export async function createEngine({ container, params: overrides = {} } = {}) {
  const params = { ...DEFAULT_PARAMS, ...overrides }

  // ---------------------------------------------------------------- events
  const listeners = new Map()
  function on(ev, cb) {
    if (!listeners.has(ev)) listeners.set(ev, new Set())
    listeners.get(ev).add(cb)
    return () => listeners.get(ev).delete(cb)
  }
  function emit(ev, data) {
    const set = listeners.get(ev)
    if (set) for (const cb of set) cb(data)
  }

  // ---------------------------------------------------------------- stage + world
  const stage = createStage(params, container)
  const { scene, camera, controls } = stage

  const terrain = new Terrain(params)
  scene.add(terrain.group)
  // real mode: hide the procedural placeholder until DEM tiles arrive
  const pendingReal = params.source === 'real'
  if (pendingReal) terrain.group.visible = false

  // main-island coastline ink line (real mode only) — geometry builds lazily on
  // the first real-mode update, once the projection exists
  const coastline = createCoastline(params, stage.lineResolution)
  scene.add(coastline.line)

  // county borders (real mode only) — same lazy-build pattern; every vertex
  // carries a baked DTM elevation so the line rides the ridgelines
  const counties = createCounties(params, stage.lineResolution)
  scene.add(counties.mesh)

  // generic marker sets (real mode only) — pure display layer behind
  // setMarkerSet/removeMarkerSet/listMarkerSets, never part of the POI system
  const markers = createMarkers(params)
  scene.add(markers.group)

  // chunk streaming: which chunks exist follows the pan target (radius tied to
  // the EFFECTIVE fog wall, so it grows with the far-view fogScale) — meshes
  // build incrementally so dragging never blocks. targetZoom/innerRes feed the
  // P2 LOD rings.
  const chunkManager = new ChunkManager(terrain, {
    radius: () => params.fogFar * stage.fogScale * 1.15,
    targetZoom: () => stage.lodZoom,
    innerRes: () => params.chunkRes,
    outerRes: () => params.outerChunkRes,
  })
  chunkManager.onChunksChanged = () => stage.shadowNeedsUpdate()

  const cone = createCone()
  scene.add(cone.group)

  // real-world heightfield (declared before the first POI pass — computePois reads it)
  let heightField = null
  let demBusy = false

  const labelOpts = () => ({
    real: params.source === 'real',
    toFeet: (h) => terrain.heightToFeet(h),
    // streamed world: labels re-sow around the pan target (see tick throttle)
    center: params.source === 'real' ? { x: controls.target.x, z: controls.target.z } : undefined,
    spots: stage.lodZoom >= 12, // P2: no spot elevations in far views
  })
  let labels = createLabels(terrain.sample, params.seed, labelOpts())
  labels.visible = params.labels && !pendingReal
  scene.add(labels)

  function regenerateLabels() {
    scene.remove(labels)
    disposeLabels(labels)
    labels = createLabels(terrain.sample, params.seed, labelOpts())
    labels.visible = params.labels
    scene.add(labels)
  }

  const poiFeet = (h) => terrain.heightToFeet(h)
  // real Taiwan peaks around the pan target when a DEM is loaded; hill-climb
  // otherwise. P2: the search radius follows the scaled fog wall, and far views
  // show only the top-8 island peaks (spread apart) so the label field never crowds.
  function computePois() {
    if (params.source === 'real' && heightField) {
      const far = stage.lodZoom <= 11
      const real = findRealPeaks(heightField, terrain.sample, controls.target, params.fogFar * stage.fogScale, {
        limit: far ? 8 : 6,
        minSep: 1.5 * stage.fogScale,
      })
      if (real.length) return real
    }
    return findPois(terrain.sample, params.seed, poiFeet)
  }
  let pois = computePois()
  let hud3 = createHud3D(params.seed, pois, {
    ink: params.hudInk,
    accent: params.hudAccent,
    platform: params.source !== 'real',
  })
  hud3.lines.visible = params.surveyLines && !pendingReal
  if (pendingReal) hud3.group.visible = false
  scene.add(hud3.group)

  // ---------------------------------------------------------------- motion (fly-to + tour)
  const motion = createMotion({
    params,
    camera,
    controls,
    sample: (x, z) => terrain.sample(x, z),
    getPois: () => pois,
  })

  // user grabbing the camera cancels any fly-to or tour
  controls.addEventListener('start', () => motion.cancel())

  // arrow-key / WASD smooth pan — a mapped keydown cancels motion the same way
  const keyPan = createKeyPan({ camera, controls, onEngage: () => motion.cancel() })

  // ---------------------------------------------------------------- selection
  const HOME = { pos: new THREE.Vector3(0, 18, 19), target: new THREE.Vector3(0, -0.3, 0) }
  // pose to restore when a selection is closed: wherever the camera was pre-click
  const returnPose = { saved: false, pos: new THREE.Vector3(), target: new THREE.Vector3() }
  let selectedPoi = -1

  function selectPoi(i) {
    const p = pois[i]
    if (!p) return
    if (selectedPoi === -1) {
      returnPose.pos.copy(camera.position)
      returnPose.target.copy(controls.target)
      returnPose.saved = true
    }
    selectedPoi = i
    emit('selection', { index: i, poi: p })
    const dir = new THREE.Vector3(p.x, 0, p.z).normalize()
    motion.flyTo(
      new THREE.Vector3(p.x + dir.x * 6.5, p.h + 4.2, p.z + dir.z * 6.5),
      new THREE.Vector3(p.x, p.h + 0.6, p.z)
    )
  }

  function deselect() {
    selectedPoi = -1
    emit('selection', { index: -1, poi: null })
    motion.flyTo(returnPose.saved ? returnPose.pos : HOME.pos, returnPose.saved ? returnPose.target : HOME.target)
    returnPose.saved = false
  }

  // ---------------------------------------------------------------- source mode / regeneration

  // real-world mode strips the fiction: no cone/reticle, no dial platform.
  // P2: only real mode gets the island-scale dolly range — procedural keeps the
  // legacy 60 (its single plane has nothing to show beyond the fog).
  // (the 2D reticle is the UI layer's half — it derives from the 'pois' event)
  function applySourceMode() {
    const real = params.source === 'real'
    cone.group.visible = !real
    hud3.platform.visible = !real
    controls.maxDistance = real ? 1000 : 60
  }

  function regenerateHud() {
    scene.remove(hud3.group)
    hud3.dispose()
    pois = computePois()
    hud3 = createHud3D(params.seed, pois, {
      ink: params.hudInk,
      accent: params.hudAccent,
      platform: params.source !== 'real',
    })
    hud3.lines.visible = params.surveyLines
    scene.add(hud3.group)
    selectedPoi = -1
    applySourceMode()
    // POI ids change whenever the terrain regenerates (real peak names vs
    // PK-xx) — keep the tour endpoints valid
    const ids = pois.map((p) => p.id)
    if (!ids.includes(params.tourFrom)) params.tourFrom = ids[0]
    if (!ids.includes(params.tourTo)) params.tourTo = ids[1] ?? ids[0]
    emit('pois', pois)
    emit('selection', { index: -1, poi: null })
  }
  applySourceMode()

  let scanStart = -1
  // radar scan: expands from wherever the pan target is when triggered, out to
  // the fog wall (uScanR ≈ the P0 look of 42 units at the default fogFar 50;
  // scaled with the far-view fogScale so the island view scans the island)
  function triggerScan({ kick = false } = {}) {
    scanStart = performance.now() / 1000
    terrain.mapUniforms.uScanCenter.value.set(controls.target.x, controls.target.z)
    terrain.mapUniforms.uScanR.value = params.fogFar * stage.fogScale * 0.84
    if (kick) cone.kick(3)
  }

  let rebuildPending = false
  function regenerateTerrain() {
    if (rebuildPending) return
    rebuildPending = true
    emit('loading', { active: true, message: 'generating terrain…' })
    // let the indicator paint before the synchronous rebuild blocks the thread
    requestAnimationFrame(() =>
      setTimeout(() => {
        terrain.group.visible = true
        terrain.rebuild(params)
        terrain.rebuildRoughness(params)
        if (params.source === 'real' && heightField) {
          // streamed world: existing chunks re-queue and rebuild incrementally
          // (near → far); missing ones stream in via the manager's own loop
          chunkManager.setEnabled(true)
          chunkManager.invalidate()
        } else {
          chunkManager.setEnabled(false)
          chunkManager.clear()
        }
        coastline.update(params, heightField) // sea-level y tracks the vertical scale
        counties.update(params, heightField) // ridgeline ys track it too
        markers.update(params, heightField)
        regenerateLabels()
        regenerateHud()
        refreshPoiAnchor()
        stage.shadowNeedsUpdate()
        rebuildPending = false
        emit('loading', { active: false })
      }, 30)
    )
  }

  // where peaks/labels were last computed — the tick throttle refreshes them
  // once the target wanders far enough from this anchor
  const poiAnchor = new THREE.Vector2(0, 0)
  function refreshPoiAnchor() {
    poiAnchor.set(controls.target.x, controls.target.z)
  }

  // ---------------------------------------------------------------- real-world DEM loading

  // The whole session lives in ONE world: the projection is anchored at the
  // first loaded location (Yushan by default) and never rebuilt — presets and
  // custom coordinates are camera flights inside it, with chunk streaming
  // growing the terrain along the way.
  async function loadRealTerrain() {
    if (heightField) {
      // world already exists (e.g. switching back from procedural) — re-enter it
      regenerateTerrain()
      return
    }
    if (demBusy) return
    demBusy = true
    emit('loading', { active: true, message: 'fetching elevation tiles…' })
    try {
      // P2: one projection + tile cache per LOD level. They all share the same
      // world coordinates (K is anchored at z12 regardless of zoom) and, below,
      // the same frozen datum — so any zoom's chunks land on the same relief.
      const fields = new Map()
      for (const z of [LOD_MIN, 11, 12, LOD_MAX]) {
        fields.set(z, new HeightField(makeProjection({ lat: params.demLat, lon: params.demLon, zoom: z })))
      }
      const hf = fields.get(12) // primary: the z12 anchor level
      const projection = hf.projection
      // seed the 5×5 core (the footprint P0 loaded) and freeze the vertical
      // datum off it — the datum must never shift as tiles stream in later
      const o = projection.worldToPixel(0, 0)
      const ctileX = Math.floor(o.px / 256)
      const ctileY = Math.floor(o.py / 256)
      const core = []
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) core.push({ tx: ctileX + dx, ty: ctileY + dy })
      }
      await hf.ensureTiles(core)
      hf.freezeDatum()
      for (const f of fields.values()) f.datumM = hf.datumM // one datum across LODs
      heightField = hf
      terrain.setHeightFields(fields, 12)
      // pan stays inside the tile-coverage bbox (beyond it is all open sea)
      const a = projection.lonLatToWorld(TAIWAN_BBOX.minLon, TAIWAN_BBOX.maxLat)
      const b = projection.lonLatToWorld(TAIWAN_BBOX.maxLon, TAIWAN_BBOX.minLat)
      stage.setPanBounds({ minX: a.x, maxX: b.x, minZ: a.z, maxZ: b.z })
      params.source = 'real'
      emit('params')
      emit('loading', { active: true, message: 'generating terrain…' })
      regenerateTerrain()
    } catch (err) {
      console.error('DEM load failed:', err)
      emit('loading', { active: true, message: 'elevation fetch failed — check connection' })
      setTimeout(() => emit('loading', { active: false, message: 'generating terrain…' }), 2600)
    } finally {
      demBusy = false
    }
  }

  // Fly the pan target to a geographic coordinate (same fly/tween as POI focus);
  // streaming fills the terrain in. Rejects coordinates outside tile coverage.
  const _flyOffset = new THREE.Vector3()
  function flyToLonLat(lon, lat) {
    if (!heightField) return false
    if (lon < TAIWAN_BBOX.minLon || lon > TAIWAN_BBOX.maxLon || lat < TAIWAN_BBOX.minLat || lat > TAIWAN_BBOX.maxLat) {
      emit('loading', {
        active: true,
        message: `outside tile coverage (lon ${TAIWAN_BBOX.minLon}–${TAIWAN_BBOX.maxLon} / lat ${TAIWAN_BBOX.minLat}–${TAIWAN_BBOX.maxLat})`,
      })
      setTimeout(() => emit('loading', { active: false, message: 'generating terrain…' }), 2600)
      return false
    }
    const { x, z } = heightField.projection.lonLatToWorld(lon, lat)
    _flyOffset.subVectors(camera.position, controls.target) // keep the current view offset
    const target = new THREE.Vector3(x, controls.target.y, z)
    motion.flyTo(target.clone().add(_flyOffset), target)
    emit('params') // refresh the SECTOR location name
    return true
  }

  function applyPreset(name) {
    const p = DEM_PRESETS[name]
    if (!p) return // Custom: use the lat/lon fields + flyTo
    params.demLocation = name
    params.demLat = p[0]
    params.demLon = p[1]
    emit('params')
    if (params.source !== 'real') return
    if (heightField) flyToLonLat(p[1], p[0])
    else loadRealTerrain()
  }

  function setSource(v) {
    const src = v === 'procedural' ? 'noise' : v
    if (src !== 'real' && src !== 'noise') return
    params.source = src
    if (src === 'real') loadRealTerrain()
    else regenerateTerrain()
  }

  // ---------------------------------------------------------------- setParams dispatch
  // rebuild class is deduped (one regenerateTerrain per patch); everything else
  // dispatches per-key: uniforms / material / post chain / camera / lights.
  // Keys without a handler (tour/motion/HUD-appearance/lat-lon) are value-only —
  // consumed on the next frame or by the next action.
  const HANDLERS = {
    source: setSource,
    demLocation: applyPreset,
    // surface material
    color: () => terrain.updateMaterial(params),
    bumpScale: () => terrain.updateMaterial(params),
    envMapIntensity: () => terrain.updateMaterial(params),
    roughness: () => terrain.rebuildRoughness(params),
    roughnessVariation: () => terrain.rebuildRoughness(params),
    roughnessScale: () => terrain.rebuildRoughness(params),
    // camera & focus
    fov: (v) => {
      camera.fov = v
      camera.updateProjectionMatrix()
    },
    focusRange: (v) => (stage.dof.cocMaterial.worldFocusRange = v),
    bokehScale: (v) => {
      stage.dof.bokehScale = v
      stage.dofPass.enabled = v > 0
    },
    // map overlay
    mapTint: (v) => (terrain.mapUniforms.uTint.value = v),
    heightContrast: (v) => (terrain.mapUniforms.uHeightContrast.value = v),
    heightPivot: (v) => (terrain.mapUniforms.uHeightPivot.value = v),
    slopeTint: (v) => (terrain.mapUniforms.uSlopeTint.value = v),
    contourInterval: (v) => (terrain.mapUniforms.uContourInterval.value = v),
    contourOpacity: (v) => (terrain.mapUniforms.uContourOpacity.value = v),
    contourColor: (v) => terrain.mapUniforms.uContourColor.value.set(v),
    gridStep: (v) => (terrain.mapUniforms.uGridStep.value = v),
    gridOpacity: (v) => (terrain.mapUniforms.uGridOpacity.value = v),
    gradLow: () => terrain.rebuildRamp(params),
    gradMid1: () => terrain.rebuildRamp(params),
    gradMid2: () => terrain.rebuildRamp(params),
    gradHigh: () => terrain.rebuildRamp(params),
    gradMid1Pos: () => terrain.rebuildRamp(params),
    gradMid2Pos: () => terrain.rebuildRamp(params),
    labels: (v) => (labels.visible = v),
    coastline: () => coastline.update(params, heightField),
    coastlineWidth: () => coastline.update(params, heightField),
    coastlineOpacity: () => coastline.update(params, heightField),
    coastlineColor: () => coastline.update(params, heightField),
    counties: () => counties.update(params, heightField),
    countiesWidth: () => counties.update(params, heightField),
    countiesOpacity: () => counties.update(params, heightField),
    countiesColor: () => counties.update(params, heightField),
    // look
    exposure: (v) => (stage.exposureFx.uniforms.get('exposure').value = v),
    contrast: (v) => (stage.contrastFx.uniforms.get('contrast').value = v),
    saturation: (v) => (stage.hueSat.saturation = v),
    vignette: (v) => (stage.vignette.darkness = v),
    grain: (v) => (stage.grain.blendMode.opacity.value = v),
    fogNear: (v) => (scene.fog.near = v),
    fogFar: (v) => (scene.fog.far = v),
    fogColor: (v) => {
      scene.fog.color.set(v)
      scene.background.set(v)
    },
    surveyLines: (v) => (hud3.lines.visible = v),
    // HUD colors rebuild the 3D FUI layer (CSS variables are the UI layer's half)
    hudAccent: () => regenerateHud(),
    hudInk: () => regenerateHud(),
    scanColor: (v) => terrain.mapUniforms.uScanColor.value.set(v),
    scanWidth: (v) => (terrain.mapUniforms.uScanWidth.value = v),
    scanBlur: (v) => (terrain.mapUniforms.uScanBlur.value = v),
    scanDispHeight: (v) => (terrain.mapUniforms.uScanDispH.value = v),
    scanDispFalloff: (v) => (terrain.mapUniforms.uScanDispW.value = v),
    // performance
    pixelRatio: (v) => stage.setPixelRatio(v),
    shadowMode: () => stage.applyShadowMode(),
    shadowRes: (v) => stage.setShadowRes(v),
    // light
    sunIntensity: () => stage.placeSun(),
    sunAzimuth: () => stage.placeSun(),
    sunElevation: () => stage.placeSun(),
    hemiIntensity: () => stage.placeSun(),
    envLight: (v) => (scene.environmentIntensity = v),
    shadowSoftness: (v) => (stage.sun.shadow.radius = v),
  }

  function setParams(patch) {
    const keys = Object.keys(patch).filter((k) => k in params)
    for (const k of keys) params[k] = patch[k]
    let rebuild = false
    for (const k of keys) {
      if (REBUILD_KEYS.has(k)) rebuild = true
      else if (REAL_REBUILD_KEYS.has(k)) rebuild = rebuild || params.source === 'real'
      else HANDLERS[k]?.(params[k])
    }
    if (rebuild) regenerateTerrain()
  }

  // ---------------------------------------------------------------- pointer

  const mouse = new THREE.Vector2(0, 0)
  let lastPointer = null
  const onPointerMove = (e) => {
    const nx = (e.clientX / window.innerWidth) * 2 - 1
    const ny = -((e.clientY / window.innerHeight) * 2 - 1)
    if (lastPointer) {
      const speed = Math.hypot(nx - lastPointer.x, ny - lastPointer.y)
      cone.kick(speed * 6)
    }
    lastPointer = { x: nx, y: ny }
    mouse.set(nx, ny)
  }
  window.addEventListener('pointermove', onPointerMove)

  // ---------------------------------------------------------------- stats

  let fps = 60
  function stats() {
    return {
      chunks: terrain.chunkMap.size,
      queue: chunkManager.queue.length,
      tiles: terrain.heightFields ? [...terrain.heightFields.values()].reduce((n, f) => n + f.tiles.size, 0) : 0,
      tileStats: heightField ? { ...heightField.stats } : null,
      lod: stage.lodZoom,
      dist: +camera.position.distanceTo(controls.target).toFixed(1),
      fogScale: +stage.fogScale.toFixed(2),
      fps: Math.round(fps),
    }
  }

  // ---------------------------------------------------------------- loop

  const clock = new THREE.Clock()
  let gpsAcc = 0 // SECTOR GPS refresh throttle
  let poiAcc = 0 // peaks/labels refresh throttle
  let statsAcc = 0 // 'stats' event throttle
  let rafId = 0
  let disposed = false

  const _proj = new THREE.Vector3()
  function project(world, w, h) {
    _proj.copy(world).project(camera)
    return { x: (_proj.x * 0.5 + 0.5) * w, y: (-_proj.y * 0.5 + 0.5) * h, visible: _proj.z < 1 }
  }
  const _sph = new THREE.Spherical()
  const _rel = new THREE.Vector3()

  function tick() {
    if (disposed) return
    rafId = requestAnimationFrame(tick)
    const dt = Math.min(clock.getDelta(), 0.05)
    const t = clock.elapsedTime

    // camera motion: tour > fly tween > free navigation (with pan clamp)
    if (!motion.tick(dt)) {
      keyPan.tick(dt) // arrow/WASD velocity, applied before damping + clamp
      controls.update()
      stage.clampPan() // free navigation only — tours / fly-tos manage their own path
    } else {
      keyPan.reset() // no residual glide fighting an active tour/fly-to
    }

    // P2: distance LOD + far-view scaling. At dist ≤ D0 everything resolves to
    // exactly the P1 values (fogScale = 1); dollying out pushes the fog wall,
    // contour interval and survey grid out proportionally (the map "morphs" to
    // the new scale), fades the shadows, and re-targets the LOD rings through
    // the hysteresis.
    const camDist = camera.position.distanceTo(controls.target)
    const realMode = params.source === 'real' && heightField
    const lodChanged = stage.tickView(camDist, !!realMode)
    const fogScale = stage.fogScale
    terrain.mapUniforms.uContourInterval.value = params.contourInterval * fogScale
    terrain.mapUniforms.uGridStep.value = params.gridStep * fogScale
    coastline.setFogScale(fogScale) // anti-z-fight lift tracks the view scale
    counties.setFogScale(fogScale)
    markers.setFogScale(fogScale)
    markers.tick(dt, camera) // dot rescale / tag sizing / label crowd control
    if (lodChanged && !rebuildPending) {
      // far/near label policies changed — re-sow peaks + spot elevations now
      refreshPoiAnchor()
      regenerateHud()
      regenerateLabels()
    }

    // chunk streaming + shadow frustum follow the pan target every frame
    // (also during tours/flights, so terrain grows along the flight path)
    chunkManager.update(dt, controls.target.x, controls.target.z)
    stage.updateSunAnchor()

    // refresh camera matrices NOW so DOM projections match this frame's render
    // (otherwise labels are projected with last frame's matrices and lag behind)
    camera.updateMatrixWorld()

    if (!params.paused) {
      hud3.update(dt, t, params)
      cone.update(dt, t, mouse, params)
    }

    // terrain scan ripple progress
    if (scanStart >= 0) {
      const p = (performance.now() / 1000 - scanStart) / params.scanDuration
      if (p >= 1) {
        scanStart = -1
        terrain.mapUniforms.uScanT.value = -1
      } else {
        terrain.mapUniforms.uScanT.value = p
      }
    }

    // live SECTOR GPS: the pan target's geographic coordinate (throttled)
    gpsAcc += dt
    if (gpsAcc > 0.5) {
      gpsAcc = 0
      if (params.source === 'real' && heightField) {
        const ll = heightField.projection.worldToLonLat(controls.target.x, controls.target.z)
        emit('gps', { lat: ll.lat, lon: ll.lon, zoom: stage.lodZoom })
      }
    }

    // peaks + spot labels follow the pan target: refresh once it wanders far
    // enough from the last anchor (throttled; skipped mid-flight/tour so POI
    // sets don't churn under an active animation)
    poiAcc += dt
    if (poiAcc > 2) {
      poiAcc = 0
      if (params.source === 'real' && heightField && !motion.tourActive && !motion.tweenActive && !rebuildPending) {
        const moved = Math.hypot(controls.target.x - poiAnchor.x, controls.target.z - poiAnchor.y)
        if (moved > 4) {
          refreshPoiAnchor()
          const fresh = computePois()
          if (fresh.map((p) => p.id).join('|') !== pois.map((p) => p.id).join('|')) regenerateHud()
          regenerateLabels()
        }
      }
    }

    if (params.autoFocus) {
      params.focusDistance = camera.position.distanceTo(cone.getFocusPoint())
    }
    stage.dof.cocMaterial.worldFocusDistance = params.focusDistance

    // HUD frame: everything the 2D layer needs, projected to screen space —
    // the UI layer owns the DOM, the engine owns the math
    if (params.hud) {
      fps += (1 / Math.max(dt, 1e-4) - fps) * 0.05
      const w = window.innerWidth
      const h = window.innerHeight
      _sph.setFromVector3(_rel.copy(camera.position).sub(controls.target))
      const secs = Math.floor(t)
      emit('frame', {
        dt,
        reticle: project(cone.getFocusPoint(), w, h),
        poiScreens: pois.map((p) => project(p.top, w, h)),
        selected: selectedPoi,
        az: THREE.MathUtils.radToDeg(_sph.theta),
        el: 90 - THREE.MathUtils.radToDeg(_sph.phi),
        focus: params.focusDistance,
        lod: params.source === 'real' && heightField ? stage.lodZoom : null,
        fps,
        clock: `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`,
        coneAlt: cone.group.position.y,
        spin: params.coneSpin,
      })
    }

    // coarse stats for non-per-frame consumers (sidebars, debugging)
    statsAcc += dt
    if (statsAcc > 1) {
      statsAcc = 0
      emit('stats', stats())
    }

    stage.composer.render(dt)
  }

  // ---------------------------------------------------------------- facade

  const engine = {
    on,
    setParams,
    getParams: () => params,
    getPois: () => pois,
    getStats: stats,
    // preset flights / custom coordinates. Mirrors the old "load location"
    // button: flies inside the streamed world when it exists, otherwise
    // triggers the initial DEM load at the given coordinate.
    flyTo({ lon, lat } = {}) {
      if (lon !== undefined) params.demLon = lon
      if (lat !== undefined) params.demLat = lat
      if (heightField && params.source === 'real') return flyToLonLat(params.demLon, params.demLat)
      loadRealTerrain()
      return true
    },
    applyPreset,
    setSource,
    startTour(opts = {}) {
      if (opts.from !== undefined) params.tourFrom = opts.from
      if (opts.to !== undefined) params.tourTo = opts.to
      return motion.startTour()
    },
    stopTour: motion.stopTour,
    selectPoi,
    deselect,
    triggerScan,
    // generic marker sets (pure display layer — see markers.js). Same id
    // with `points` replaces the set; without `points` patches color/visible.
    setMarkerSet(id, def) {
      markers.setSet(id, def)
      markers.update(params, heightField) // builds now if the world exists
    },
    removeMarkerSet(id) {
      return markers.removeSet(id)
    },
    listMarkerSets() {
      return markers.listSets()
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(rafId)
      window.removeEventListener('pointermove', onPointerMove)
      keyPan.dispose()
      controls.dispose()
      stage.renderer.dispose()
      stage.renderer.domElement.remove()
      listeners.clear()
    },
    // escape hatch for console debugging / verify scripts (window.__exp) —
    // NOT part of the UI contract
    debug: {
      scene,
      camera,
      controls,
      params,
      terrain,
      chunkManager,
      loadRealTerrain,
      flyToLonLat,
      applyPreset,
      regenerateTerrain,
      triggerScan,
      get labels() {
        return labels
      },
      get heightField() {
        return heightField
      },
      get fps() {
        return fps
      },
      stats,
    },
  }
  engine.debug.engine = engine

  // demo marker set proving the API end-to-end (the 8 preset coordinates,
  // default hidden — the debug GUI toggles it). 玉山/雪山 carry baked summit
  // elevations; the rest exercise the heightAtWorld sampling fallback.
  markers.setSet('demo_locations', {
    visible: false,
    points: [
      { name: '玉山', lat: 23.47, lon: 120.9575, elev: 3952 },
      { name: '雪山', lat: 24.3836, lon: 121.2317, elev: 3886 },
      { name: '大霸尖山', lat: 24.4607, lon: 121.2578 },
      { name: '南湖大山', lat: 24.362, lon: 121.4383 },
      { name: '合歡山', lat: 24.1436, lon: 121.2716 },
      { name: '太魯閣', lat: 24.1735, lon: 121.4906 },
      { name: '嘉明湖', lat: 23.2907, lon: 121.0325 },
      { name: '七星山', lat: 25.17, lon: 121.556 },
    ],
  })

  // real world is the default source — fetch its tiles on startup (not
  // awaited: the engine renders + streams while tiles arrive, exactly like
  // the pre-facade behavior; progress surfaces through 'loading' events)
  if (params.source === 'real') loadRealTerrain()

  tick()

  return engine
}
