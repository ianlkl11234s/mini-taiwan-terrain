import * as THREE from 'three'
import { Terrain } from './terrain.js'
import { LayerManager } from './layers.js'
import { createCoastlineLayer, createCountiesLayer, createRailLayer, createRiversLayer, createIrrigationLayer } from './polyline.js'
import { createPointLayer } from './markers.js'
import { createReservoirLayer } from './water.js'
import { createTyphoonLayer } from './typhoon.js'
import { createTrainsLayer } from './trains.js'
import { createShipsLayer, parseTrailString, filterGpsAnomalies } from './ships.js'
import { createRegionLayer } from './region.js'
import { createLabelsLayer } from './labels.js'
import { createOsmRoadsLayer, createTrailsLayer, createFtwFieldsLayer, createBuildingsLayer } from './vectortiles.js'
import { createAirspaceLayer } from './airspace.js'
import { createPowerTowersLayer, createWindTurbinesLayer } from './energy.js'
import { createMedicalLayer } from './medical.js'
import { createCone } from './cone.js'
import { createHud3D, findPois } from './hud3d.js'
import * as timeStore from '../state/timeStore.js'
import { makeProjection, HeightField, TAIWAN_BBOX, worldYScale, metersToWorldY } from './geo.js'
import { ChunkManager } from './chunks.js'
import { findRealPeaks } from './peaks.js'
import { createStage, LOD_MIN, LOD_MAX, LOD_D0 } from './scene.js'
import { createMotion } from './tour.js'
import { createFollow } from './follow.js'
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
//   - engine.followEntity(layerId, entityId) / stopFollow() — camera follow
//     (src/engine/follow.js, docs/FOLLOW_CAMERA_DESIGN.md); a layer opts in by
//     implementing getEntityPosition(entityId) and returning `followable:
//     {layerId, entityId}` from its pick() payload (see trains.js)
//   - engine.on(event, cb) — 'frame' 'stats' 'gps' 'pois' 'selection' 'loading' 'params' 'follow'
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
  // real-world scale by default: horizontal and vertical share ONE world
  // unit (≈ 480.78 m — see geo.js's K_ANCHOR comment) — 2026-07-11 user-
  // specified default (docs/MARINE_DESIGN.md §0, was 1.6/exaggerated). The
  // Settings 垂直放大 slider (0.5–5) still goes up to the old look, one drag
  // away — this default only changes what loads on boot.
  demExaggeration: 1.0,
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
  // No re-fetch, no chunk rebuild. Default ON (2026-07-11 user default) —
  // open ocean shows the (white-shaded) seafloor relief immediately on load;
  // land rendering is unaffected either way since depth is baked into the
  // mesh regardless of this toggle. See regionSeaOpacity below: its default
  // is kept in sync with what this toggle's HANDLER would set, so boot state
  // matches post-toggle state without needing to flip it once.
  bathymetryVisible: true,
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
  // trains: manifest-driven deferred layer — real TRA (台鐵) timetable (992
  // trains, scripts/bake_trains.py) animated as light dots gliding along the
  // rail_lines.json tra polylines, driven by the timeline's time store (see
  // src/state/timeStore.js, docs/TIMELINE_DESIGN.md) instead of the live wall
  // clock. Default off; toggling it on keeps the render loop non-idle
  // (isAnimating), same as typhoon, but only while the timeline is ALSO
  // playing (see isAnimating() below) — positions only advance when
  // timeStore.getPlaying() is true.
  trainsVisible: false,
  trainsColor: '#ffcf40',
  trainsSize: 1.0,
  trainsOpacity: 0.95,
  // thsr: second createTrainsLayer instance (src/engine/trains.js — the
  // factory is parametrized by id/rowLabel/railNetwork/maxInstances/
  // singleCorridor) — same manifest-driven deferred + timeline-clock pattern
  // as trains above, fed thsr_tracks.json/thsr_schedule.json (212 trains,
  // scripts/bake_trains.py's bake_thsr()) filtered to rail_lines.json's
  // system=='thsr' polylines instead of 'tra'. THSR orange keeps it visually
  // distinct from TRA's yellow at a glance.
  thsrVisible: false,
  thsrColor: '#ff7f2a',
  thsrSize: 1.0,
  thsrOpacity: 0.95,
  // ships: AIS-tracked light dots (src/engine/ships.js) — a third timeline-
  // driven track layer alongside trains/thsr, but keyed on absolute unix-
  // epoch seconds (one calendar day's real trail) instead of a daily-
  // repeating schedule. Deferred: first switch-on loads the current
  // timeline date's trails (CDN snapshot → RPC fallback) and subscribes to
  // future date changes — see docs/MARINE_DESIGN.md §1.2 and the
  // shipsVisible HANDLER below. Navy-blue default keeps it visually distinct
  // from TRA yellow / THSR orange.
  shipsVisible: false,
  shipsColor: '#3a6ea5',
  shipsSize: 1.0,
  shipsOpacity: 0.95,
  // OSM roads: PMTiles-streamed vector-tile line layer (docs/VECTOR_TILES_DESIGN.md)
  // — NOT a manifest-driven JSON fetch like rail; the manager (vectortiles.js
  // VectorTileManager) streams tiles from the R2-hosted osm_road_drive.pmtiles
  // archive as the camera pans, only once switched on. Phase 2: highway-class
  // width/color buckets baked per-class into vertexColors (see vectortiles.js
  // ROAD_STYLE) — no single color swatch; width/opacity stay as global
  // multipliers on top of the buckets.
  osmRoadsVisible: false,
  osmRoadsWidth: 1.5,
  osmRoadsOpacity: 0.85,
  // trails: PMTiles-streamed vector-tile line layer, same pattern as osmRoads
  // above (vectortiles.js createTrailsLayer, hiking_trails.pmtiles — 7,339
  // lines from 6 merged sources, superseding the 2026-07-10 49-trail baked-
  // JSON version). Unlike roads there's no per-class bucketing, so — like the
  // old baked layer — every trail shares ONE color param.
  trailsVisible: false,
  trailsWidth: 2,
  trailsOpacity: 0.9,
  trailsColor: '#ff7a1a',
  // point-layer styleSchema defaults (markers.js createPointLayer's size/
  // opacity sliders — POINT_STYLE). Key names are derived from each layer's
  // id (${id}Size/${id}Opacity — see createPointLayer). 1.0/0.9 match the
  // hardcoded pre-slider defaults (DOT_R multiplier / dot material opacity),
  // so adding these sliders is a no-op on first load.
  stationsSize: 1.0,
  stationsOpacity: 0.9,
  markersSize: 1.0,
  markersOpacity: 0.9,
  // basic POI point packs (bake_poi_layers.py) — same size/opacity slider
  // convention as stations/markers above. fire_stations/police_stations use
  // an explicit sizeParam/opacityParam override (createPointLayer's default
  // `${id}Size` would read oddly off a snake_case id), everything else uses
  // the default derived key.
  airportsSize: 1.0,
  airportsOpacity: 0.9,
  portsSize: 1.0,
  portsOpacity: 0.9,
  fireStationsSize: 1.0,
  fireStationsOpacity: 0.9,
  hospitalsSize: 1.0,
  hospitalsOpacity: 0.9,
  policeStationsSize: 1.0,
  policeStationsOpacity: 0.9,
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
  // buildings: PMTiles-streamed vector-tile POLYGON layer, same streamed-not-
  // manifest pattern as osmRoadsVisible/ftwFieldsVisible above, but extruded
  // into flat-topped 3D boxes (GBA/TUM LoD1 footprints, see vectortiles.js
  // createBuildingsLayer). z13 is the source archive's own minzoom — see that
  // module's file header for why this layer alone needs a hard lodZoom gate.
  // Fill color is a baked per-vertex height-band ramp (design handoff); 不透明度
  // is the only style param, default just under fully opaque.
  buildingsVisible: false,
  buildingsOpacity: 0.95,
  // airspace: baked-JSON polygon-extrusion layer (src/engine/airspace.js,
  // public/layers/airspace.json — bake_airspace.py's P/R/D-filtered 31 zones
  // out of the source 81). 0.25 default so the stacked walls of overlapping
  // zones don't read as a solid opaque blob (design brief).
  airspaceVisible: false,
  airspaceOpacity: 0.25,
  // power towers / wind turbines: InstancedMesh point layers with real 3D
  // silhouettes (src/engine/energy.js), gated to near-view only (see that
  // module's camDist hysteresis) — size scales footprint only, never true
  // height (matches trains.js's widthM/heightM convention).
  powerTowersVisible: false,
  powerTowersSize: 1.0,
  powerTowersOpacity: 0.9,
  windTurbinesVisible: false,
  windTurbinesSize: 1.0,
  windTurbinesOpacity: 0.95,
  // region: neighbouring coastlines (outlying islands, N Philippines, Ryukyus,
  // S Japan, S Korea, SE China) as flat strokes over a sea-coloured plane —
  // geographic context beyond the Taiwan DEM footprint (src/engine/region.js).
  // Deferred: public/layers/region_coast.json fetched on first switch-on.
  regionVisible: false,
  regionSeaColor: '#c2e0ff', // light blue sea (user default, RGB 194 224 255)
  // 0.5 to match bathymetryVisible's default-on state (the bathymetryVisible
  // HANDLER sets the same 0.5 whenever it's toggled on, so the semi-
  // transparent plane reveals the relief beneath it — see
  // docs/BATHYMETRY_DESIGN.md §2.5); toggling bathymetry off flips this back
  // to 1.0 via that same HANDLER.
  regionSeaOpacity: 0.5,
  regionLineColor: '#303030', // dark-grey coastline (user default, RGB 48 48 48)
  regionLineWidth: 1.3,
  regionLineOpacity: 0.9,
  // sea ripple decoration (docs/MARINE_DESIGN.md §2): fragment-only
  // onBeforeCompile injection on the region sea plane's OWN MeshBasicMaterial
  // (region.js) — fresnel sky-tint + faint specular glint from a few
  // scrolling analytic sine fields, no vertex displacement (this repo's
  // ~480 m/world-unit scale makes real wave amplitude sub-pixel). seaAnimated
  // keeps the render loop non-idle while on (isAnimating() below) — a
  // wall-clock decoration, NOT gated on the timeline, same as typhoon.
  seaAnimated: true,
  seaRippleStrength: 0.3,
  seaRippleSpeed: 1.0,
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
  // ships' CDN snapshot base — same build-time env var + local-dev fallback
  // as dem.js's TILE_BASE (VITE_TILE_BASE unset in dev → '/tiles', which
  // 404s locally since no snapshot has been baked there yet, correctly
  // falling through to the RPC path below — see loadShipsForDate).
  const SHIPS_TILE_BASE = import.meta.env.VITE_TILE_BASE ?? '/tiles'

  // shared Supabase anon-key access (mini-taiwan-pulse's project,
  // read-only public.* RPCs only — repo rule: never realtime.* from the
  // frontend). Originally reservoirs-only, private to that block; hoisted
  // here (2026-07-11, docs/MARINE_DESIGN.md §1.1) so ships' RPC fallback
  // reuses it too instead of a second declaration.
  const SUPABASE_URL = 'https://utcmcikhvxnohbxchbrs.supabase.co'
  const SUPABASE_ANON =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV0Y21jaWtodnhub2hieGNoYnJzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ1NjgyMDMsImV4cCI6MjA5MDE0NDIwM30.rQSjJ6WD53p9tRZ6M7xleDelktVHfKeZFGPC2ItULVQ'

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
  // timeline: every discrete change (seek/play/pause/setSpeed) reopens the
  // render window so trains (and future time-aware layers) redraw at the new
  // time before parking again — see docs/TIMELINE_DESIGN.md §2.2. Playback
  // itself doesn't spam this (timeStore.subscribe only fires on discrete
  // changes, not per notifier tick), so this never fights isAnimating().
  const offTimeStore = timeStore.subscribe(() => invalidate())

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
  // raw camera-target distance (world units), refreshed once per tick() —
  // see its computation below at the P2 distance-LOD block. Separate from
  // fogScale because fogScale clamps to 1 across the whole near range (see
  // scene.js), too coarse for trains.js's near-view car-chain LOD to use.
  // Layers that only run inside tick() (tickAll) always see the current
  // frame's value; the rarer update()-only call sites just see the last one.
  let lastCamDist = LOD_D0

  // fresh per-call snapshot of the live world state every layer reads from
  function layerCtx(dt = 0) {
    return {
      params,
      heightField,
      projection: heightField ? heightField.projection : null,
      camera,
      fogScale: stage.fogScale,
      camDist: lastCamDist,
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
  // hidden: true — no UI ever calls setMarkerSet (console/scripting escape
  // hatch only, see engine.setMarkerSet/removeMarkerSet/listMarkerSets below),
  // so the Layers panel omits its row entirely (see Layers.jsx's hidden
  // filter). The layer itself stays fully registered/functional — build/
  // update/tickView still run and setMarkerSet still creates real 3D markers.
  const pointLayer = createPointLayer(params, { hidden: true }) // marker sets — imperative set API preserved
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
  // basic POI point packs (bake_poi_layers.py) — same deferred onActivate
  // pattern as stations/trail_signs above (fetch public/layers/<id>.json on
  // first switch-on, group into one setSet() call per bake-time "system").
  // ports/hospitals split into several sets (port_class_group / level) whose
  // ids are ALREADY the Chinese display string (see bake script), so no
  // separate label-lookup table like STATION_SYSTEM_LABELS is needed; the
  // set id is used directly in pickRows.
  const airportsLayer = createPointLayer(params, {
    id: 'airports',
    label: 'Airports',
    rowLabel: '機場 Airports',
    onActivate: () => loadPoiData('airports', airportsLayer),
    pickRows: (pt) => [
      ['名稱 Name', pt.name || '—'],
      ['ICAO', pt.icao || '—'],
      ['IATA', pt.iata || '—'],
      ['類型 Type', pt.type || '—'],
      ['高度 Elevation', pt.elevFt != null ? `${pt.elevFt} ft` : '—'],
    ],
  })
  const portsLayer = createPointLayer(params, {
    id: 'ports',
    label: 'Ports',
    rowLabel: '港口 Ports',
    onActivate: () => loadPoiData('ports', portsLayer),
    pickRows: (pt, setId) => [
      ['名稱 Name', pt.name || '—'],
      ['分類 Class', setId],
      ['等級 Grade', pt.class || '—'],
      ['縣市 County', pt.county || '—'],
    ],
  })
  const fireStationsLayer = createPointLayer(params, {
    id: 'fire_stations',
    label: 'Fire Stations',
    rowLabel: '消防分隊 Fire Stations',
    onActivate: () => loadPoiData('fire_stations', fireStationsLayer),
    sizeParam: 'fireStationsSize',
    opacityParam: 'fireStationsOpacity',
    pickRows: (pt) => [
      ['名稱 Name', pt.name || '—'],
      ['類型 Type', pt.type || '—'],
      ['地址 Address', pt.address || '—'],
    ],
  })
  const hospitalsLayer = createPointLayer(params, {
    id: 'hospitals',
    label: 'Hospitals',
    rowLabel: '急救醫院 Hospitals',
    onActivate: () => loadPoiData('hospitals', hospitalsLayer),
    pickRows: (pt, setId) => [
      ['名稱 Name', pt.name || '—'],
      ['分級 Level', setId],
      ['外傷中心 Trauma', pt.trauma ? '是 Yes' : '否 No'],
      ['中風中心 Stroke', pt.stroke ? '是 Yes' : '否 No'],
      ['地址 Address', pt.address || '—'],
    ],
  })
  // F 醫療設施 POI: the full national NHI-contracted institution roll
  // (bake_medical_poi.py -> medical.json, R2-hosted — see manifest entry and
  // that bake script's docstring for the "42MB source" investigation and the
  // 2-8MB-bracket R2 decision). Complements, does not replace, hospitalsLayer
  // above (232 emergency-responsible hospitals only) — registered right after
  // it for the same panel-proximity reasoning as thsr/ships elsewhere in this
  // list. NOT a createPointLayer: see src/engine/medical.js module header for
  // why (21,765 診所 alone is too many for markers.js's always-resident-dots
  // convention — this follows energy.js's InstancedMesh+grid-gather playbook
  // instead), but it still exposes the same `sets` panel contract (describe/
  // setSet) as ports/hospitals so 醫院/診所/藥局 get independent toggles.
  const medicalLayer = createMedicalLayer(params, {
    onActivate: () => loadMedicalData(),
  })
  // police_stations.json's facility_subtype is the raw English source enum
  // (police_justice/police_stations pipeline) — same bilingual-label-lookup
  // pattern as STATION_SYSTEM_LABELS/HIGHWAY_LABELS above, a tag missing from
  // this table just shows the raw string instead of blowing up.
  const POLICE_SUBTYPE_LABELS = {
    headquarters: '警察局本部 HQ',
    police_dept: '警察局 Dept',
    precinct: '分局 Precinct',
    substation: '派出所 Substation',
    specialized: '專業警察 Specialized',
    other: '其他 Other',
  }
  const policeLayer = createPointLayer(params, {
    id: 'police_stations',
    label: 'Police',
    rowLabel: '警察機關 Police',
    onActivate: () => loadPoiData('police_stations', policeLayer),
    sizeParam: 'policeStationsSize',
    opacityParam: 'policeStationsOpacity',
    pickRows: (pt) => [
      ['名稱 Name', pt.name || '—'],
      ['類型 Type', POLICE_SUBTYPE_LABELS[pt.subtype] ?? pt.subtype ?? '—'],
      ['地址 Address', pt.address || '—'],
    ],
  })
  const labelsLayer = createLabelsLayer(params)
  const reservoirsLayer = createReservoirLayer(params)
  const osmRoadsLayer = createOsmRoadsLayer(params, { invalidate })
  const trailsLayer = createTrailsLayer(params, { invalidate })
  const ftwFieldsLayer = createFtwFieldsLayer(params, { invalidate })
  const buildingsLayer = createBuildingsLayer(params, { invalidate })
  const airspaceLayer = createAirspaceLayer(params)
  const powerTowersLayer = createPowerTowersLayer(params)
  const windTurbinesLayer = createWindTurbinesLayer(params)
  const shipsLayer = createShipsLayer(params)
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
  // basic public-safety POI packs (bake_poi_layers.py: fire/hospitals/police)
  // — its own theme, not transport/water/agri/outdoor/fx
  const GROUP_SAFETY = { id: 'safety', label: '安全 Safety', order: 4 }
  const GROUP_OUTDOOR = { id: 'outdoor', label: '戶外 Outdoor', order: 5 }
  // power towers + wind turbines (src/engine/energy.js) — its own theme, not
  // transport/agriculture/safety
  const GROUP_ENERGY = { id: 'energy', label: '能源 Energy', order: 6 }
  const GROUP_FX = { id: 'fx', label: '效果 FX', order: 7 }
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
    // GBA/TUM 3D building extrusions (vectortiles.js createBuildingsLayer) —
    // static base-map 3D content like region/coastline/counties above, not a
    // themed transport/water/agriculture/outdoor/fx dataset
    buildings: { group: GROUP_BASE },
    rail: { group: GROUP_MOVE },
    trains: { group: GROUP_MOVE },
    thsr: { group: GROUP_MOVE },
    stations: { group: GROUP_MOVE },
    osm_roads: { group: GROUP_MOVE },
    ships: { group: GROUP_MOVE },
    // basic POI packs (bake_poi_layers.py) — airports/ports are transport
    // infrastructure like stations/ships above
    airports: { group: GROUP_MOVE },
    ports: { group: GROUP_MOVE },
    // 3D airspace fence (bake_airspace.py / src/engine/airspace.js) — aviation
    // hazard/restriction overlay, alongside airports/ports above
    airspace: { group: GROUP_MOVE },
    power_towers: { group: GROUP_ENERGY },
    wind_turbines: { group: GROUP_ENERGY },
    rivers: { group: GROUP_WATER },
    reservoirs: { group: GROUP_WATER },
    // farmland tint + irrigation canals: agriculture, not hydrology — its own
    // theme even though both share the water-adjacent shader-drape/polyline
    // machinery (see loadFarmSim/applyFarmSim and createIrrigationLayer)
    farm_sim: { group: GROUP_AGRI },
    ftw_fields: { group: GROUP_AGRI },
    irrigation: { group: GROUP_AGRI },
    // basic POI packs (bake_poi_layers.py), continued — public-safety response
    // infrastructure, its own theme (see GROUP_SAFETY)
    fire_stations: { group: GROUP_SAFETY },
    hospitals: { group: GROUP_SAFETY },
    // full national 醫院/診所/藥局 roll (bake_medical_poi.py) — complements
    // hospitals above, same theme
    medical: { group: GROUP_SAFETY },
    police_stations: { group: GROUP_SAFETY },
    trails: { group: GROUP_OUTDOOR },
    trail_signs: { group: GROUP_OUTDOOR },
    // peak spot-elevation / place-name labels (labels.js) — cartography tied
    // to the same mountain/hiking context as trails, so it sits alongside them
    labels: { group: GROUP_OUTDOOR },
    typhoon: { group: GROUP_FX },
  }
  // registration order = draw / update order (coastline → counties →
  // buildings → airspace → rail → trains → thsr → trails → rivers →
  // reservoirs → farm sim → irrigation → typhoon → markers → stations →
  // ships → trail signs → airports/ports → fire/hospitals/medical/police → power
  // towers → wind turbines → labels). thsr
  // registers right after trains so it lands directly below 台鐵列車 Trains,
  // and ships registers right after stations, both in the Layers panel's
  // 交通 Move group (Layers.jsx preserves registration order within a group
  // — see groupLayers()). airspace registers right after buildings (same
  // low-pick-priority reasoning); power towers/wind turbines register late
  // (high pick-priority for their small near-view silhouettes) just before
  // labels.
  for (const layer of [
    createRegionLayer(params),
    createCoastlineLayer(params),
    createCountiesLayer(params),
    // registered early (low pick-priority — pickAll walks REVERSE registration
    // order) so its solid extruded meshes never swallow clicks meant for
    // roads/rail/markers drawn on top of it
    buildingsLayer,
    // airspace: same early/low-pick-priority registration as buildings — a
    // large translucent volume floating well above ground level shouldn't
    // steal clicks meant for anything drawn on top of it
    airspaceLayer,
    createRailLayer(params),
    createTrainsLayer(params, {
      // near-view car-chain LOD (see trains.js module header) — real TRA EMU
      // dimensions: ~20m/car, 6 cars/train. 320 × 6 = 1920 car instances.
      carLenM: 20,
      carCount: 6,
      widthM: 3,
      heightM: 4,
    }),
    createTrainsLayer(params, {
      id: 'thsr',
      label: 'THSR',
      rowLabel: '高鐵列車 THSR',
      railNetwork: 'thsr',
      maxInstances: 64,
      singleCorridor: true,
      netLabel: '高鐵', // pick()'s info-card title prefix (see trains.js createTrainsLayer's netLabel doc)
      // real THSR 700T dimensions: ~25m/car, 12 cars/train. 64 × 12 = 768 car instances.
      carLenM: 25,
      carCount: 12,
      widthM: 3.4,
      heightM: 4,
    }),
    osmRoadsLayer,
    trailsLayer,
    createRiversLayer(params),
    reservoirsLayer,
    createFarmSimLayer(params),
    ftwFieldsLayer,
    createIrrigationLayer(params),
    createTyphoonLayer(params),
    pointLayer,
    stationsLayer,
    shipsLayer,
    trailSignsLayer,
    airportsLayer,
    portsLayer,
    fireStationsLayer,
    hospitalsLayer,
    medicalLayer,
    policeLayer,
    powerTowersLayer,
    windTurbinesLayer,
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
    trailsLayer.markDemDirty()
    ftwFieldsLayer.markDemDirty()
    buildingsLayer.markDemDirty()
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

  // follow camera: the fifth motion source (see src/engine/follow.js header +
  // docs/FOLLOW_CAMERA_DESIGN.md). This module never decides WHO cancels it —
  // it just reacts to followEntity()/stopFollow() and polls motion/controls
  // state each tick. The mutex wiring (who calls stopFollow) is below, at
  // every OTHER motion-source entry point (keyPan.onEngage, selectPoi,
  // deselect, flyToLonLat, startTour) — never on controls 'start' (would kill
  // rotate/zoom too, see design doc §3).
  const follow = createFollow({
    camera,
    controls,
    motion,
    layers,
    invalidate,
    onChange: (s) => emit('follow', s),
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
      follow.stopFollow() // keyPan writes target directly, not via controls.state — can't be caught by follow's own pan detector
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
    follow.stopFollow() // POI focus and follow both own the tween — POI wins on click
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
    follow.stopFollow() // the return-flight tween below must not fight delta-carry (design doc §3)
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

  // shared rail_lines.json fetch cache for the trains/thsr loaders below —
  // both need the SAME file (filtered client-side to a different `system`),
  // so switching both light-dot layers on in one session doesn't double-
  // fetch it. Separate from loadRailData's own fetch above (the rail line
  // layer's setData wants a different {points,color} shape) — this cache
  // holds the raw {lines:[...]} payload. A failed fetch clears the cache so
  // the next toggle-on retries instead of replaying the same failure forever
  // (mirrors railFetch/trainsFetch's loaded-only-on-success convention).
  let railLinesCache = null
  async function fetchRailLines() {
    if (railLinesCache) return railLinesCache
    const req = (async () => {
      const res = await fetch(await manifestUrl('rail', '/layers/rail_lines.json'))
      if (!res.ok) throw new Error(`rail_lines.json ${res.status}`)
      return res.json()
    })()
    railLinesCache = req
    try {
      return await req
    } catch (err) {
      railLinesCache = null
      throw err
    }
  }

  // trains / thsr: real timetable-driven light dots (see src/engine/
  // trains.js's parametrized createTrainsLayer) — each instance needs THREE
  // sources landed together: <net>_tracks.json (per-part station ratios),
  // <net>_schedule.json (real train roster) and rail_lines.json itself (via
  // fetchRailLines() above, filtered client-side to this network's
  // `system`) for the raw lon/lat/elev polylines the ratio tables are
  // index-aligned against — see trains.js header. Same fail-quiet deferred
  // pattern as rail/trails; a partial failure (any one of the three) drops
  // the whole activation rather than rendering trains against mismatched/
  // missing track geometry. One loader factory drives both the TRA and THSR
  // instances — trains.js's own setData handles the one place their leg→
  // part resolution actually diverges (singleCorridor).
  function makeTrainLoader({ layerId, tracksKey, tracksFallback, scheduleKey, scheduleFallback, railSystem }) {
    const fetchState = { loading: false, loaded: false }
    return async function load() {
      if (fetchState.loading || fetchState.loaded) return
      fetchState.loading = true
      try {
        const [tracksRes, scheduleRes, rail] = await Promise.all([
          fetch(await manifestUrl(tracksKey, tracksFallback)),
          fetch(await manifestUrl(scheduleKey, scheduleFallback)),
          fetchRailLines(),
        ])
        if (!tracksRes.ok) throw new Error(`${tracksKey}.json ${tracksRes.status}`)
        if (!scheduleRes.ok) throw new Error(`${scheduleKey}.json ${scheduleRes.status}`)
        const [tracks, schedule] = await Promise.all([tracksRes.json(), scheduleRes.json()])
        const lines = rail.lines.filter((l) => l.system === railSystem).map((l) => l.points)
        layers.get(layerId).setData({ tracks, schedules: schedule.schedules, lines })
        fetchState.loaded = true
        layers.get(layerId).update(layerCtx())
      } catch (err) {
        console.warn(`[layers] ${layerId} fetch failed`, err)
      } finally {
        fetchState.loading = false
        invalidate()
        emit('layers')
      }
    }
  }
  const loadTrainsData = makeTrainLoader({
    layerId: 'trains',
    tracksKey: 'train_tracks',
    tracksFallback: '/layers/train_tracks.json',
    scheduleKey: 'train_schedule',
    scheduleFallback: '/layers/train_schedule.json',
    railSystem: 'tra',
  })
  const loadThsrData = makeTrainLoader({
    layerId: 'thsr',
    tracksKey: 'thsr_tracks',
    tracksFallback: '/layers/thsr_tracks.json',
    scheduleKey: 'thsr_schedule',
    scheduleFallback: '/layers/thsr_schedule.json',
    railSystem: 'thsr',
  })

  // irrigation: same deferred fetch-once pattern as the OLD trails baked-JSON
  // layer used to be (see git history — 2026-07-12 superseded trails with a
  // PMTiles/VectorTileManager stream, vectortiles.js createTrailsLayer; no
  // manifest fetch needed there anymore, matching osm_roads/ftw_fields).
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
  // storage ratios from the mini-taiwan-pulse Supabase RPC (anon read-only key,
  // SUPABASE_URL/SUPABASE_ANON declared near the top of createEngine — shared
  // with ships' RPC fallback below). A live-fetch failure is non-fatal: every
  // basin falls back to ratio 1.0 (full pool) with a console.warn, so the
  // water surfaces still render.
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

  // ships: RPC fallback for whichever date's CDN snapshot 404s (not baked
  // yet / today-before-first-bake-run — see docs/MARINE_DESIGN.md §1.1).
  // Parses the "lat,lng,ts;..." trail column + applies the >40kt GPS filter
  // (both ported into ships.js from pulse's shipLoader.ts — see its
  // parseTrailString/filterGpsAnomalies). Never throws: an RPC failure
  // resolves an empty trail list, same fail-quiet contract as the CDN path.
  async function fetchShipsFromRpc(dateKey) {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_ship_trails`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON,
          Authorization: `Bearer ${SUPABASE_ANON}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ target_date: dateKey }),
      })
      if (!res.ok) throw new Error(`get_ship_trails ${res.status}`)
      const rows = await res.json()
      return rows.map((r) => ({
        mmsi: String(r.mmsi),
        name: null,
        shipType: r.ship_type || null,
        points: filterGpsAnomalies(parseTrailString(r.trail)),
      }))
    } catch (err) {
      console.warn(`[layers] ships RPC fallback failed for ${dateKey}`, err)
      return []
    }
  }

  // ships: CDN snapshot first, RPC fallback on 404 (docs/MARINE_DESIGN.md
  // §1.1) — the timeline's FIRST subscribeDate consumer (§1.2). shipsCurrentDate
  // is a race guard: subscribeDate's callback can fire again (scrub to a new
  // day) while an earlier date's fetch is still in flight — whichever
  // response lands with a stale dateKey (not the latest one requested) is
  // discarded rather than clobbering the newer selection. trails=[] (either
  // path) is a legitimate "this day has no ship data" result — setData still
  // runs so the layer shows correctly-empty instead of staying gated off.
  let shipsCurrentDate = null
  async function loadShipsForDate(dateKey) {
    shipsCurrentDate = dateKey
    let trails = null // null = CDN path didn't produce usable trails; triggers RPC fallback below
    try {
      const res = await fetch(`${SHIPS_TILE_BASE}/ships/trails/${dateKey}.json`)
      if (res.ok) {
        // dev-server gotcha (same one dem.js's TILE_URL comment documents for
        // DEM tiles): an unmatched path under the LOCAL '/tiles' base returns
        // Vite's SPA-fallback index.html with status 200, not a real 404 —
        // res.json() throws on it, caught below, same as a real miss. In
        // production SHIPS_TILE_BASE is a different origin (R2/CDN), where a
        // missing snapshot is a genuine 404 and lands in the `else` below.
        const data = await res.json()
        trails = (data.trails || []).map((t) => ({
          mmsi: String(t.mmsi),
          name: t.name || null,
          shipType: t.ship_type || null,
          points: t.points || [],
        }))
      }
      // any other status (404 or otherwise) falls through to the RPC
      // fallback below, same as a JSON-parse failure caught here
    } catch (err) {
      console.warn(`[layers] ships snapshot fetch failed for ${dateKey} — falling back to RPC`, err)
    }
    if (trails === null) trails = await fetchShipsFromRpc(dateKey)
    if (dateKey !== shipsCurrentDate) return // stale — a newer date was requested meanwhile
    shipsLayer.setData(trails)
    shipsLayer.update(layerCtx())
    invalidate()
    emit('layers')
  }
  let shipsActivated = false // onActivate: first switch-on loads today + subscribes to future date changes (once — see shipsVisible HANDLER)

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

  // generic loader for bake_poi_layers.py's 5 basic POI packs (airports/
  // ports/fire_stations/hospitals/police_stations) — same {systems: {id:
  // {color, points}}} shape as stations.json/trail_signs.json above, so one
  // function covers all 5 onActivate hooks instead of 5 near-identical
  // copies. Same fail-quiet deferred pattern: a fetch failure just leaves
  // the layer showing no sets.
  async function loadPoiData(id, layer) {
    try {
      const res = await fetch(await manifestUrl(id, `/layers/${id}.json`))
      if (!res.ok) throw new Error(`${id}.json ${res.status}`)
      const data = await res.json()
      for (const [systemId, sys] of Object.entries(data.systems)) {
        layer.setSet(systemId, { color: sys.color, visible: true, points: sys.points })
      }
      layer.update(layerCtx())
    } catch (err) {
      console.warn(`[layers] ${id} fetch failed`, err)
    } finally {
      invalidate()
      emit('layers')
    }
  }

  // airspace: manifest-driven deferred polygon-extrusion layer (bake_airspace.py
  // -> public/layers/airspace.json). Same fail-quiet fetch-once pattern as
  // loadPoiData above; airspaceLayer.setData/update mirror water.js's
  // reservoirs setData/build split (see airspace.js module header).
  let airspaceFetch = { loading: false, loaded: false }
  async function loadAirspaceData() {
    if (airspaceFetch.loading || airspaceFetch.loaded) return
    airspaceFetch.loading = true
    try {
      const res = await fetch(await manifestUrl('airspace', '/layers/airspace.json'))
      if (!res.ok) throw new Error(`airspace.json ${res.status}`)
      const data = await res.json()
      airspaceLayer.setData(data.zones)
      airspaceFetch.loaded = true
      airspaceLayer.update(layerCtx())
    } catch (err) {
      console.warn('[layers] airspace fetch failed', err)
    } finally {
      airspaceFetch.loading = false
      invalidate()
      emit('layers')
    }
  }

  // power towers / wind turbines: manifest-driven deferred point layers
  // (bake_energy.py -> public/layers/power_towers.json / wind_turbines.json,
  // src/engine/energy.js). Same fail-quiet fetch-once pattern as loadPoiData.
  let powerTowersFetch = { loading: false, loaded: false }
  async function loadPowerTowersData() {
    if (powerTowersFetch.loading || powerTowersFetch.loaded) return
    powerTowersFetch.loading = true
    try {
      const res = await fetch(await manifestUrl('power_towers', '/layers/power_towers.json'))
      if (!res.ok) throw new Error(`power_towers.json ${res.status}`)
      const data = await res.json()
      powerTowersLayer.setData(data.points, data.meta?.operators)
      powerTowersFetch.loaded = true
      powerTowersLayer.update(layerCtx())
    } catch (err) {
      console.warn('[layers] power_towers fetch failed', err)
    } finally {
      powerTowersFetch.loading = false
      invalidate()
      emit('layers')
    }
  }
  let windTurbinesFetch = { loading: false, loaded: false }
  async function loadWindTurbinesData() {
    if (windTurbinesFetch.loading || windTurbinesFetch.loaded) return
    windTurbinesFetch.loading = true
    try {
      const res = await fetch(await manifestUrl('wind_turbines', '/layers/wind_turbines.json'))
      if (!res.ok) throw new Error(`wind_turbines.json ${res.status}`)
      const data = await res.json()
      windTurbinesLayer.setData(data.points)
      windTurbinesFetch.loaded = true
      windTurbinesLayer.update(layerCtx())
    } catch (err) {
      console.warn('[layers] wind_turbines fetch failed', err)
    } finally {
      windTurbinesFetch.loading = false
      invalidate()
      emit('layers')
    }
  }

  // medical: manifest-driven deferred point layer, but R2-hosted (not
  // committed to git — see bake_medical_poi.py's size-bracket decision, 2.83
  // MB lands in the 2-8 MB rule, not the <2MB git bracket the other 5 basic
  // POI packs above use). Same fail-quiet fetch-once pattern as loadPoiData/
  // loadPowerTowersData; medicalLayer.setData takes the flat {name,cat,
  // county,lon,lat,elev} point array directly (bake_medical_poi.py's schema
  // — no `systems` dict like the git-committed POI packs, since category is
  // a plain int enum per the task spec, not a bake-time named-set split).
  let medicalFetch = { loading: false, loaded: false }
  async function loadMedicalData() {
    if (medicalFetch.loading || medicalFetch.loaded) return
    medicalFetch.loading = true
    try {
      const res = await fetch(await manifestUrl('medical', 'https://tiles.itsmigu.com/layers/medical.json'))
      if (!res.ok) throw new Error(`medical.json ${res.status}`)
      const data = await res.json()
      medicalLayer.setData(data.points)
      medicalFetch.loaded = true
      medicalLayer.update(layerCtx())
    } catch (err) {
      console.warn('[layers] medical fetch failed', err)
    } finally {
      medicalFetch.loading = false
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
    follow.stopFollow() // covers flyTo/applyPreset/custom-coordinate callers alike (design doc §3)
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
    // trains: first switch-on triggers the deferred fetch (loadTrainsData
    // no-ops once loaded/in-flight); the timeline clock needs no handler
    // here — trains.js reads timeStore.getDaySeconds() fresh every tickView,
    // no update()/rebuild required.
    trainsVisible: (v) => {
      if (v) loadTrainsData()
      layers.get('trains').update(layerCtx())
    },
    trainsColor: () => layers.get('trains').update(layerCtx()),
    trainsSize: () => layers.get('trains').update(layerCtx()),
    trainsOpacity: () => layers.get('trains').update(layerCtx()),
    // thsr: second createTrainsLayer instance (src/engine/trains.js) — same
    // deferred-fetch-on-first-toggle-on pattern as trains above.
    thsrVisible: (v) => {
      if (v) loadThsrData()
      layers.get('thsr').update(layerCtx())
    },
    thsrColor: () => layers.get('thsr').update(layerCtx()),
    thsrSize: () => layers.get('thsr').update(layerCtx()),
    thsrOpacity: () => layers.get('thsr').update(layerCtx()),
    // ships: onActivate (docs/MARINE_DESIGN.md §1.2) — first switch-on loads
    // the timeline's CURRENT date immediately (subscribeDate's callback only
    // fires on FUTURE changes, never on subscribe itself) and subscribes to
    // subsequent date changes (scrub/seek/play across midnight) exactly
    // once; later toggles just re-apply gate/style like trains/thsr above.
    shipsVisible: (v) => {
      if (v && !shipsActivated) {
        shipsActivated = true
        loadShipsForDate(timeStore.getDateKey())
        timeStore.subscribeDate((dateKey) => loadShipsForDate(dateKey))
      }
      layers.get('ships').update(layerCtx())
    },
    shipsColor: () => layers.get('ships').update(layerCtx()),
    shipsSize: () => layers.get('ships').update(layerCtx()),
    shipsOpacity: () => layers.get('ships').update(layerCtx()),
    // OSM roads: no deferred JSON fetch to kick — the PMTiles manager streams
    // tiles itself once switched on (see vectortiles.js). update() just
    // (re)applies the gate/style; the manager's own setEnabled starts/stops
    // the per-frame tile streaming (layers.get('osm_roads').tickView).
    osmRoadsVisible: () => layers.get('osm_roads').update(layerCtx()),
    osmRoadsWidth: () => layers.get('osm_roads').update(layerCtx()),
    osmRoadsOpacity: () => layers.get('osm_roads').update(layerCtx()),
    // trails: PMTiles/VectorTileManager stream (vectortiles.js createTrailsLayer)
    // — same streamed-not-manifest pattern as osmRoadsVisible above, no fetch
    // call here; update() re-evaluates its own gate() and (re)starts streaming.
    trailsVisible: () => layers.get('trails').update(layerCtx()),
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
    // buildings: no deferred JSON fetch — same PMTiles-streams-itself pattern
    // as osmRoadsVisible/ftwFieldsVisible above (see vectortiles.js
    // createBuildingsLayer); update()'s own gate() also checks ctx.lodZoom
    // against the z13 source minzoom
    buildingsVisible: () => buildingsLayer.update(layerCtx()),
    buildingsOpacity: () => buildingsLayer.update(layerCtx()),
    // airspace: manifest-driven deferred polygon layer, same first-switch-on-
    // fetches pattern as reservoirs/region below
    airspaceVisible: (v) => {
      if (v) loadAirspaceData()
      airspaceLayer.update(layerCtx())
    },
    airspaceOpacity: () => airspaceLayer.update(layerCtx()),
    // power towers / wind turbines: manifest-driven deferred point layers,
    // same first-switch-on-fetches pattern. size/opacity just re-run update()
    // (buildings/trains convention) — energy.js's own tickView/update staleness
    // checks (lastSizeMult/lastExaggeration) pick up the new params[key] value
    // and re-lay-out on the very next frame (setParams's trailing invalidate()
    // guarantees one happens).
    powerTowersVisible: (v) => {
      if (v) loadPowerTowersData()
      powerTowersLayer.update(layerCtx())
    },
    powerTowersSize: () => powerTowersLayer.update(layerCtx()),
    powerTowersOpacity: () => powerTowersLayer.update(layerCtx()),
    windTurbinesVisible: (v) => {
      if (v) loadWindTurbinesData()
      windTurbinesLayer.update(layerCtx())
    },
    windTurbinesSize: () => windTurbinesLayer.update(layerCtx()),
    windTurbinesOpacity: () => windTurbinesLayer.update(layerCtx()),
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
    seaAnimated: () => layers.get('region').update(layerCtx()),
    seaRippleStrength: () => layers.get('region').update(layerCtx()),
    seaRippleSpeed: () => layers.get('region').update(layerCtx()),
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
      activePick = { title: hit.title, rows: hit.rows, worldPos: hit.worldPos.clone(), layerId: hit.layerId, followable: hit.followable }
      emit('pick', { title: hit.title, rows: hit.rows, layerId: hit.layerId, followable: hit.followable })
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
      (params.seaAnimated && params.regionVisible) || // sea ripple decoration — wall-clock, not gated on the timeline, same as typhoon
      ((params.trainsVisible || params.thsrVisible || params.shipsVisible) && timeStore.getPlaying()) || // light dots advance only while the timeline is playing
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
    lastCamDist = camDist // trains.js near-view car-chain LOD reads this via layerCtx().camDist
    const realMode = params.source === 'real' && heightField
    const lodChanged = stage.tickView(camDist, !!realMode)
    const fogScale = stage.fogScale
    terrain.mapUniforms.uContourInterval.value = params.contourInterval * fogScale
    terrain.mapUniforms.uGridStep.value = params.gridStep * fogScale
    layers.tickAll(layerCtx(dt)) // anti-z-fight lift tracks the view scale; marker dot rescale / tag crowd control
    // follow camera: delta-carry off the entity's JUST-updated position above
    // — must run after layers.tickAll() (this frame's placement) and before
    // chunkManager.update() below (so DEM streaming follows the carried
    // target) and camera.updateMatrixWorld() (see design doc §4)
    follow.tick()
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
      follow.stopFollow() // design doc §3 — tour owns the camera outright
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
    // camera follow (src/engine/follow.js) — LayerPickCard's Follow button /
    // App.jsx's corner chip. followEntity returns false without side effects
    // if the layer/entity can't be resolved right now.
    followEntity: follow.followEntity,
    stopFollow: follow.stopFollow,
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
      offTimeStore()
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
      follow,
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
