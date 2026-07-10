import * as THREE from 'three'
import { Terrain } from './terrain.js'
import { LayerManager } from './layers.js'
import { createCoastlineLayer, createCountiesLayer, createRailLayer, createTrailsLayer, createRiversLayer, createIrrigationLayer } from './polyline.js'
import { createPointLayer } from './markers.js'
import { createReservoirLayer } from './water.js'
import { createTyphoonLayer } from './typhoon.js'
import { createRegionLayer } from './region.js'
import { createLabelsLayer } from './labels.js'
import { createOsmRoadsLayer, createFtwFieldsLayer } from './vectortiles.js'
import { createCone } from './cone.js'
import { createHud3D, findPois } from './hud3d.js'
import { makeProjection, HeightField, TAIWAN_BBOX, worldYScale, metersToWorldY } from './geo.js'
import { ChunkManager } from './chunks.js'
import { findRealPeaks } from './peaks.js'
import { createStage, LOD_MIN, LOD_MAX } from './scene.js'
import { createMotion } from './tour.js'
import { createKeyPan } from './keypan.js'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'

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
  // bathymetry: z10-13 tiles always carry real GEBCO depth now (see
  // docs/BATHYMETRY_DESIGN.md) — this toggle only switches SHADING (ramp +
  // uHeightRange/uSeaLevelY/uSeaSplit + the region sea plane's opacity, see
  // terrain.js applyBathymetryShading / index.js's bathymetryVisible HANDLER).
  // No re-fetch, no chunk rebuild. Default off keeps land rendering
  // bit-identical to before; open ocean now shows subtle (white-shaded)
  // seafloor relief since depth is baked into the mesh itself.
  bathymetryVisible: false,
  bathyDeepColor: '#0b1f36',
  bathyShallowColor: '#4a90c2',
  // very pale green coastal band (~0 to -15~-25 m) between bathyShallowColor
  // and the 0 m shoreline handoff — see terrain.js rebuildRamp
  bathyCoastColor: '#d8e8cf',
  slopeTint: 0.5,
  contourInterval: 0.11,
  contourOpacity: 1,
  contourColor: '#000000',
  gridStep: 5,
  gridOpacity: 1,
  peakLimit: 15,
  peakMinElev: 0,
  peakRadiusKm: 0,
  labels: true,
  coastline: true,
  coastlineWidth: 2.5,
  coastlineOpacity: 0.85,
  coastlineColor: '#1c1c1c',
  counties: true,
  countiesWidth: 1.5,
  countiesOpacity: 0.5,
  countiesColor: '#444444',
  // rail: manifest-driven deferred layer (public/layers/rail_lines.json,
  // fetched on first railVisible:true) — default off, no color param since
  // each line keeps its own official color (see polyline.js createRailLayer)
  railVisible: false,
  railWidth: 2,
  railOpacity: 0.9,
  // OSM roads: PMTiles-streamed vector-tile line layer (docs/VECTOR_TILES_DESIGN.md)
  // — NOT a manifest-driven JSON fetch like rail/trails; the manager
  // (vectortiles.js VectorTileManager) streams tiles from the R2-hosted
  // osm_road_drive.pmtiles archive as the camera pans, only once switched on.
  // Phase 2: highway-class width/color buckets baked per-class into
  // vertexColors (see vectortiles.js ROAD_STYLE) — no single color swatch;
  // width/opacity stay as global multipliers on top of the buckets.
  osmRoadsVisible: false,
  osmRoadsWidth: 1.5,
  osmRoadsOpacity: 0.85,
  // trails: manifest-driven deferred layer (public/layers/trails.json, fetched
  // on first trailsVisible:true), same fail-quiet pattern as rail. Every trail
  // shares one baked color (see polyline.js createTrailsLayer) so — unlike
  // rail — there IS a color param.
  trailsVisible: false,
  trailsWidth: 2,
  trailsOpacity: 0.9,
  trailsColor: '#5a8f3d',
  // rivers: the river layer's BODY is a physics-derived flow-accumulation tint
  // painted into the terrain shader (terrain.js uRiverTex, whole-island bake
  // public/layers/river_sim.png — the retired vector centerlines are gone). ONE
  // toggle (riversVisible) brings up the sim tint + the companion water-surface
  // sheet (public/layers/river_surfaces.json, riversSurfaceOpacity) + the
  // river-name sprites (public/layers/rivers.json → labels, riverNames).
  // riversColor feeds BOTH the sim tint (uRiverSimColor) and the surfaces.
  riversVisible: false,
  riversColor: '#3d86c6',
  riversSurfaceOpacity: 0.5,
  riverNames: true, // river-name labels (0/1 toggle in the Layers panel)
  // 河川濃度: density of the physics river tint (uRiverSimOpacity). The whole-
  // island bake PNG is fetched once, on the first switch-on (see loadRiverSim).
  riverSimOpacity: 0.75,
  // reservoirs: deferred water-surface area layer (public/layers/reservoirs.json
  // + live Supabase storage ratios). ratio is a percent slider — default 100
  // shows each basin at its live level; touching it overrides all basins.
  reservoirsVisible: false,
  reservoirsRatio: 100,
  reservoirsOpacity: 0.55,
  reservoirsColor: '#2f8fd0',
  // farm: whole-island physics-derived farmland-presence tint painted into
  // the terrain shader (terrain.js uFarmTex, bake public/layers/farm_sim.png)
  // — same shader-drape mechanism as the river sim, but an INDEPENDENT layer
  // (farmland is agriculture, not hydrology — see loadFarmSim/applyFarmSim
  // below and the farm_sim LayerManager entry). 農田濃度 drives uFarmOpacity;
  // farmColor drives uFarmColor (Chianan Plain green).
  farmVisible: false,
  farmOpacity: 0.7,
  farmColor: '#7a9e4f',
  // irrigation: manifest-driven deferred polyline layer (public/layers/irrigation.json,
  // fetched on first irrigationVisible:true), same deferred pattern as trails.
  // Every canal shares ONE baked color (data.meta.color — see loadIrrigationData
  // / polyline.js createIrrigationLayer), so — like trails — there IS a single
  // color param (not per-line vertexColors like rail).
  irrigationVisible: false,
  irrigationWidth: 1.5,
  irrigationOpacity: 0.85,
  irrigationColor: '#3d7a9e',
  // ftw fields: PMTiles-streamed vector-tile POLYGON layer (docs/VECTOR_TILES_DESIGN.md
  // Phase 3) — same streamed-not-manifest pattern as osmRoadsVisible above, but
  // triangulated farmland parcels instead of lines (see vectortiles.js
  // createFtwFieldsLayer). A near-field, per-parcel-clickable companion to the
  // farmVisible whole-island tint above — NOT a replacement for it (see the
  // layer's own rowLabel/describe for the distinction). Fill color is fixed
  // (design §4); 濃度 (opacity) is the only style param.
  ftwFieldsVisible: false,
  ftwFieldsOpacity: 0.6,
  // region: neighbouring coastlines (outlying islands, N Philippines, Ryukyus,
  // S Japan, S Korea, SE China) as flat strokes over a sea-coloured plane —
  // geographic context beyond the Taiwan DEM footprint (src/engine/region.js).
  // Deferred: public/layers/region_coast.json fetched on first switch-on.
  regionVisible: false,
  regionSeaColor: '#c2e0ff', // light blue sea (user default, RGB 194 224 255)
  // opaque by default so bathymetry-off matches the app's pre-bathymetry
  // look; the bathymetryVisible HANDLER drops this to 0.5 while seafloor
  // shading is on, so the semi-transparent plane reveals the relief beneath
  // it (see docs/BATHYMETRY_DESIGN.md §2.5).
  regionSeaOpacity: 1.0,
  regionLineColor: '#303030', // dark-grey coastline (user default, RGB 48 48 48)
  regionLineWidth: 1.3,
  regionLineOpacity: 0.9,
  // typhoon: a purely procedural vortex cloud sheet high above the terrain
  // (src/engine/typhoon.js) — no data, animated entirely in the fragment shader.
  // The eye defaults to just off the SE coast so the rainbands sweep the island;
  // best viewed from the zoomed-out island view. Toggling it on keeps the render
  // loop non-idle (isAnimating) so the swirl animates.
  typhoonVisible: false,
  typhoonOpacity: 0.95,
  typhoonLon: 122.6,
  typhoonLat: 23.0,
  typhoonRadiusKm: 320,
  typhoonSpin: 0.11,
  typhoonEyeSize: 0.06,
  typhoonHeight: 30, // vertical relief of the cloud mesh (world units; eyewall towers)
  typhoonDensity: 1.0, // cloud fill/density boost (1 = raw; higher fills band gaps, thicker)
  // light storm-grey: reads on the default white sky (3D shading gives it form).
  // For the satellite look, set a dark/ocean-blue fogColor + a near-white cloud
  // (e.g. fogColor '#16324f', typhoonColor '#eef2f7') — white cloud needs a dark sky
  typhoonColor: '#c8d2df',

  // HUD
  hud: true,
  hudOpacity: 1,
  uiBlur: 9,
  uiBgOpacity: 0.4,
  hudAccent: '#e8450e',
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
  tourMode: 'p2p', // 'p2p' | 'orbit' | 'contour'
  tourFrom: 'PK-01',
  tourTo: 'PK-02',
  tourDuration: 14,
  tourAltitude: 2.5,
  tourSmoothing: 0.7,
  tourLook: 0.1,
  tourBank: 0.8,
  contourOffset: 300, // meters below the summit for the contour-flight band

  // performance
  pixelRatio: Math.min(window.devicePixelRatio, 1.5),
  shadowMode: 'static',
  shadowRes: 1024,

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

// P2: minDistance now lets the camera dolly right up to a hillside (see
// scene.js) — clear the ground by this many world units so it never digs
// into the mesh at the closest zoom
const CAMERA_GROUND_MARGIN = 0.06

// Data-layer manifest (public/layers/manifest.json): one small fetch at
// startup describing every deferred GIS overlay (id/url/default style) — NOT
// the data itself. Each entry's own JSON (rail_lines.json, stations.json, …)
// is only fetched the first time its layer is switched on (see
// loadRailData/loadStationsData below). Missing/broken manifest degrades to
// the hardcoded fallback URLs, so a fetch failure never blocks the layer.
async function loadLayerManifest() {
  try {
    const res = await fetch('/layers/manifest.json')
    if (!res.ok) throw new Error(`manifest.json ${res.status}`)
    const json = await res.json()
    return json.layers ?? []
  } catch (err) {
    console.warn('[layers] manifest fetch failed', err)
    return []
  }
}

export async function createEngine({ container, params: overrides = {} } = {}) {
  const params = { ...DEFAULT_PARAMS, ...overrides }
  const layerManifest = loadLayerManifest() // fired now; awaited lazily by loadRailData/loadStationsData
  const manifestUrl = async (id, fallback) => (await layerManifest).find((l) => l.id === id)?.url ?? fallback

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

  // ---------------------------------------------------------------- on-demand render
  // Real mode renders only inside an "activity window" opened by an invalidate
  // event, plus while anything is still animating; otherwise the tick goes idle
  // (no composer.render / controls.update / hud / markers work — GPU parks).
  // Procedural mode has permanent platform/cone animation, so it never idles.
  const ACTIVE_WINDOW_MS = 2500 // continuous render for this long after each invalidate
  // Retina-sharp freeze: the one idle frame renders at native DPR (≤2); live
  // interaction stays at the (lower) params.pixelRatio cap for speed.
  const IDLE_PIXEL_RATIO = Math.min(window.devicePixelRatio || 1, 2)
  let activeUntil = 0
  let idle = false
  let idleFrameAcc = 0 // idle 2 Hz 'frame' throttle
  let pixelBumped = false // whether the idle freeze raised the pixel ratio
  let renderCount = 0 // DEV verify hook: +1 per real composer.render

  // any state change that should show on screen calls this — it (re)opens the
  // render window; the tick keeps rendering until it expires AND nothing animates
  function invalidate() {
    activeUntil = performance.now() + ACTIVE_WINDOW_MS
  }

  // controls fire 'change' every frame the camera actually moves (drag, wheel,
  // damping tail, keypan → controls.update, programmatic). 'start'/'end' bracket
  // a grab so the window opens on mousedown before any motion.
  controls.addEventListener('start', invalidate)
  controls.addEventListener('change', invalidate)
  controls.addEventListener('end', invalidate)
  const onResize = () => invalidate() // scene.js owns the actual resize handler
  window.addEventListener('resize', onResize)

  const terrain = new Terrain(params)
  scene.add(terrain.group)
  // real mode: hide the procedural placeholder until DEM tiles arrive
  const pendingReal = params.source === 'real'
  if (pendingReal) terrain.group.visible = false

  // Overlay layers (coastline / county borders / marker sets / place labels)
  // live behind ONE ordered registry — the engine drives them via
  // layers.updateAll() (regenerate path) + layers.tickAll() (non-idle tick)
  // instead of naming each overlay by hand. All are real-mode-only and build
  // lazily once the projection exists. Adding a layer next stage = register one.
  let heightField = null // real-world height source (geo.js) — set on first DEM load
  let demBusy = false
  const toFeetFn = (h) => terrain.heightToFeet(h)

  // fresh per-call snapshot of the live world state every layer reads from
  function layerCtx(dt = 0) {
    return {
      params,
      heightField,
      projection: heightField ? heightField.projection : null,
      camera,
      fogScale: stage.fogScale,
      dt,
      lineResolution: stage.lineResolution,
      // label-specific: fictional cartography in noise mode, real spot heights
      // + pan-following re-sow in streamed real mode
      sample: terrain.sample,
      seed: params.seed,
      real: params.source === 'real',
      toFeet: toFeetFn,
      labelCenter: params.source === 'real' ? { x: controls.target.x, z: controls.target.z } : undefined,
      spots: stage.lodZoom >= 12, // P2: no spot elevations in far views
      lodZoom: stage.lodZoom, // vectortiles.js VectorTileManager derives its MVT zoom from this
    }
  }

  const layers = new LayerManager(scene)
  const pointLayer = createPointLayer(params) // marker sets — imperative set API preserved
  // display labels for the station marker systems (see stationsLayer pickRows
  // below) — the baked stations.json carries only the bare system id
  const STATION_SYSTEM_LABELS = {
    tra: '台鐵 TRA',
    trtc: '台北捷運 TRTC',
    krtc: '高雄捷運 KRTC',
    klrt: '高雄輕軌 KLRT',
    tmrt: '台中捷運 TMRT',
    thsr: '台灣高鐵 THSR',
    aklrt: '安坑輕軌 AKLRT',
  }
  // stations: a second marker-set collection, grouped one set per transit
  // system (see loadStationsData below). onActivate fires once, on the
  // panel's first toggle-on, and fetches public/layers/stations.json.
  const stationsLayer = createPointLayer(params, {
    id: 'stations',
    label: 'Stations',
    rowLabel: '車站 Stations',
    onActivate: () => loadStationsData(),
    // click-to-inspect (see layers.pickAll / index.js pointerup handler)
    pickRows: (pt, setId) => [
      ['站名 Name', pt.name || '—'],
      ['系統 System', STATION_SYSTEM_LABELS[setId] ?? setId.toUpperCase()],
    ],
  })
  // trail signs: a third marker-set collection (one set — 'signs' — 3,407
  // points), same deferred onActivate pattern as stations. Unlike stations,
  // these points are waypoints along a route (often literally the same
  // coordinates as the trails layer's own baked line vertices — see
  // polyline.js createTrailsLayer), not sparse distinctly-named entities:
  // showLabels:false drops the per-point name tags (every waypoint on one
  // trail shares that trail's name — tags would pile up), and a smaller
  // dotRadius keeps the dense marker chain from reading as a solid tube that
  // hides the thinner trail line drawn at the same spots. See
  // loadTrailSignsData below.
  const trailSignsLayer = createPointLayer(params, {
    id: 'trail_signs',
    label: 'Trail Signs',
    rowLabel: '步道路標 Trail Signs',
    onActivate: () => loadTrailSignsData(),
    showLabels: false,
    dotRadius: 0.05,
    // click-to-inspect (see layers.pickAll / index.js pointerup handler)
    pickRows: (pt) => [
      ['名稱 Name', pt.name || '—'],
      ['分署 Department', pt.dept || '—'],
    ],
  })
  const labelsLayer = createLabelsLayer(params)
  const reservoirsLayer = createReservoirLayer(params)
  const osmRoadsLayer = createOsmRoadsLayer(params, { invalidate })
  const ftwFieldsLayer = createFtwFieldsLayer(params, { invalidate })
  // Layers panel grouping (主題 → 圖層): the ONLY place a layer's theme is
  // decided — layer modules stay presentation-agnostic, layers.js just carries
  // whatever meta.group/subgroup it's registered with through to describe(),
  // and Layers.jsx renders purely off that. Adding a new overlay to an
  // existing theme is one entry here, no Layers.jsx edit. Anything left out
  // falls back to LayerManager's UNGROUPED ("其他 Other") bucket instead of
  // disappearing from the panel — every registered layer below has a home so
  // that bucket stays empty in normal use.
  const GROUP_BASE = { id: 'base', label: '底圖 Base', order: 0 }
  const GROUP_MOVE = { id: 'move', label: '交通 Move', order: 1 }
  const GROUP_WATER = { id: 'water', label: '水文 Water', order: 2 }
  const GROUP_AGRI = { id: 'agri', label: '農業 Agriculture', order: 3 }
  const GROUP_OUTDOOR = { id: 'outdoor', label: '戶外 Outdoor', order: 4 }
  const GROUP_FX = { id: 'fx', label: '效果 FX', order: 5 }
  const LAYER_GROUPS = {
    region: { group: GROUP_BASE },
    coastline: { group: GROUP_BASE },
    counties: { group: GROUP_BASE },
    // generic marker-set scaffold (setMarkerSet/removeMarkerSet/listMarkerSets
    // — a console/scripting escape hatch, not a themed dataset: no default
    // sets are ever registered from the UI, so it never carries real data in
    // normal use). Not tied to any theme (transport/water/outdoor); parked
    // under Base as a generic overlay utility rather than left in "其他".
    markers: { group: GROUP_BASE },
    rail: { group: GROUP_MOVE },
    stations: { group: GROUP_MOVE },
    osm_roads: { group: GROUP_MOVE },
    rivers: { group: GROUP_WATER },
    reservoirs: { group: GROUP_WATER },
    // farmland tint + irrigation canals: agriculture, not hydrology — its own
    // theme even though both share the water-adjacent shader-drape/polyline
    // machinery (see loadFarmSim/applyFarmSim and createIrrigationLayer)
    farm_sim: { group: GROUP_AGRI },
    ftw_fields: { group: GROUP_AGRI },
    irrigation: { group: GROUP_AGRI },
    trails: { group: GROUP_OUTDOOR },
    trail_signs: { group: GROUP_OUTDOOR },
    // peak spot-elevation / place-name labels (labels.js) — cartography tied
    // to the same mountain/hiking context as trails, so it sits alongside them
    labels: { group: GROUP_OUTDOOR },
    typhoon: { group: GROUP_FX },
  }
  // registration order = draw / update order (coastline → counties → rail →
  // trails → rivers → reservoirs → farm sim → irrigation → typhoon →
  // markers → stations → trail signs → labels)
  for (const layer of [
    createRegionLayer(params),
    createCoastlineLayer(params),
    createCountiesLayer(params),
    createRailLayer(params),
    osmRoadsLayer,
    createTrailsLayer(params),
    createRiversLayer(params),
    reservoirsLayer,
    createFarmSimLayer(params),
    ftwFieldsLayer,
    createIrrigationLayer(params),
    createTyphoonLayer(params),
    pointLayer,
    stationsLayer,
    trailSignsLayer,
    labelsLayer,
  ]) {
    layers.register(layer, layerCtx(), LAYER_GROUPS[layer.id])
  }
  const regenerateLabels = () => labelsLayer.update(layerCtx())
  // param keys that map to a layer's visibility/style — a setParams touching any
  // of them re-emits 'layers' so the dynamic panel refreshes
  const LAYER_KEYS = new Set()
  for (const layer of layers.layers.values()) {
    if (layer.visibleParam) LAYER_KEYS.add(layer.visibleParam)
    if (layer.paramMap) for (const k in layer.paramMap) LAYER_KEYS.add(layer.paramMap[k])
  }

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
  chunkManager.onChunksChanged = () => {
    stage.shadowNeedsUpdate()
    invalidate() // a chunk appeared/vanished (incl. after DEM tiles finish loading)
    osmRoadsLayer.markDemDirty() // coalesced redrape — see vectortiles.js VectorTileManager.markDemDirty
    ftwFieldsLayer.markDemDirty()
  }

  const cone = createCone()
  scene.add(cone.group)

  const poiFeet = (h) => terrain.heightToFeet(h)
  // real Taiwan peaks around the pan target when a DEM is loaded; hill-climb
  // otherwise. P2: the search radius follows the scaled fog wall, and far views
  // show only the top-8 island peaks (spread apart) so the label field never crowds.
  function computePois() {
    if (params.source === 'real' && heightField) {
      const far = stage.lodZoom <= 11
      const kmRadius = params.peakRadiusKm > 0
        ? params.peakRadiusKm * 1000 * heightField.projection.K
        : params.fogFar * stage.fogScale
      const real = findRealPeaks(heightField, terrain.sample, controls.target, kmRadius, {
        limit: far ? Math.max(8, params.peakLimit) : params.peakLimit,
        minSep: 0.6 * stage.fogScale,
        minElev: params.peakMinElev,
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

  // ---------------------------------------------------------------- tour tile pre-streaming
  // The tour planner samples terrain.sample (the primary z12 field). Tiles not
  // resident read datum-low, so a long route would be planned against phantom
  // valleys — pre-stream every tile the route crosses first. Each helper races
  // a timeout so a slow/offline fetch never blocks the flight: planning
  // proceeds with whatever is cached when the clock runs out.
  const raceTimeout = (promise, ms) => Promise.race([promise, new Promise((r) => setTimeout(r, ms))])
  function ensureTourTiles(points, { radiusTiles = 1, timeoutMs = 4000 } = {}) {
    if (!heightField) return Promise.resolve()
    const proj = heightField.projection
    const seen = new Set()
    const coords = []
    for (const p of points) {
      const { px, py } = proj.worldToPixel(p.x, p.z)
      const ctx = Math.floor(px / 256)
      const cty = Math.floor(py / 256)
      for (let dy = -radiusTiles; dy <= radiusTiles; dy++) {
        for (let dx = -radiusTiles; dx <= radiusTiles; dx++) {
          const tx = ctx + dx
          const ty = cty + dy
          const k = tx + ',' + ty
          if (!seen.has(k)) {
            seen.add(k)
            coords.push({ tx, ty })
          }
        }
      }
    }
    return raceTimeout(heightField.ensureTiles(coords), timeoutMs)
  }
  function ensureTourDisk(cx, cz, R, { timeoutMs = 4000 } = {}) {
    if (!heightField) return Promise.resolve()
    const proj = heightField.projection
    const c = proj.worldToPixel(cx, cz)
    const tileW = proj.tileWorldSize
    const tr = Math.ceil(R / tileW) + 1
    const ctx = Math.floor(c.px / 256)
    const cty = Math.floor(c.py / 256)
    const coords = []
    for (let dy = -tr; dy <= tr; dy++) {
      for (let dx = -tr; dx <= tr; dx++) {
        const tx = ctx + dx
        const ty = cty + dy
        const wc = proj.tileCenterWorld(tx, ty)
        if (Math.hypot(wc.x - cx, wc.z - cz) <= R + tileW * 0.75) coords.push({ tx, ty })
      }
    }
    return raceTimeout(heightField.ensureTiles(coords), timeoutMs)
  }

  // ---------------------------------------------------------------- motion (fly-to + tour)
  const motion = createMotion({
    params,
    camera,
    controls,
    sample: (x, z) => terrain.sample(x, z),
    getPois: () => pois,
    ensureTiles: ensureTourTiles,
    ensureDisk: ensureTourDisk,
    worldPerMeter: () => (heightField ? heightField.projection.K * params.demExaggeration : 0),
  })

  // ---------------------------------------------------------------- tour path preview
  // A translucent accent line of the planned route, rebuilt whenever the panel
  // changes from/to/mode/offset. Removed the instant a tour starts and cleared
  // when the panel closes. It re-plans (and re-streams) on every rebuild, so it
  // also tracks demExaggeration changes.
  const tourPreview = { line: null, mat: null, active: false, seq: 0 }
  let lastPreviewOpts = null
  function buildPreviewLine(points) {
    const pos = new Float32Array(points.length * 3)
    for (let i = 0; i < points.length; i++) {
      pos[i * 3] = points[i].x
      pos[i * 3 + 1] = points[i].y
      pos[i * 3 + 2] = points[i].z
    }
    if (!tourPreview.line) {
      const mat = new LineMaterial({ color: new THREE.Color(params.hudAccent), linewidth: 3.5, transparent: true, opacity: 0.85, fog: true, depthTest: false })
      mat.uniforms.resolution.value = stage.lineResolution
      const line = new Line2(new LineGeometry(), mat)
      line.renderOrder = 5
      line.frustumCulled = false
      tourPreview.line = line
      tourPreview.mat = mat
      scene.add(line)
    }
    tourPreview.mat.color.set(params.hudAccent)
    const geo = new LineGeometry()
    geo.setPositions(pos)
    tourPreview.line.geometry.dispose()
    tourPreview.line.geometry = geo
    tourPreview.line.visible = true
    tourPreview.active = true
  }
  function clearTourPreview() {
    tourPreview.active = false
    tourPreview.seq++ // invalidate any in-flight preview plan
    lastPreviewOpts = null
    if (tourPreview.line) tourPreview.line.visible = false
    invalidate()
  }
  async function doTourPreview(opts = {}) {
    if (opts.from !== undefined) params.tourFrom = opts.from
    if (opts.to !== undefined) params.tourTo = opts.to
    if (opts.mode !== undefined) params.tourMode = opts.mode
    if (opts.contourOffset !== undefined) params.contourOffset = opts.contourOffset
    if (!heightField || params.source !== 'real') return null
    lastPreviewOpts = { ...opts }
    const seq = ++tourPreview.seq
    const plan = await motion.planTour({ ...opts, preview: true })
    if (seq !== tourPreview.seq) return null // superseded by a newer preview / a start
    if (!plan) {
      clearTourPreview()
      return null
    }
    buildPreviewLine(plan.previewPoints)
    invalidate()
    return plan.summary
  }

  // user grabbing the camera cancels any fly-to or tour
  controls.addEventListener('start', () => motion.cancel())

  // arrow-key / WASD smooth pan — a mapped keydown cancels motion the same way.
  // onEngage fires on every keydown (incl. OS key-repeat while held), so it also
  // keeps the render window open when panning against a pan-bound (no 'change').
  const keyPan = createKeyPan({
    camera,
    controls,
    onEngage: () => {
      motion.cancel()
      invalidate()
    },
  })

  // ---------------------------------------------------------------- selection
  const HOME = { pos: new THREE.Vector3(0, 18, 19), target: new THREE.Vector3(0, -0.3, 0) }
  // pose to restore when a selection is closed: wherever the camera was pre-click
  const returnPose = { saved: false, pos: new THREE.Vector3(), target: new THREE.Vector3() }
  let selectedPoi = -1

  function selectPoi(i) {
    const p = pois[i]
    if (!p) return
    invalidate()
    if (selectedPoi === -1) {
      returnPose.pos.copy(camera.position)
      returnPose.target.copy(controls.target)
      returnPose.saved = true
    }
    selectedPoi = i
    emit('selection', { index: i, poi: p })

    // p.h can be a stale throttled-refresh cache (poiAcc block below /
    // computePois) baked in before this peak's DEM tile finished streaming —
    // heightAtWorld() reports a phantom "0 m" for a not-yet-resident tile
    // (geo.js heightAtWorld), which used to fly the camera underground until
    // the next POI refresh caught up (peaks.js:34,42-48). Re-sample live at
    // click time instead of trusting the cache.
    let h = terrain.sample(p.x, p.z)
    if (params.source === 'real' && heightField) {
      const scale = worldYScale(heightField, params.demExaggeration)
      const missY = (0 - heightField.datumM) * scale // heightAtWorld's tile-miss signature
      if (Math.abs(h - missY) < 1e-6 && Number.isFinite(p.elevM)) {
        // still not streamed even now — trust the peaks catalogue elevation
        // (peaks.js elevM) rather than the phantom sea-level sample: better
        // to fly high over the mountain than to clip into it
        h = metersToWorldY(heightField, p.elevM, params.demExaggeration)
      }
    }
    h = Math.max(h, p.h) // never settle lower than whatever the cached POI already had

    const dir = new THREE.Vector3(p.x, 0, p.z).normalize()
    motion.flyTo(
      new THREE.Vector3(p.x + dir.x * 6.5, h + 4.2, p.z + dir.z * 6.5),
      new THREE.Vector3(p.x, h + 0.6, p.z)
    )
  }

  function deselect() {
    invalidate()
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
    invalidate()
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
    invalidate()
    scanStart = performance.now() / 1000
    terrain.mapUniforms.uScanCenter.value.set(controls.target.x, controls.target.z)
    terrain.mapUniforms.uScanR.value = params.fogFar * stage.fogScale * 0.84
    if (kick) cone.kick(3)
  }

  let rebuildPending = false
  function regenerateTerrain() {
    if (rebuildPending) return
    invalidate()
    clearPick() // a rebuild can move/replace baked geometry — drop any pinned popup rather than leave it at a stale position
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
        layers.updateAll(layerCtx()) // coastline sea-level y, county ridgelines, markers, labels
        regenerateHud()
        refreshPoiAnchor()
        stage.shadowNeedsUpdate()
        rebuildPending = false
        // the vertical scale (demExaggeration) may have moved — re-plan the
        // visible preview line against the new relief
        if (tourPreview.active && lastPreviewOpts) doTourPreview(lastPreviewOpts)
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

  // coastline's outlying-island rings (Penghu/Kinmen/Matsu/China coast/
  // Taiwan's own outlying islands — scripts/bake_coastlines.py) are ADDITIVE
  // to the existing main-island ring, not a separate layer/toggle (see
  // polyline.js createCoastlineLayer). Deferred fetch, same fail-quiet
  // pattern as rail/trails below; unlike those, coastline defaults to
  // visible so this is also kicked once unconditionally right after layer
  // registration (see the `if (params.coastline)` call below), since
  // HANDLERS.coastline's own toggle-on path only fires on an explicit
  // off→on setParams call, which never happens for an already-true default.
  let coastlineExtFetch = { loading: false, loaded: false }
  async function loadCoastlineExtendedData() {
    if (coastlineExtFetch.loading || coastlineExtFetch.loaded) return
    coastlineExtFetch.loading = true
    try {
      const res = await fetch(await manifestUrl('coastlines_extended', '/layers/coastlines_extended.json'))
      if (!res.ok) throw new Error(`coastlines_extended.json ${res.status}`)
      const data = await res.json()
      layers.get('coastline').setExtraRings(data.rings.map((r) => r.points.map(([lon, lat]) => [lon, lat, 0])))
      coastlineExtFetch.loaded = true
      layers.get('coastline').update(layerCtx())
    } catch (err) {
      console.warn('[layers] coastlines_extended fetch failed', err)
    } finally {
      coastlineExtFetch.loading = false
      invalidate()
      emit('layers')
    }
  }
  if (params.coastline) loadCoastlineExtendedData()

  // ---------------------------------------------------------------- deferred GIS layers (rail / stations)
  // Both public/layers/*.json are baked offline (scripts/bake_layer_elevations.py)
  // with per-vertex elevation already baked in — no DEM sampling needed here,
  // just a plain fetch. Neither is requested until the Layers panel switches
  // the layer on for the first time (see HANDLERS.railVisible and
  // stationsLayer's onActivate above).
  let railFetch = { loading: false, loaded: false }
  async function loadRailData() {
    if (railFetch.loading || railFetch.loaded) return
    railFetch.loading = true
    try {
      const res = await fetch(await manifestUrl('rail', '/layers/rail_lines.json'))
      if (!res.ok) throw new Error(`rail_lines.json ${res.status}`)
      const data = await res.json()
      layers.get('rail').setData(
        data.lines.map((l) => l.points),
        data.lines.map((l) => l.color)
      )
      railFetch.loaded = true
      layers.get('rail').update(layerCtx())
    } catch (err) {
      console.warn('[layers] rail fetch failed', err)
    } finally {
      railFetch.loading = false
      invalidate()
      emit('layers') // refresh the panel's point count now that data (or the failure) landed
    }
  }

  // trails: same deferred fetch-once pattern as rail (baked polylines, no
  // per-line official colors — see polyline.js createTrailsLayer). setData's
  // 2nd arg (lineColors) is null — the single trailsColor swatch drives the
  // style — but the 3rd arg carries one {name,county,lengthKm,ascentM} per
  // trail (parallel to the points arrays) for the click-to-inspect popup
  // (polyline.js pick(), gated on config.pickRows).
  let trailsFetch = { loading: false, loaded: false }
  async function loadTrailsData() {
    if (trailsFetch.loading || trailsFetch.loaded) return
    trailsFetch.loading = true
    try {
      const res = await fetch(await manifestUrl('trails', '/layers/trails.json'))
      if (!res.ok) throw new Error(`trails.json ${res.status}`)
      const data = await res.json()
      layers.get('trails').setData(
        data.lines.map((l) => l.points),
        null,
        data.lines.map((l) => ({ name: l.name, county: l.county, lengthKm: l.lengthKm, ascentM: l.ascentM }))
      )
      trailsFetch.loaded = true
      layers.get('trails').update(layerCtx())
    } catch (err) {
      console.warn('[layers] trails fetch failed', err)
    } finally {
      trailsFetch.loading = false
      invalidate()
      emit('layers')
    }
  }

  // irrigation: same deferred fetch-once pattern as trails (baked polylines).
  // data.meta.color is ONE color for the whole canal network (not per-canal
  // like rail's lineColors array) — setData's 2nd arg stays null and the
  // single irrigationColor swatch drives the style. 3rd arg carries one
  // {name,office} per canal (parallel to the points arrays) for the
  // click-to-inspect popup (polyline.js pick(), gated on config.pickRows).
  let irrigationFetch = { loading: false, loaded: false }
  async function loadIrrigationData() {
    if (irrigationFetch.loading || irrigationFetch.loaded) return
    irrigationFetch.loading = true
    try {
      const res = await fetch(await manifestUrl('irrigation', '/layers/irrigation.json'))
      if (!res.ok) throw new Error(`irrigation.json ${res.status}`)
      const data = await res.json()
      layers.get('irrigation').setData(
        data.lines.map((l) => l.points),
        null,
        data.lines.map((l) => ({ name: l.name, office: l.office }))
      )
      irrigationFetch.loaded = true
      layers.get('irrigation').update(layerCtx())
    } catch (err) {
      console.warn('[layers] irrigation fetch failed', err)
    } finally {
      irrigationFetch.loading = false
      invalidate()
      emit('layers')
    }
  }

  // region: deferred neighbouring-coastline data (public/layers/region_coast.json)
  // fetched once on first switch-on, exactly like rail. The sea plane shows even
  // before the lines land; a fetch failure just leaves the plane + a warn.
  let regionFetch = { loading: false, loaded: false }
  async function loadRegionData() {
    if (regionFetch.loading || regionFetch.loaded) return
    regionFetch.loading = true
    try {
      // coastlines + land/sea mask in parallel; the mask is best-effort (a miss
      // just leaves the sea plane hidden, coastlines still draw)
      const [linesRes, maskMeta] = await Promise.all([
        fetch(await manifestUrl('region', '/layers/region_coast.json')),
        fetch('/layers/region_sea_mask.json')
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`region_sea_mask.json ${r.status}`))))
          .catch((e) => {
            console.warn('[layers]', e.message || e)
            return null
          }),
      ])
      if (!linesRes.ok) throw new Error(`region_coast.json ${linesRes.status}`)
      const data = await linesRes.json()
      layers.get('region').setData(data.lines)
      if (maskMeta) {
        const tex = await new Promise((resolve) =>
          new THREE.TextureLoader().load(maskMeta.png ?? '/layers/region_sea_mask.png', resolve, undefined, () => resolve(null))
        )
        if (tex) {
          // intensity data, not colour (see loadRiverSim): no sRGB, linear, no
          // mipmaps; flipY false so row 0 (north) reads at uv v=0; ClampToEdge so
          // the ocean beyond Taiwan samples the mask's sea border
          tex.flipY = false
          tex.colorSpace = THREE.NoColorSpace
          tex.minFilter = THREE.LinearFilter
          tex.magFilter = THREE.LinearFilter
          tex.generateMipmaps = false
          tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
          tex.needsUpdate = true
          layers.get('region').setMask(tex, maskMeta.bbox)
        }
      }
      regionFetch.loaded = true
      layers.get('region').update(layerCtx())
    } catch (err) {
      console.warn('[layers] region fetch failed', err)
    } finally {
      regionFetch.loading = false
      invalidate()
      emit('layers')
    }
  }

  // rivers: rivers.json now carries only the river-NAME labels (the vector
  // centerlines are retired — the river body is the sim tint, loadRiverSim).
  // rivers.json (labels) + river_surfaces.json (the triangulated water-surface
  // sheet) are fetched in PARALLEL on the first switch-on; the surface fetch is
  // best-effort (a 404/network miss just leaves the labels, resolving to null
  // instead of rejecting the pair). The layer only builds its surface mesh once
  // setSurfaceData has run, avoiding the empty-geometry-then-fill trap.
  let riversFetch = { loading: false, loaded: false }
  async function loadRiversData() {
    if (riversFetch.loading || riversFetch.loaded) return
    riversFetch.loading = true
    try {
      const entry = (await layerManifest).find((l) => l.id === 'rivers')
      const linesUrl = entry?.url ?? '/layers/rivers.json'
      const surfaceUrl = entry?.surfaceUrl ?? '/layers/river_surfaces.json'
      const [linesRes, surfData] = await Promise.all([
        fetch(linesUrl),
        fetch(surfaceUrl)
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`river_surfaces.json ${r.status}`))))
          .catch((e) => {
            console.warn('[layers]', e.message || e)
            return null
          }),
      ])
      if (!linesRes.ok) throw new Error(`rivers.json ${linesRes.status}`)
      const linesData = await linesRes.json()
      layers.get('rivers').setLabels(linesData.labels || [])
      if (surfData) layers.get('rivers').setSurfaceData(surfData.polygons)
      riversFetch.loaded = true
      layers.get('rivers').update(layerCtx())
    } catch (err) {
      console.warn('[layers] rivers fetch failed', err)
    } finally {
      riversFetch.loading = false
      invalidate()
      emit('layers')
    }
  }

  // river SIM: the whole-island physics-derived river body, painted straight
  // into the terrain shader from a flow-accumulation bake. The PNG (grayscale
  // intensity) + JSON meta (geographic bounds) are fetched once, on the first
  // rivers switch-on. Race guard: uRiverTex/uRiverBounds are only wired up AFTER
  // the texture has finished decoding, and the opacity uniform stays 0 until
  // then — so a half-loaded texture is never sampled.
  let riverSimTex = null
  let riverSimMeta = null
  const riverSimFetch = { loading: false, loaded: false }
  function applyRiverSimBounds() {
    if (!riverSimTex || !riverSimMeta || !heightField) return
    const b = riverSimMeta.bbox
    const nw = heightField.projection.lonLatToWorld(b.minLon, b.maxLat) // west / north
    const se = heightField.projection.lonLatToWorld(b.maxLon, b.minLat) // east / south
    terrain.mapUniforms.uRiverBounds.value.set(nw.x, nw.z, se.x, se.z)
    terrain.mapUniforms.uRiverTex.value = riverSimTex
  }
  async function loadRiverSim() {
    if (riverSimFetch.loading || riverSimFetch.loaded) return
    riverSimFetch.loading = true
    try {
      const metaRes = await fetch(await manifestUrl('river_sim', '/layers/river_sim.json'))
      if (!metaRes.ok) throw new Error(`river_sim.json ${metaRes.status}`)
      riverSimMeta = await metaRes.json()
      const pngUrl = riverSimMeta.png ?? '/layers/river_sim.png'
      const tex = await new Promise((resolve, reject) =>
        new THREE.TextureLoader().load(pngUrl, resolve, undefined, reject)
      )
      // intensity data, not color: no sRGB decode, linear filter, no mipmaps.
      // flipY false so image row 0 (north) reads at UV v=0, matching the bake's
      // row-0-is-north convention (see the shader's UV math).
      tex.flipY = false
      tex.colorSpace = THREE.NoColorSpace
      tex.minFilter = THREE.LinearFilter
      tex.magFilter = THREE.LinearFilter
      tex.generateMipmaps = false
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
      tex.needsUpdate = true
      riverSimTex = tex
      riverSimFetch.loaded = true
    } catch (err) {
      console.warn('[layers] river sim fetch failed', err)
    } finally {
      riverSimFetch.loading = false
      applyRiverSim() // now that the texture (or its failure) has landed
    }
  }
  // Set the shader uniforms from the rivers toggle / 河川濃度. Kicks the deferred
  // fetch on the first rivers switch-on; keeps the opacity uniform at 0 (branch
  // skipped in the shader) until the texture is bound — so the layer is truly
  // zero-cost while off.
  function applyRiverSim() {
    const on = !!params.riversVisible
    if (on && !riverSimFetch.loaded && !riverSimFetch.loading) loadRiverSim()
    const active = on && riverSimFetch.loaded
    if (active) applyRiverSimBounds()
    terrain.mapUniforms.uRiverSimColor.value.set(params.riversColor)
    terrain.mapUniforms.uRiverSimOpacity.value = active ? params.riverSimOpacity : 0
    invalidate()
  }

  // farm sim: whole-island physics-derived farmland-presence tint, painted
  // straight into the terrain shader from a binary presence bake — same
  // texture-load conventions as the river sim above (LinearFilter, no sRGB,
  // flipY false, row 0 = north). Own bbox (public/layers/farm_sim.json) — NOT
  // the same numeric bounds as river_sim (different source dataset), but the
  // same tile-pixel grid convention (z13, out_stride 2), so the UV mapping
  // code is identical, just parameterized by this bake's own bbox. Race
  // guard: uFarmTex/uFarmBounds are only wired up AFTER the texture has
  // finished decoding, and the opacity uniform stays 0 until then.
  let farmSimTex = null
  let farmSimMeta = null
  const farmSimFetch = { loading: false, loaded: false }
  function applyFarmSimBounds() {
    if (!farmSimTex || !farmSimMeta || !heightField) return
    const b = farmSimMeta.bbox
    const nw = heightField.projection.lonLatToWorld(b.minLon, b.maxLat) // west / north
    const se = heightField.projection.lonLatToWorld(b.maxLon, b.minLat) // east / south
    terrain.mapUniforms.uFarmBounds.value.set(nw.x, nw.z, se.x, se.z)
    terrain.mapUniforms.uFarmTex.value = farmSimTex
  }
  async function loadFarmSim() {
    if (farmSimFetch.loading || farmSimFetch.loaded) return
    farmSimFetch.loading = true
    try {
      const metaRes = await fetch(await manifestUrl('farm_sim', '/layers/farm_sim.json'))
      if (!metaRes.ok) throw new Error(`farm_sim.json ${metaRes.status}`)
      farmSimMeta = await metaRes.json()
      const pngUrl = farmSimMeta.png ?? '/layers/farm_sim.png'
      const tex = await new Promise((resolve, reject) =>
        new THREE.TextureLoader().load(pngUrl, resolve, undefined, reject)
      )
      // intensity data (binary presence mask), not color: no sRGB decode,
      // linear filter, no mipmaps; flipY false matches the bake's row-0-is-
      // north convention (see the shader's UV math)
      tex.flipY = false
      tex.colorSpace = THREE.NoColorSpace
      tex.minFilter = THREE.LinearFilter
      tex.magFilter = THREE.LinearFilter
      tex.generateMipmaps = false
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
      tex.needsUpdate = true
      farmSimTex = tex
      farmSimFetch.loaded = true
    } catch (err) {
      console.warn('[layers] farm sim fetch failed', err)
    } finally {
      farmSimFetch.loading = false
      applyFarmSim() // now that the texture (or its failure) has landed
    }
  }
  // Set the shader uniforms from the farmVisible toggle / 農田濃度. Kicks the
  // deferred fetch on the first farm switch-on; keeps the opacity uniform at
  // 0 (branch skipped in the shader) until the texture is bound — so the
  // layer is truly zero-cost while off.
  function applyFarmSim() {
    const on = !!params.farmVisible
    if (on && !farmSimFetch.loaded && !farmSimFetch.loading) loadFarmSim()
    const active = on && farmSimFetch.loaded
    if (active) applyFarmSimBounds()
    terrain.mapUniforms.uFarmColor.value.set(params.farmColor)
    terrain.mapUniforms.uFarmOpacity.value = active ? params.farmOpacity : 0
    invalidate()
  }

  // farm_sim LayerManager entry: unlike rivers (which owns a surface mesh +
  // name labels alongside the sim tint), the farm layer's ENTIRE visual IS
  // the terrain-shader tint above — no object3d, no geometry. Registered as
  // its own INDEPENDENT layer (agriculture, not hydrology) purely so it gets
  // a row in the Layers panel; paramMap/visibleParam route every control
  // through setParams → HANDLERS.farmVisible/farmOpacity/farmColor → applyFarmSim().
  function createFarmSimLayer(params) {
    return {
      id: 'farm_sim',
      kind: 'raster',
      label: 'Farm Sim',
      rowLabel: '農田 Farmland',
      visibleParam: 'farmVisible',
      paramMap: { visible: 'farmVisible', opacity: 'farmOpacity', color: 'farmColor' },
      build() {},
      update() {}, // no-op: applyFarmSim() owns every uniform this layer drives
      describe() {
        return {
          id: 'farm_sim',
          kind: 'raster',
          label: 'Farm Sim',
          rowLabel: '農田 Farmland',
          count: 0,
          visible: params.farmVisible,
          styleSchema: {
            opacity: { type: 'slider', label: '農田濃度 Intensity', min: 0, max: 1, step: 0.02, format: (v) => v.toFixed(2) },
            color: { type: 'color', label: '顏色 Color' },
          },
          style: { opacity: params.farmOpacity, color: params.farmColor },
        }
      },
      dispose() {},
    }
  }

  // reservoirs: fetch the baked basin polygons + dam markers, then the LIVE
  // storage ratios from the mini-taiwan-pulse Supabase RPC (anon read-only key).
  // A live-fetch failure is non-fatal: every basin falls back to ratio 1.0
  // (full pool) with a console.warn, so the water surfaces still render.
  const SUPABASE_URL = 'https://utcmcikhvxnohbxchbrs.supabase.co'
  const SUPABASE_ANON =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV0Y21jaWtodnhub2hieGNoYnJzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ1NjgyMDMsImV4cCI6MjA5MDE0NDIwM30.rQSjJ6WD53p9tRZ6M7xleDelktVHfKeZFGPC2ItULVQ'
  async function fetchReservoirRatios() {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_reservoir_status_latest`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON,
          Authorization: `Bearer ${SUPABASE_ANON}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      })
      if (!res.ok) throw new Error(`get_reservoir_status_latest ${res.status}`)
      const rows = await res.json()
      const byName = {}
      let matched = 0
      for (const r of rows) {
        if (r.name != null && r.storage_ratio_pct != null) {
          byName[r.name] = Math.min(1, Math.max(0, r.storage_ratio_pct / 100))
          matched++
        }
      }
      console.info(`[layers] reservoir live ratios: ${matched} basins from Supabase`)
      return byName
    } catch (err) {
      console.warn('[layers] reservoir live-ratio fetch failed — falling back to full pool (1.0)', err)
      return {}
    }
  }
  let reservoirsFetch = { loading: false, loaded: false }
  async function loadReservoirsData() {
    if (reservoirsFetch.loading || reservoirsFetch.loaded) return
    reservoirsFetch.loading = true
    try {
      const [res, live] = await Promise.all([
        fetch(await manifestUrl('reservoirs', '/layers/reservoirs.json')),
        fetchReservoirRatios(),
      ])
      if (!res.ok) throw new Error(`reservoirs.json ${res.status}`)
      const data = await res.json()
      reservoirsLayer.setData(data.reservoirs, data.dams, live)
      reservoirsFetch.loaded = true
      reservoirsLayer.update(layerCtx())
    } catch (err) {
      console.warn('[layers] reservoirs fetch failed', err)
    } finally {
      reservoirsFetch.loading = false
      invalidate()
      emit('layers')
    }
  }

  // stationsLayer.onActivate — grouped one marker set per transit system.
  // Never rejects: a fetch failure just leaves the layer showing no sets
  // (console.warn + graceful "NO MARKER SETS" panel state), matching rail's
  // fail-quiet behavior.
  async function loadStationsData() {
    try {
      const res = await fetch(await manifestUrl('stations', '/layers/stations.json'))
      if (!res.ok) throw new Error(`stations.json ${res.status}`)
      const data = await res.json()
      for (const [systemId, sys] of Object.entries(data.systems)) {
        stationsLayer.setSet(systemId, { color: sys.color, visible: true, points: sys.points })
      }
      stationsLayer.update(layerCtx())
    } catch (err) {
      console.warn('[layers] stations fetch failed', err)
    } finally {
      invalidate()
      emit('layers')
    }
  }

  // trailSignsLayer.onActivate — one marker set ('signs', 3,407 points, single
  // baked color). Same fail-quiet deferred pattern as stations: a fetch
  // failure just leaves the layer showing no sets.
  async function loadTrailSignsData() {
    try {
      const res = await fetch(await manifestUrl('trail_signs', '/layers/trail_signs.json'))
      if (!res.ok) throw new Error(`trail_signs.json ${res.status}`)
      const data = await res.json()
      for (const [systemId, sys] of Object.entries(data.systems)) {
        trailSignsLayer.setSet(systemId, { color: sys.color, visible: true, points: sys.points })
      }
      trailSignsLayer.update(layerCtx())
    } catch (err) {
      console.warn('[layers] trail signs fetch failed', err)
    } finally {
      invalidate()
      emit('layers')
    }
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
    invalidate()
    const { x, z } = heightField.projection.lonLatToWorld(lon, lat)
    _flyOffset.subVectors(camera.position, controls.target) // keep the current view offset
    // resample ground height AT THE DESTINATION — reusing controls.target.y
    // (the departure altitude) stranded the camera over blank sea/tiles when
    // flying between very different elevations (e.g. 玉山 → 澎湖). If the
    // destination tile hasn't streamed yet terrain.sample() reports 0, which
    // is a safe underestimate: the anti-penetration floor in tick() (index.js
    // ~1609-1613) only ever raises target.y/camera.y, never lowers it.
    const y = terrain.sample ? terrain.sample(x, z) : controls.target.y
    const target = new THREE.Vector3(x, y, z)
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
    bathyDeepColor: () => terrain.rebuildRamp(params),
    bathyShallowColor: () => terrain.rebuildRamp(params),
    bathyCoastColor: () => terrain.rebuildRamp(params),
    // bathymetry: shading-only switch — terrain.js rebakes nothing (same
    // tiles, same chunk geometry always carries real GEBCO depth). Flips the
    // ramp canvas + uHeightRange/uSeaLevelY/uSeaSplit uniforms and nudges the
    // region sea-plane's opacity so it hides (off) or reveals (on) the
    // seafloor relief beyond the coastline. No chunk rebuild, no re-fetch.
    bathymetryVisible: (v) => {
      terrain.applyBathymetryShading(params)
      params.regionSeaOpacity = v ? 0.5 : 1.0
      layers.get('region').update(layerCtx())
      emit('layers') // refresh the Region panel's opacity slider to the new value
    },
    peakLimit: () => regenerateHud(),
    peakMinElev: () => regenerateHud(),
    peakRadiusKm: () => regenerateHud(),
    // overlay layers: visibility toggle just flips the group; style/geometry
    // params re-run the layer's full update (lazy build + vertical + material)
    labels: (v) => labelsLayer.setVisible(v),
    // coastline: off→on also kicks the outlying-island rings' deferred fetch
    // (loadCoastlineExtendedData no-ops once loaded/in-flight) — the layer
    // shows its (possibly still main-ring-only) geometry immediately either way.
    coastline: (v) => {
      if (v) loadCoastlineExtendedData()
      layers.get('coastline').update(layerCtx())
    },
    coastlineWidth: () => layers.get('coastline').update(layerCtx()),
    coastlineOpacity: () => layers.get('coastline').update(layerCtx()),
    coastlineColor: () => layers.get('coastline').update(layerCtx()),
    counties: () => layers.get('counties').update(layerCtx()),
    countiesWidth: () => layers.get('counties').update(layerCtx()),
    countiesOpacity: () => layers.get('counties').update(layerCtx()),
    countiesColor: () => layers.get('counties').update(layerCtx()),
    // rail: first switch-on triggers the deferred fetch (loadRailData no-ops
    // once loaded/in-flight); the layer shows its (possibly still empty)
    // geometry immediately either way, exactly like coastline/counties.
    railVisible: (v) => {
      if (v) loadRailData()
      layers.get('rail').update(layerCtx())
    },
    railWidth: () => layers.get('rail').update(layerCtx()),
    railOpacity: () => layers.get('rail').update(layerCtx()),
    // OSM roads: no deferred JSON fetch to kick — the PMTiles manager streams
    // tiles itself once switched on (see vectortiles.js). update() just
    // (re)applies the gate/style; the manager's own setEnabled starts/stops
    // the per-frame tile streaming (layers.get('osm_roads').tickView).
    osmRoadsVisible: () => layers.get('osm_roads').update(layerCtx()),
    osmRoadsWidth: () => layers.get('osm_roads').update(layerCtx()),
    osmRoadsOpacity: () => layers.get('osm_roads').update(layerCtx()),
    // trails: same deferred-fetch pattern as rail; unlike rail this one has a
    // color param (every trail shares one baked color, no per-line override)
    trailsVisible: (v) => {
      if (v) loadTrailsData()
      layers.get('trails').update(layerCtx())
    },
    trailsWidth: () => layers.get('trails').update(layerCtx()),
    trailsOpacity: () => layers.get('trails').update(layerCtx()),
    trailsColor: () => layers.get('trails').update(layerCtx()),
    // rivers: ONE toggle brings up the whole layer — the river-name labels +
    // water-surface sheet (deferred fetch) and the physics river-body tint
    // (deferred PNG fetch, via applyRiverSim). Same fail-quiet deferred pattern
    // as rail; the sim uniform stays 0 until its texture lands (zero-cost off).
    riversVisible: (v) => {
      if (v) loadRiversData()
      layers.get('rivers').update(layerCtx())
      applyRiverSim()
    },
    // 顏色 feeds BOTH the sim tint (uRiverSimColor) and the surface sheet
    riversColor: () => {
      layers.get('rivers').update(layerCtx())
      applyRiverSim()
    },
    riversSurfaceOpacity: () => layers.get('rivers').update(layerCtx()),
    riverNames: () => layers.get('rivers').update(layerCtx()),
    // 河川濃度: the physics river-body tint density (uRiverSimOpacity). Re-runs
    // applyRiverSim, which no-ops the uniform until the texture has landed.
    riverSimOpacity: () => applyRiverSim(),
    // reservoirs: first switch-on fetches basins + live storage ratios; the
    // ratio slider drives a global manual override across every water surface
    reservoirsVisible: (v) => {
      if (v) loadReservoirsData()
      reservoirsLayer.update(layerCtx())
    },
    reservoirsRatio: (v) => reservoirsLayer.setManualRatio(v / 100),
    reservoirsOpacity: () => reservoirsLayer.update(layerCtx()),
    reservoirsColor: () => reservoirsLayer.update(layerCtx()),
    // farm: whole-island physics-derived farmland tint (terrain.js uFarmTex).
    // INDEPENDENT of rivers/reservoirs — agriculture, not hydrology. First
    // switch-on triggers the deferred PNG fetch (applyFarmSim no-ops the
    // uniform until it lands); style params just re-apply the uniforms.
    farmVisible: () => applyFarmSim(),
    farmOpacity: () => applyFarmSim(),
    farmColor: () => applyFarmSim(),
    // irrigation: manifest-driven deferred polyline layer, same deferred-fetch
    // pattern as trails; one shared baked color (no per-line vertexColors —
    // see loadIrrigationData / polyline.js createIrrigationLayer)
    irrigationVisible: (v) => {
      if (v) loadIrrigationData()
      layers.get('irrigation').update(layerCtx())
    },
    irrigationWidth: () => layers.get('irrigation').update(layerCtx()),
    irrigationOpacity: () => layers.get('irrigation').update(layerCtx()),
    irrigationColor: () => layers.get('irrigation').update(layerCtx()),
    // ftw fields: no deferred JSON fetch — same PMTiles-streams-itself pattern
    // as osmRoadsVisible above (see vectortiles.js createFtwFieldsLayer)
    ftwFieldsVisible: () => ftwFieldsLayer.update(layerCtx()),
    ftwFieldsOpacity: () => ftwFieldsLayer.update(layerCtx()),
    // region: first switch-on fetches the neighbouring coastlines (deferred);
    // the sea plane + style params re-run the layer's update
    regionVisible: (v) => {
      if (v) loadRegionData()
      layers.get('region').update(layerCtx())
    },
    regionSeaColor: () => layers.get('region').update(layerCtx()),
    regionSeaOpacity: () => layers.get('region').update(layerCtx()),
    regionLineColor: () => layers.get('region').update(layerCtx()),
    regionLineWidth: () => layers.get('region').update(layerCtx()),
    regionLineOpacity: () => layers.get('region').update(layerCtx()),
    // typhoon: procedural vortex cloud sheet — every param just re-runs the
    // layer's update (visibility gate + place/scale + shader-uniform style)
    typhoonVisible: () => layers.get('typhoon').update(layerCtx()),
    typhoonOpacity: () => layers.get('typhoon').update(layerCtx()),
    typhoonRadiusKm: () => layers.get('typhoon').update(layerCtx()),
    typhoonSpin: () => layers.get('typhoon').update(layerCtx()),
    typhoonEyeSize: () => layers.get('typhoon').update(layerCtx()),
    typhoonHeight: () => layers.get('typhoon').update(layerCtx()),
    typhoonDensity: () => layers.get('typhoon').update(layerCtx()),
    typhoonLon: () => layers.get('typhoon').update(layerCtx()),
    typhoonLat: () => layers.get('typhoon').update(layerCtx()),
    typhoonColor: () => layers.get('typhoon').update(layerCtx()),
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
    if (keys.some((k) => LAYER_KEYS.has(k))) {
      emit('layers') // dynamic panel refresh
      if (activePick) closePickIfLayerHidden(activePick.layerId) // e.g. trailsVisible:false while its popup is open
    }
    invalidate() // any settings change must repaint, even from a frozen idle frame
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

  // ---------------------------------------------------------------- layer pick (click popup)
  // Click-only feature picking (never hover — an on-demand render app can't
  // afford a per-frame raycast). pointerdown/up are measured for drag
  // distance so an OrbitControls orbit/pan never fires a pick; only a
  // pointerdown that STARTED on the canvas (not a UI panel) is a candidate.
  // A hit walks the LayerManager's registered layers via layers.pickAll (see
  // layers.js for the raycaster conventions — camera/params.Line2/pickPx) and
  // opens the React popup card; a miss (empty-canvas click) closes it.
  const pickRaycaster = new THREE.Raycaster()
  pickRaycaster.params.Line2 = { threshold: 10 } // px, added to the line's own linewidth (draped lines render 0.5–6px wide — too thin to click as-is)
  const _pickNdc = new THREE.Vector2()
  const PICK_DRAG_TOLERANCE_PX = 5 // pointerdown→up movement above this reads as a camera drag, not a click
  let pickDownPos = null
  let pickDownOnCanvas = false
  let activePick = null // { title, rows, worldPos, layerId } | null — the popup's current content

  function clearPick() {
    if (!activePick) return
    activePick = null
    emit('pick', null)
    invalidate()
  }
  // closes the popup if it belongs to a layer that just got hidden (toggle
  // off in the Layers panel, "ALL OFF", or a theme master switch) — checked
  // generically off describe().visible so it works for both param-backed
  // layers (setLayerVisible/setParams) and marker-set layers (setLayerSet)
  function closePickIfLayerHidden(id) {
    if (!activePick || !id || activePick.layerId !== id) return
    const layer = layers.get(id)
    if (!layer || !layer.describe().visible) clearPick()
  }
  function onPickPointerDown(e) {
    pickDownOnCanvas = e.target === stage.renderer.domElement
    pickDownPos = { x: e.clientX, y: e.clientY }
  }
  function onPickPointerUp(e) {
    if (!pickDownOnCanvas || !pickDownPos) return
    const dx = e.clientX - pickDownPos.x
    const dy = e.clientY - pickDownPos.y
    pickDownPos = null
    if (Math.hypot(dx, dy) > PICK_DRAG_TOLERANCE_PX) return // camera drag, not a click
    _pickNdc.set((e.clientX / window.innerWidth) * 2 - 1, -((e.clientY / window.innerHeight) * 2 - 1))
    pickRaycaster.setFromCamera(_pickNdc, camera) // also sets pickRaycaster.camera (used by Line2 + markers.pick)
    pickRaycaster.pickPx = { x: e.clientX, y: e.clientY } // markers.js pick(): screen-space hit test for tiny instanced dots
    const hit = layers.pickAll(pickRaycaster)
    if (hit) {
      activePick = { title: hit.title, rows: hit.rows, worldPos: hit.worldPos.clone(), layerId: hit.layerId }
      emit('pick', { title: hit.title, rows: hit.rows, layerId: hit.layerId })
    } else {
      activePick = null
      emit('pick', null)
    }
    invalidate()
  }
  window.addEventListener('pointerdown', onPickPointerDown)
  window.addEventListener('pointerup', onPickPointerUp)

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
  let tourWasActive = false // 'tour' event edge-detect — covers natural finish, stopTour, and controls-drag cancel alike
  let rafId = 0
  let disposed = false

  const _proj = new THREE.Vector3()
  function project(world, w, h) {
    _proj.copy(world).project(camera)
    return { x: (_proj.x * 0.5 + 0.5) * w, y: (-_proj.y * 0.5 + 0.5) * h, visible: _proj.z < 1 }
  }
  const _sph = new THREE.Spherical()
  const _rel = new THREE.Vector3()

  // any live animation forces a render regardless of the activity window.
  // Procedural mode + the pre-DEM real load have permanent platform/cone motion
  // (or nothing settled yet) so they're always "animating" and never idle.
  function isAnimating() {
    if (params.source !== 'real' || !heightField) return true
    return (
      params.typhoonVisible || // procedural storm swirls every frame while visible
      motion.tourActive ||
      motion.tweenActive ||
      scanStart >= 0 ||
      rebuildPending ||
      chunkManager.queue.length > 0 ||
      hud3.pulseActive()
    )
  }

  // CPU-only HUD payload (screen projections + telemetry). Cheap enough to reuse
  // verbatim from the idle path at 2 Hz so the T+ clock and telemetry keep
  // ticking with the composer parked. Camera is static in idle, so last frame's
  // matrices are still valid.
  function emitFrame(dt, t) {
    const w = window.innerWidth
    const h = window.innerHeight
    _sph.setFromVector3(_rel.copy(camera.position).sub(controls.target))
    const secs = Math.floor(t)
    emit('frame', {
      dt,
      reticle: project(cone.getFocusPoint(), w, h),
      poiScreens: pois.map((p) => project(p.top, w, h)),
      // layer-pick popup screen anchor (see 'layer pick' section above) — a
      // cheap re-project each frame, exactly like reticle/poiScreens, so the
      // React card tracks the world position as the camera moves/idles
      pick: activePick ? project(activePick.worldPos, w, h) : null,
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

  function renderFrame(dt) {
    stage.composer.render(dt)
    renderCount++
  }

  // Freeze: bump to native DPR for a Retina-sharp still, draw exactly one frame
  // at that resolution, then park. setPixelRatio reallocates the composer
  // buffers, so this cost lands once per idle transition — never mid-interaction.
  function enterIdle(dt) {
    if (IDLE_PIXEL_RATIO > params.pixelRatio + 1e-3) {
      stage.setPixelRatio(IDLE_PIXEL_RATIO)
      pixelBumped = true
    }
    camera.updateMatrixWorld()
    renderFrame(dt) // the already-settled scene, unchanged — just sharper
    idle = true
    idleFrameAcc = 0
  }

  // Thaw on the next invalidate: restore the interactive (lower) pixel ratio so
  // live frames stay cheap. The active tick that follows renders at that ratio.
  function exitIdle() {
    if (pixelBumped) {
      stage.setPixelRatio(params.pixelRatio)
      pixelBumped = false
    }
    idle = false
  }

  function tick() {
    if (disposed) return
    rafId = requestAnimationFrame(tick)
    const dt = Math.min(clock.getDelta(), 0.05)
    const t = clock.elapsedTime

    // on-demand gate: render while an animation runs OR the activity window is
    // open. Animating frames roll the window forward so any motion always gets a
    // full ACTIVE_WINDOW_MS tail (damping, settle) before the loop can idle.
    const animating = isAnimating()
    if (animating) invalidate()
    if (!animating && performance.now() >= activeUntil) {
      if (!idle) {
        enterIdle(dt) // one Retina still, then park
      } else {
        idleFrameAcc += dt
        if (idleFrameAcc >= 0.5) {
          idleFrameAcc = 0
          if (params.hud) emitFrame(dt, t) // ~2 Hz: keep T+ clock / telemetry alive
        }
      }
      return
    }
    if (idle) exitIdle()

    // camera motion: tour > fly tween > free navigation (with pan clamp)
    if (!motion.tick(dt)) {
      keyPan.tick(dt) // arrow/WASD velocity, applied before damping + clamp
      controls.update()
      stage.clampPan() // free navigation only — tours / fly-tos manage their own path
      // anti-penetration: floor the camera to the ground sample right below it
      // + a small margin, so dollying/panning close to a slope can't dig into
      // the mesh. Cheap XZ-only check (no ray march) — good enough since the
      // camera moves continuously and this runs every frame. Also floors
      // controls.target: a flyTo (e.g. selectPoi) that ends with a bad target
      // altitude — pos and target are set once at flyTo() time, not touched
      // again until here — gets caught the very first free-nav frame after
      // the tween ends (motion.tick() starts returning false again). This
      // block only runs outside tour/fly-to (guarded by `!motion.tick(dt)`
      // above), so it never fights Tour's self-managed path.
      if (terrain.sample) {
        const minY = terrain.sample(camera.position.x, camera.position.z) + CAMERA_GROUND_MARGIN
        if (camera.position.y < minY) camera.position.y = minY
        const minTy = terrain.sample(controls.target.x, controls.target.z) + CAMERA_GROUND_MARGIN
        if (controls.target.y < minTy) controls.target.y = minTy
      }
    } else {
      keyPan.reset() // no residual glide fighting an active tour/fly-to
    }

    // tour state, edge-detected off motion.tourActive — a single source of
    // truth that catches start, natural finish, stopTour() and the
    // controls-drag cancel path (index.js 'start' listener → motion.cancel())
    // alike, without duplicating state. flyTo tweens don't touch tourActive,
    // so they never trigger this.
    if (motion.tourActive !== tourWasActive) {
      tourWasActive = motion.tourActive
      invalidate() // keep rendering through the tour→free-nav handoff settle
      emit('tour', { active: tourWasActive })
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
    layers.tickAll(layerCtx(dt)) // anti-z-fight lift tracks the view scale; marker dot rescale / tag crowd control
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
      emitFrame(dt, t)
    }

    // coarse stats for non-per-frame consumers (sidebars, debugging)
    statsAcc += dt
    if (statsAcc > 1) {
      statsAcc = 0
      emit('stats', stats())
    }

    renderFrame(dt)
  }

  // ---------------------------------------------------------------- facade

  // shared by setMarkerSet (always targets the generic 'markers' layer) and
  // the panel's per-system station toggles (setLayerSet) — any point-kind
  // layer exposing setSet/update can be addressed by id this way.
  function setLayerSet(layerId, setId, def) {
    const layer = layers.get(layerId)
    if (!layer?.setSet) return
    layer.setSet(setId, def)
    layer.update?.(layerCtx()) // builds now if the world exists
    invalidate()
    emit('layers') // set list/visibility changed → refresh the panel
    closePickIfLayerHidden(layerId) // e.g. the popup's station system just got toggled off
  }

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
    // async planning: pre-stream the route's tiles, build + collision-verify the
    // spline, then commit. Emits 'tour' {planning:true} up front so the panel can
    // show a loading state; the tick's edge-detect emits {active} on begin/finish.
    async startTour(opts = {}) {
      if (opts.from !== undefined) params.tourFrom = opts.from
      if (opts.to !== undefined) params.tourTo = opts.to
      if (opts.mode !== undefined) params.tourMode = opts.mode
      if (opts.contourOffset !== undefined) params.contourOffset = opts.contourOffset
      invalidate()
      emit('tour', { active: false, planning: true })
      const plan = await motion.planTour(opts)
      if (!plan) {
        emit('tour', { active: false, planning: false })
        return false
      }
      clearTourPreview()
      invalidate()
      const ok = motion.beginTour(plan)
      emit('tour', { active: ok, planning: false })
      if (ok) console.info('[tour] plan', plan.summary)
      return ok
    },
    // planned-route preview line (Tour panel). Returns the plan summary.
    previewTour(opts = {}) {
      return doTourPreview(opts)
    },
    clearTourPreview() {
      clearTourPreview()
    },
    stopTour() {
      invalidate() // render the settle-out after the tour hands back
      motion.stopTour()
    },
    selectPoi,
    deselect,
    triggerScan,
    // generic marker sets (pure display layer — see markers.js). Same id
    // with `points` replaces the set; without `points` patches color/visible.
    setMarkerSet(id, def) {
      setLayerSet('markers', id, def)
    },
    removeMarkerSet(id) {
      invalidate()
      const removed = pointLayer.removeSet(id)
      emit('layers')
      return removed
    },
    listMarkerSets() {
      return pointLayer.listSets()
    },
    // generic version of setMarkerSet for any point-kind layer registered
    // under the LayerManager (e.g. 'stations' — one set per transit system).
    // The Layers panel's per-set toggle rows call this with the owning
    // layer's id so they route to the right marker-set collection.
    setLayerSet,
    // dynamic layer registry (Layers panel). listLayers() → describe() array;
    // setLayerVisible/setLayerStyle route param-backed layers through setParams
    // (so HANDLERS + invalidate + panel refresh all fire on the one path).
    listLayers() {
      return layers.describe()
    },
    setLayerVisible(id, v) {
      const layer = layers.get(id)
      if (!layer) return
      // param-backed layers route through setParams (which already closes a
      // matching popup — see LAYER_KEYS check above); the marker-set branch
      // below has no bulk visibility of its own (setVisible only triggers the
      // one-shot onActivate fetch) but checks too, for symmetry
      if (layer.visibleParam) setParams({ [layer.visibleParam]: v })
      else {
        layer.setVisible?.(v)
        emit('layers')
        invalidate()
        closePickIfLayerHidden(id)
      }
    },
    setLayerStyle(id, patch) {
      const layer = layers.get(id)
      if (!layer) return
      if (layer.paramMap) {
        const mapped = {}
        for (const k in patch) if (layer.paramMap[k]) mapped[layer.paramMap[k]] = patch[k]
        setParams(mapped)
      } else {
        layer.setStyle?.(patch)
        emit('layers')
        invalidate()
      }
    },
    // layer-pick popup: X button / any other explicit close (see LayerPickCard.jsx)
    clearPick() {
      clearPick()
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(rafId)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('pointerdown', onPickPointerDown)
      window.removeEventListener('pointerup', onPickPointerUp)
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
        return labelsLayer.renderGroup
      },
      layers,
      get heightField() {
        return heightField
      },
      get fps() {
        return fps
      },
      // on-demand render verify hooks: renderCount stops climbing once idle,
      // resumes the instant an invalidate lands
      get renderCount() {
        return renderCount
      },
      get idle() {
        return idle
      },
      invalidate,
      stats,
    },
  }
  engine.debug.engine = engine

  // real world is the default source — fetch its tiles on startup (not
  // awaited: the engine renders + streams while tiles arrive, exactly like
  // the pre-facade behavior; progress surfaces through 'loading' events)
  if (params.source === 'real') loadRealTerrain()

  tick()

  return engine
}
