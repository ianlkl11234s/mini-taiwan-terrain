import * as THREE from 'three'
import { MapControls } from 'three/addons/controls/MapControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import GUI from 'lil-gui'
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  DepthOfFieldEffect,
  VignetteEffect,
  NoiseEffect,
  SMAAEffect,
  HueSaturationEffect,
  BrightnessContrastEffect,
  ToneMappingEffect,
  ToneMappingMode,
  Effect,
  BlendFunction,
} from 'postprocessing'
import { Terrain } from './terrain.js'
import { createCone } from './cone.js'
import { createLabels, disposeLabels } from './labels.js'
import { createHud3D, findPois } from './hud3d.js'
import { createHud2D } from './hud2d.js'
import { makeProjection, HeightField, TAIWAN_BBOX } from './geo.js'
import { ChunkManager } from './chunks.js'
import { findRealPeaks } from './peaks.js'

// ------------------------------------------------------------------ params

// Taiwan presets: [lat, lon, zoom]. P1: one streamed world locked to z12 —
// presets are fly-to targets inside it (zoom entries kept for the P2 LOD work)
const DEM_PRESETS = {
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

const params = {
  // terrain source
  source: 'real',
  demLocation: '玉山 Yushan',
  demLat: 23.47,
  demLon: 120.9575,
  demZoom: 12,
  demExaggeration: 1.6,
  chunkRes: 128, // per-chunk grid density (real mode; 25 chunks share it)

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

// ------------------------------------------------------------------ renderer / scene

const container = document.getElementById('app')
const loadingEl = document.getElementById('loading')

const renderer = new THREE.WebGLRenderer({
  powerPreference: 'high-performance',
  antialias: false, // SMAA runs in the post chain
  stencil: false,
  depth: false,
})
renderer.setPixelRatio(params.pixelRatio)
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.shadowMap.enabled = true
// VSM so the shadow blur radius is a real, adjustable softness control
renderer.shadowMap.type = THREE.VSMShadowMap
// tone mapping happens in the post chain (three skips renderer tone mapping
// when drawing into the composer's HDR buffer, which is why exposure felt dead)
renderer.toneMapping = THREE.NoToneMapping
container.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(params.fogColor)
// linear fog: near/far give direct control over where the fade starts and
// where the terrain is fully swallowed, hiding the mesh edge
scene.fog = new THREE.Fog(new THREE.Color(params.fogColor), params.fogNear, params.fogFar)

// far plane covers the whole-island view (P2): max dolly 1000 + a scaled fog
// wall; near stays 0.5 (ratio 6000 — comfortably inside 24-bit depth)
const camera = new THREE.PerspectiveCamera(params.fov, window.innerWidth / window.innerHeight, 0.5, 3000)
camera.position.set(0, 18, 19)

// MapControls: left drag = pan across the terrain, right drag = rotate,
// wheel = dolly — the explore-the-map interaction the chunk grid exists for.
// maxDistance 1000 in real mode = the whole-island view (applySourceMode
// keeps procedural mode at the legacy 60).
const controls = new MapControls(camera, renderer.domElement)
controls.target.set(0, -0.3, 0)
controls.enableDamping = true
controls.dampingFactor = 0.06
controls.maxPolarAngle = Math.PI * 0.49
controls.minDistance = 5
controls.maxDistance = 1000
controls.update()

// ---------------------------------------------------------------- P2: distance LOD
// targetZoom = clamp(12 - round(log2(dist / D0)), 10, 13) with ±15% hysteresis
// on the crossover distances so the LOD never flaps at a boundary. fogScale
// is the master far-view multiplier: 1 at dist ≤ D0 (near view = exactly the
// P1 look), then fog wall / contour interval / survey grid / streaming radius
// all scale with it.
const LOD_D0 = 30 // camera distance that maps to z12 (the P0/P1 default view)
const LOD_MIN = 10
const LOD_MAX = 13
const LOD_HYST = 1.15
let lodZoom = 12
let fogScale = 1

// camera distance where the ideal zoom flips between z and z-1
const lodCrossover = (z) => LOD_D0 * Math.pow(2, 12 - z + 0.5)
function nextLodZoom(dist) {
  let z = lodZoom
  while (z > LOD_MIN && dist > lodCrossover(z) * LOD_HYST) z--
  while (z < LOD_MAX && dist < lodCrossover(z + 1) / LOD_HYST) z++
  return z
}

// P1 streams chunks wherever the target goes — pan is only clamped to the
// Taiwan tile-coverage bbox (beyond it every tile is open sea). Procedural
// mode keeps the legacy ±28 box around its single 56×56 plane.
let panBounds = null // world-space {minX, maxX, minZ, maxZ}, set when the world loads
const _panPre = new THREE.Vector3()
function clampPan() {
  _panPre.copy(controls.target)
  if (params.source === 'real' && panBounds) {
    controls.target.x = THREE.MathUtils.clamp(controls.target.x, panBounds.minX, panBounds.maxX)
    controls.target.z = THREE.MathUtils.clamp(controls.target.z, panBounds.minZ, panBounds.maxZ)
  } else {
    controls.target.x = THREE.MathUtils.clamp(controls.target.x, -28, 28)
    controls.target.z = THREE.MathUtils.clamp(controls.target.z, -28, 28)
  }
  // shift the camera by the same correction so clamping doesn't swing the view
  camera.position.add(_panPre.subVectors(controls.target, _panPre))
}

// image-based lighting for believable PBR speculars
const pmrem = new THREE.PMREMGenerator(renderer)
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
scene.environmentIntensity = params.envLight
pmrem.dispose()

// ------------------------------------------------------------------ lights

const sun = new THREE.DirectionalLight(0xffffff, params.sunIntensity)
sun.castShadow = true
sun.shadow.mapSize.set(2048, 2048)
sun.shadow.camera.left = -26
sun.shadow.camera.right = 26
sun.shadow.camera.top = 26
sun.shadow.camera.bottom = -26
sun.shadow.camera.near = 4
sun.shadow.camera.far = 80
sun.shadow.bias = -0.0001
sun.shadow.normalBias = 0.02
sun.shadow.radius = params.shadowSoftness
sun.shadow.blurSamples = 16
scene.add(sun)

// the ±26 shadow frustum follows the pan target: light DIRECTION never
// changes, only the frustum center translates with the world
const sunTarget = new THREE.Object3D()
scene.add(sunTarget)
sun.target = sunTarget

const hemi = new THREE.HemisphereLight(0xdadada, 0x5c5c5c, params.hemiIntensity)
scene.add(hemi)

const _sunOffset = new THREE.Vector3()
const _sunAnchor = new THREE.Vector2(NaN, NaN)
function placeSun() {
  const az = THREE.MathUtils.degToRad(params.sunAzimuth)
  const el = THREE.MathUtils.degToRad(params.sunElevation)
  const r = 34
  _sunOffset.set(Math.cos(az) * Math.cos(el) * r, Math.sin(el) * r, Math.sin(az) * Math.cos(el) * r)
  sun.intensity = params.sunIntensity
  hemi.intensity = params.hemiIntensity
  _sunAnchor.set(NaN, NaN) // force updateSunAnchor to re-place the light
  updateSunAnchor()
}

// called every frame — snaps the anchor to a coarse 0.5-unit grid so the VSM
// shadow doesn't shimmer continuously while panning
function updateSunAnchor() {
  const ax = Math.round(controls.target.x * 2) / 2
  const az = Math.round(controls.target.z * 2) / 2
  if (ax === _sunAnchor.x && az === _sunAnchor.y) return
  _sunAnchor.set(ax, az)
  sunTarget.position.set(ax, 0, az)
  sun.position.set(_sunOffset.x + ax, _sunOffset.y, _sunOffset.z + az)
  // VSM maps must re-render once the frustum moves, even in static mode
  if (params.shadowMode === 'static') renderer.shadowMap.needsUpdate = true
}
placeSun()

// P2: the ±26 shadow frustum grows with fogScale up to 2×, then the shadow
// fades out entirely on the way to the island view (dist 60 → 120) — a huge
// VSM frustum is mush; slope tint + hypso carry the far relief instead.
const SHADOW_BASE = 26
let _shadowScale = 1
let _shadowFade = 1
function updateShadowScale(dist) {
  const s = Math.min(Math.max(1, dist / LOD_D0), 2)
  if (Math.abs(s - _shadowScale) > 0.01) {
    _shadowScale = s
    const r = SHADOW_BASE * s
    sun.shadow.camera.left = -r
    sun.shadow.camera.right = r
    sun.shadow.camera.top = r
    sun.shadow.camera.bottom = -r
    sun.shadow.camera.far = 80 * s
    sun.shadow.camera.updateProjectionMatrix()
    if (params.shadowMode === 'static') renderer.shadowMap.needsUpdate = true
  }
  const fade = 1 - THREE.MathUtils.clamp((dist - 60) / 60, 0, 1)
  if (fade !== _shadowFade) {
    _shadowFade = fade
    sun.shadow.intensity = fade
    applyShadowMode() // stop casting altogether once fully faded
  }
}

function applyShadowMode() {
  sun.castShadow = params.shadowMode !== 'off' && _shadowFade > 0.02
  renderer.shadowMap.autoUpdate = params.shadowMode === 'dynamic'
  if (params.shadowMode === 'static') renderer.shadowMap.needsUpdate = true
}

// ------------------------------------------------------------------ world

const terrain = new Terrain(params)
scene.add(terrain.group)

// chunk streaming: which chunks exist follows the pan target (radius tied to
// the EFFECTIVE fog wall, so it grows with the far-view fogScale) — meshes
// build incrementally so dragging never blocks. targetZoom/innerRes feed the
// P2 LOD rings.
const chunkManager = new ChunkManager(terrain, {
  radius: () => params.fogFar * fogScale * 1.15,
  targetZoom: () => lodZoom,
  innerRes: () => params.chunkRes,
})
chunkManager.onChunksChanged = () => {
  if (params.shadowMode === 'static') renderer.shadowMap.needsUpdate = true
}

const cone = createCone()
scene.add(cone.group)

const labelOpts = () => ({
  real: params.source === 'real',
  toFeet: (h) => terrain.heightToFeet(h),
  // streamed world: labels re-sow around the pan target (see tick throttle)
  center: params.source === 'real' ? { x: controls.target.x, z: controls.target.z } : undefined,
  spots: lodZoom >= 12, // P2: no spot elevations in far views
})
let labels = createLabels(terrain.sample, params.seed, labelOpts())
labels.visible = params.labels
scene.add(labels)

function regenerateLabels() {
  scene.remove(labels)
  disposeLabels(labels)
  labels = createLabels(terrain.sample, params.seed, labelOpts())
  labels.visible = params.labels
  scene.add(labels)
}

// ------------------------------------------------------------------ HUD + interactivity

const HOME = { pos: new THREE.Vector3(0, 18, 19), target: new THREE.Vector3(0, -0.3, 0) }
const EASINGS = {
  smooth: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2), // cubic in-out
  glide: (t) => 1 - Math.pow(1 - t, 5), // quintic out
  linear: (t) => t,
}
const tween = {
  active: false,
  t: 0,
  p0: new THREE.Vector3(),
  p1: new THREE.Vector3(),
  t0: new THREE.Vector3(),
  t1: new THREE.Vector3(),
}
let selectedPoi = -1
let fps = 60
let scanStart = -1
let gpsAcc = 0 // SECTOR GPS refresh throttle
let poiAcc = 0 // peaks/labels refresh throttle

// real-world heightfield (declared before the first POI pass — computePois reads it)
let heightField = null
let demBusy = false

const poiFeet = (h) => terrain.heightToFeet(h)
// real Taiwan peaks around the pan target when a DEM is loaded; hill-climb
// otherwise. P2: the search radius follows the scaled fog wall, and far views
// show only the top-8 island peaks (spread apart) so the label field never crowds.
function computePois() {
  if (params.source === 'real' && heightField) {
    const far = lodZoom <= 11
    const real = findRealPeaks(heightField, terrain.sample, poiFeet, controls.target, params.fogFar * fogScale, {
      limit: far ? 8 : 6,
      minSep: 1.5 * fogScale,
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
hud3.lines.visible = params.surveyLines
scene.add(hud3.group)

function flyTo(pos, target) {
  tween.p0.copy(camera.position)
  tween.t0.copy(controls.target)
  tween.p1.copy(pos)
  tween.t1.copy(target)
  tween.t = 0
  tween.active = true
}

// pose to restore when a selection is closed: wherever the camera was pre-click
const returnPose = { saved: false, pos: new THREE.Vector3(), target: new THREE.Vector3() }

// ------------------------------------------------------------------ tour mode

// One continuous Catmull-Rom spline: current camera pose → above the FROM poi →
// arc across the terrain → standoff short of the TO poi. Sampled by ARC LENGTH
// (uniform speed), driven by a trapezoidal velocity profile, with all rotation
// going through a damped "gimbal" controller so snaps are impossible.

const TOUR_N = 240
const tour = {
  active: false,
  t: 0,
  bank: 0,
  uA: 0.2, // arc-length fraction where the path passes over the FROM poi
  curve: null,
  aTop: new THREE.Vector3(),
  bTop: new THREE.Vector3(),
}
const _tp = new THREE.Vector3()
const _tg = new THREE.Vector3()
const _tt0 = new THREE.Vector3()
const _tt1 = new THREE.Vector3()
const _tm = new THREE.Matrix4()
const _tq = new THREE.Quaternion()
const _tqr = new THREE.Quaternion()
const Z_AXIS = new THREE.Vector3(0, 0, 1)
const UP = new THREE.Vector3(0, 1, 0)

function boxBlur(arr, radius, passes = 1) {
  let a = arr
  for (let p = 0; p < passes; p++) {
    const out = new Float32Array(a.length)
    for (let i = 0; i < a.length; i++) {
      let s = 0
      let c = 0
      for (let j = Math.max(0, i - radius); j <= Math.min(a.length - 1, i + radius); j++) {
        s += a[j]
        c++
      }
      out[i] = s / c
    }
    a = out
  }
  return a
}

// trapezoidal velocity: accelerate → cruise at constant speed → decelerate
function trapezoid(t, r) {
  t = THREE.MathUtils.clamp(t, 0, 1)
  if (t < r) return (t * t) / (2 * r * (1 - r))
  if (t > 1 - r) {
    const u = 1 - t
    return 1 - (u * u) / (2 * r * (1 - r))
  }
  return (t - r / 2) / (1 - r)
}

function startTour() {
  const A = pois.find((p) => p.id === params.tourFrom)
  const B = pois.find((p) => p.id === params.tourTo)
  if (!A || !B || A === B) return

  // ground path A → standoff short of B (ending on B itself would degenerate
  // to a vertical view), arced sideways for a more interesting line
  const a = new THREE.Vector3(A.x, 0, A.z)
  const bFull = new THREE.Vector3(B.x, 0, B.z)
  const dist = a.distanceTo(bFull)
  const dirAB = bFull.clone().sub(a).normalize()
  const b = bFull.clone().addScaledVector(dirAB, -Math.min(7, dist * 0.4))
  const mid = a.clone().add(b).multiplyScalar(0.5)
  mid.addScaledVector(new THREE.Vector3(-dirAB.z, 0, dirAB.x), dist * 0.22)

  const px = new Float32Array(TOUR_N)
  const pz = new Float32Array(TOUR_N)
  const ground = new Float32Array(TOUR_N)
  for (let i = 0; i < TOUR_N; i++) {
    const t = i / (TOUR_N - 1)
    const u = 1 - t
    px[i] = u * u * a.x + 2 * u * t * mid.x + t * t * b.x
    pz[i] = u * u * a.z + 2 * u * t * mid.z + t * t * b.z
    ground[i] = terrain.sample(px[i], pz[i])
  }

  // altitude: clearance envelope (rolling max) blurred hard — rises over
  // mountains as one long swell, never tracks bumps
  const radius = Math.round(4 + params.tourSmoothing * 30)
  const envelope = new Float32Array(TOUR_N)
  for (let i = 0; i < TOUR_N; i++) {
    let m = -Infinity
    for (let j = Math.max(0, i - radius); j <= Math.min(TOUR_N - 1, i + radius); j++) m = Math.max(m, ground[j])
    envelope[i] = m
  }
  const smoothY = boxBlur(envelope, radius, 3)

  // one continuous spline starting at the CURRENT camera position — the
  // approach is just the first leg of the same flight, no phase transition
  const pts = [camera.position.clone()]
  for (let i = 0; i < TOUR_N; i += 20) pts.push(new THREE.Vector3(px[i], smoothY[i] + params.tourAltitude, pz[i]))
  pts.push(new THREE.Vector3(px[TOUR_N - 1], smoothY[TOUR_N - 1] + params.tourAltitude, pz[TOUR_N - 1]))
  tour.curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5)
  tour.curve.arcLengthDivisions = 400
  tour.curve.updateArcLengths()

  // arc-length fraction where we pass over the FROM poi (gaze switches there)
  let bestD = Infinity
  for (let i = 0; i <= 200; i++) {
    const s = i / 200
    tour.curve.getPointAt(s, _tp)
    const d = Math.hypot(_tp.x - A.x, _tp.z - A.z)
    if (d < bestD) {
      bestD = d
      tour.uA = s
    }
  }

  tour.aTop.set(A.x, A.h + 0.6, A.z)
  tour.bTop.set(B.x, B.h + 0.6, B.z)
  tour.bank = 0
  tour.t = 0
  tour.active = true
  tween.active = false
}

// gaze target along the flight: frame the FROM poi on approach, then look
// ahead down the path, converging onto the TO poi at the end
function tourGaze(s, camPos, out) {
  const ahead = Math.min(s + params.tourLook, 1)
  tour.curve.getPointAt(ahead, out)
  out.y -= params.tourAltitude * 0.7 // gaze slightly below the flight line
  // hand the gaze off BEFORE we're overhead the FROM poi — looking straight
  // down while passing over it flips the heading violently
  const fromBlend = THREE.MathUtils.smoothstep(s, tour.uA * 0.15, tour.uA * 0.75)
  out.lerp(tour.aTop, 1 - fromBlend)
  out.lerp(tour.bTop, THREE.MathUtils.smoothstep(s, 0.85, 1))

  // pitch clamp: never look down steeper than ~72°, pushing the gaze point
  // forward instead — guards against gimbal flips in every configuration
  const dx = out.x - camPos.x
  const dz = out.z - camPos.z
  const horiz = Math.hypot(dx, dz)
  const drop = camPos.y - out.y
  const minHoriz = drop * 0.33
  if (drop > 0 && horiz < minHoriz) {
    if (horiz > 1e-4) {
      const k = minHoriz / horiz
      out.x = camPos.x + dx * k
      out.z = camPos.z + dz * k
    } else {
      tour.curve.getTangentAt(s, _tt0)
      out.x = camPos.x + _tt0.x * minHoriz
      out.z = camPos.z + _tt0.z * minHoriz
    }
  }
  return out
}

const hud2 = createHud2D({
  onSelectPoi(i) {
    if (selectedPoi === -1) {
      returnPose.pos.copy(camera.position)
      returnPose.target.copy(controls.target)
      returnPose.saved = true
    }
    selectedPoi = i
    const p = pois[i]
    hud2.setSelected(i, p)
    const dir = new THREE.Vector3(p.x, 0, p.z).normalize()
    flyTo(new THREE.Vector3(p.x + dir.x * 6.5, p.h + 4.2, p.z + dir.z * 6.5), new THREE.Vector3(p.x, p.h + 0.6, p.z))
  },
  onDeselect() {
    selectedPoi = -1
    hud2.setSelected(-1, null)
    flyTo(returnPose.saved ? returnPose.pos : HOME.pos, returnPose.saved ? returnPose.target : HOME.target)
    returnPose.saved = false
  },
  onScan() {
    triggerScan()
    cone.kick(3)
  },
})
hud2.setPois(pois)
hud2.setStatic(params)
hud2.setVisible(params.hud)
hud2.setOpacity(params.hudOpacity)
document.documentElement.style.setProperty('--hud-accent', params.hudAccent)
document.documentElement.style.setProperty('--hud-ink', params.hudInk)
document.documentElement.style.setProperty('--hud-blur', `${params.uiBlur}px`)
document.documentElement.style.setProperty('--hud-bg-alpha', params.uiBgOpacity)

// user grabbing the camera cancels any fly-to or tour
controls.addEventListener('start', () => {
  tween.active = false
  tour.active = false
  camera.up.set(0, 1, 0)
})

// real-world mode strips the fiction: no cone/reticle, no dial platform.
// P2: only real mode gets the island-scale dolly range — procedural keeps the
// legacy 60 (its single plane has nothing to show beyond the fog).
function applySourceMode() {
  const real = params.source === 'real'
  cone.group.visible = !real
  hud3.platform.visible = !real
  hud2.setReticleVisible(!real)
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
  hud2.setPois(pois)
  hud2.setStatic(params)
  selectedPoi = -1
  hud2.setSelected(-1, null)
  applySourceMode()
  refreshTourOptions()
}
applySourceMode()

// ------------------------------------------------------------------ post: real depth-based DOF

const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType })
composer.addPass(new RenderPass(scene, camera))

const dof = new DepthOfFieldEffect(camera, {
  focusDistance: 0.02,
  focalLength: 0.06,
  bokehScale: params.bokehScale,
  height: 720,
})
// drive the circle-of-confusion in world units so focus params are intuitive
dof.cocMaterial.worldFocusDistance = params.focusDistance
dof.cocMaterial.worldFocusRange = params.focusRange

// pre-tonemap exposure multiplier, operating on the HDR buffer
class ExposureEffect extends Effect {
  constructor(exposure) {
    super(
      'ExposureEffect',
      'uniform float exposure; void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) { outputColor = vec4(inputColor.rgb * exposure, inputColor.a); }',
      { uniforms: new Map([['exposure', new THREE.Uniform(exposure)]]) }
    )
  }
}

const exposureFx = new ExposureEffect(params.exposure)
const toneMap = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC })
const contrastFx = new BrightnessContrastEffect({ brightness: 0, contrast: params.contrast })
const hueSat = new HueSaturationEffect({ saturation: params.saturation })
const grain = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false })
grain.blendMode.opacity.value = params.grain
const vignette = new VignetteEffect({ darkness: params.vignette, offset: 0.28 })
const smaa = new SMAAEffect()

const dofPass = new EffectPass(camera, dof)
composer.addPass(dofPass)
composer.addPass(new EffectPass(camera, exposureFx, toneMap, hueSat, contrastFx, grain, vignette, smaa))
// skip the whole DOF pass when bokeh is zero — it's pure cost with no visual effect
dofPass.enabled = params.bokehScale > 0

// ------------------------------------------------------------------ pointer

const mouse = new THREE.Vector2(0, 0)
let lastPointer = null
window.addEventListener('pointermove', (e) => {
  const nx = (e.clientX / window.innerWidth) * 2 - 1
  const ny = -((e.clientY / window.innerHeight) * 2 - 1)
  if (lastPointer) {
    const speed = Math.hypot(nx - lastPointer.x, ny - lastPointer.y)
    cone.kick(speed * 6)
  }
  lastPointer = { x: nx, y: ny }
  mouse.set(nx, ny)
})

// ------------------------------------------------------------------ regeneration helpers

// ------------------------------------------------------------------ real-world DEM loading

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
  loadingEl.textContent = 'fetching elevation tiles…'
  loadingEl.classList.remove('hidden')
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
    panBounds = { minX: a.x, maxX: b.x, minZ: a.z, maxZ: b.z }
    params.source = 'real'
    gui.controllersRecursive().forEach((c) => c.updateDisplay())
    loadingEl.textContent = 'generating terrain…'
    regenerateTerrain()
  } catch (err) {
    console.error('DEM load failed:', err)
    loadingEl.textContent = 'elevation fetch failed — check connection'
    setTimeout(() => {
      loadingEl.classList.add('hidden')
      loadingEl.textContent = 'generating terrain…'
    }, 2600)
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
    loadingEl.textContent = `outside tile coverage (lon ${TAIWAN_BBOX.minLon}–${TAIWAN_BBOX.maxLon} / lat ${TAIWAN_BBOX.minLat}–${TAIWAN_BBOX.maxLat})`
    loadingEl.classList.remove('hidden')
    setTimeout(() => {
      loadingEl.classList.add('hidden')
      loadingEl.textContent = 'generating terrain…'
    }, 2600)
    return false
  }
  const { x, z } = heightField.projection.lonLatToWorld(lon, lat)
  _flyOffset.subVectors(camera.position, controls.target) // keep the current view offset
  const target = new THREE.Vector3(x, controls.target.y, z)
  flyTo(target.clone().add(_flyOffset), target)
  hud2.setStatic(params) // refresh the SECTOR location name
  return true
}

function applyPreset(name) {
  const p = DEM_PRESETS[name]
  if (!p) return // Custom: use the lat/lon fields + load button
  params.demLocation = name
  params.demLat = p[0]
  params.demLon = p[1]
  gui.controllersRecursive().forEach((c) => c.updateDisplay())
  if (params.source !== 'real') return
  if (heightField) flyToLonLat(p[1], p[0])
  else loadRealTerrain()
}

// radar scan: expands from wherever the pan target is when triggered, out to
// the fog wall (uScanR ≈ the P0 look of 42 units at the default fogFar 50;
// scaled with the far-view fogScale so the island view scans the island)
function triggerScan() {
  scanStart = performance.now() / 1000
  terrain.mapUniforms.uScanCenter.value.set(controls.target.x, controls.target.z)
  terrain.mapUniforms.uScanR.value = params.fogFar * fogScale * 0.84
}

let rebuildPending = false
function regenerateTerrain() {
  if (rebuildPending) return
  rebuildPending = true
  loadingEl.classList.remove('hidden')
  // let the indicator paint before the synchronous rebuild blocks the thread
  requestAnimationFrame(() =>
    setTimeout(() => {
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
      regenerateLabels()
      regenerateHud()
      refreshPoiAnchor()
      if (params.shadowMode === 'static') renderer.shadowMap.needsUpdate = true
      rebuildPending = false
      loadingEl.classList.add('hidden')
    }, 30)
  )
}

// where peaks/labels were last computed — the tick throttle refreshes them
// once the target wanders far enough from this anchor
const poiAnchor = new THREE.Vector2(0, 0)
function refreshPoiAnchor() {
  poiAnchor.set(controls.target.x, controls.target.z)
}

// ------------------------------------------------------------------ GUI

// dock the panel on the LEFT (below the title block) instead of lil-gui's
// default top-right auto-placement
const guiDock = document.createElement('div')
guiDock.id = 'gui-dock'
document.body.appendChild(guiDock)
const gui = new GUI({ title: 'TERRAIN ART / 001', container: guiDock })

const copyCtrl = gui
  .add(
    {
      async copy() {
        const json = JSON.stringify(params, null, 2)
        try {
          await navigator.clipboard.writeText(json)
        } catch {
          const ta = document.createElement('textarea')
          ta.value = json
          document.body.appendChild(ta)
          ta.select()
          document.execCommand('copy')
          ta.remove()
        }
        copyCtrl.name('copied ✓')
        setTimeout(() => copyCtrl.name('copy parameters'), 1200)
      },
    },
    'copy'
  )
  .name('copy parameters')

const fSource = gui.addFolder('Terrain source')
fSource
  .add(params, 'source', { 'procedural noise': 'noise', 'real world (DEM)': 'real' })
  .name('source')
  .onChange((v) => {
    if (v === 'real') loadRealTerrain()
    else regenerateTerrain()
  })
const latCtrl = { lat: null, lon: null, zoom: null }
fSource
  .add(params, 'demLocation', Object.keys(DEM_PRESETS))
  .name('location')
  .onChange(applyPreset) // fly-to inside the streamed world (no rebuild)
latCtrl.lat = fSource.add(params, 'demLat', -85, 85, 0.0001).name('latitude')
latCtrl.lon = fSource.add(params, 'demLon', -180, 180, 0.0001).name('longitude')
// P2: zoom is distance-driven — this is a read-only indicator of the current
// LOD target (params.demZoom mirrors lodZoom every frame via .listen())
latCtrl.zoom = fSource.add(params, 'demZoom', [10, 11, 12, 13]).name('lod (auto)').disable().listen()
fSource
  .add(params, 'demExaggeration', 0.5, 5, 0.1)
  .name('vertical scale')
  .onFinishChange(() => {
    if (params.source === 'real') regenerateTerrain()
  })
fSource
  .add(params, 'chunkRes', [32, 64, 128])
  .name('chunk resolution')
  .onFinishChange(() => {
    if (params.source === 'real') regenerateTerrain()
  })
fSource
  .add(
    {
      load: () => {
        if (heightField && params.source === 'real') flyToLonLat(params.demLon, params.demLat)
        else loadRealTerrain()
      },
    },
    'load'
  )
  .name('load location ⤓')

const fTerrain = gui.addFolder('Terrain')
fTerrain.add(params, 'seed', 1, 9999, 1).onFinishChange(regenerateTerrain)
fTerrain
  .add(
    {
      randomize() {
        params.seed = Math.floor(Math.random() * 9999) + 1
        gui.controllersRecursive().forEach((c) => c.updateDisplay())
        regenerateTerrain()
      },
    },
    'randomize'
  )
  .name('randomize seed')
fTerrain.add(params, 'scale', 0.04, 0.4, 0.005).onFinishChange(regenerateTerrain)
fTerrain.add(params, 'octaves', 2, 8, 1).onFinishChange(regenerateTerrain)
fTerrain.add(params, 'lacunarity', 1.6, 3.2, 0.05).onFinishChange(regenerateTerrain)
fTerrain.add(params, 'gain', 0.3, 0.7, 0.01).onFinishChange(regenerateTerrain)
fTerrain.add(params, 'amplitude', 0.5, 7, 0.1).onFinishChange(regenerateTerrain)
fTerrain.add(params, 'warp', 0, 6, 0.1).name('domain warp').onFinishChange(regenerateTerrain)
fTerrain.add(params, 'detail', 0, 0.8, 0.01).name('fine detail').onFinishChange(regenerateTerrain)
fTerrain.add(params, 'detailScale', 0.5, 6, 0.1).onFinishChange(regenerateTerrain)
fTerrain.add(params, 'resolution', [256, 384, 512, 768, 1024]).onFinishChange(regenerateTerrain)

const fSurface = gui.addFolder('Surface material')
fSurface.addColor(params, 'color').onChange(() => terrain.updateMaterial(params))
fSurface.add(params, 'roughness', 0, 1, 0.01).onFinishChange(() => terrain.rebuildRoughness(params))
fSurface
  .add(params, 'roughnessVariation', 0, 0.6, 0.01)
  .name('roughness noise')
  .onFinishChange(() => terrain.rebuildRoughness(params))
fSurface
  .add(params, 'roughnessScale', 1, 16, 0.5)
  .name('roughness scale')
  .onFinishChange(() => terrain.rebuildRoughness(params))
fSurface.add(params, 'bumpScale', 0, 2, 0.05).name('micro bump').onChange(() => terrain.updateMaterial(params))
fSurface.add(params, 'envMapIntensity', 0, 1.5, 0.05).name('env reflection').onChange(() => terrain.updateMaterial(params))

const fCamera = gui.addFolder('Camera & focus')
fCamera.add(params, 'fov', 20, 60, 1).onChange((v) => {
  camera.fov = v
  camera.updateProjectionMatrix()
})
fCamera.add(params, 'autoFocus').name('autofocus cone')
fCamera.add(params, 'focusDistance', 5, 60, 0.1).name('focus distance').listen()
fCamera.add(params, 'focusRange', 0.5, 25, 0.1).name('focus range').onChange((v) => {
  dof.cocMaterial.worldFocusRange = v
})
fCamera.add(params, 'bokehScale', 0, 8, 0.1).name('bokeh scale').onChange((v) => {
  dof.bokehScale = v
  dofPass.enabled = v > 0
})

const fMap = gui.addFolder('Map overlay')
fMap.add(params, 'mapTint', 0, 1, 0.02).name('hypsometric tint').onChange((v) => (terrain.mapUniforms.uTint.value = v))
fMap
  .add(params, 'heightContrast', 0.5, 20, 0.1)
  .name('height contrast')
  .onChange((v) => (terrain.mapUniforms.uHeightContrast.value = v))
fMap
  .add(params, 'heightPivot', 0, 1, 0.01)
  .name('height pivot')
  .onChange((v) => (terrain.mapUniforms.uHeightPivot.value = v))
const rebuildRamp = () => terrain.rebuildRamp(params)
fMap.addColor(params, 'gradLow').name('gradient: low').onChange(rebuildRamp)
fMap.addColor(params, 'gradMid1').name('gradient: mid 1').onChange(rebuildRamp)
fMap.addColor(params, 'gradMid2').name('gradient: mid 2').onChange(rebuildRamp)
fMap.addColor(params, 'gradHigh').name('gradient: high').onChange(rebuildRamp)
fMap.add(params, 'gradMid1Pos', 0, 1, 0.01).name('mid 1 position').onChange(rebuildRamp)
fMap.add(params, 'gradMid2Pos', 0, 1, 0.01).name('mid 2 position').onChange(rebuildRamp)
fMap
  .add(params, 'slopeTint', 0, 1, 0.02)
  .name('slope brown')
  .onChange((v) => (terrain.mapUniforms.uSlopeTint.value = v))
fMap
  .add(params, 'contourInterval', 0.04, 0.6, 0.01)
  .name('contour interval')
  .onChange((v) => (terrain.mapUniforms.uContourInterval.value = v))
fMap
  .add(params, 'contourOpacity', 0, 1, 0.02)
  .name('contour opacity')
  .onChange((v) => (terrain.mapUniforms.uContourOpacity.value = v))
fMap
  .addColor(params, 'contourColor')
  .name('contour color')
  .onChange((v) => terrain.mapUniforms.uContourColor.value.set(v))
fMap.add(params, 'gridStep', 2, 14, 0.5).name('grid size').onChange((v) => (terrain.mapUniforms.uGridStep.value = v))
fMap.add(params, 'gridOpacity', 0, 1, 0.02).name('grid opacity').onChange((v) => (terrain.mapUniforms.uGridOpacity.value = v))
fMap.add(params, 'labels').name('place labels').onChange((v) => (labels.visible = v))

const fLook = gui.addFolder('Look')
fLook.add(params, 'exposure', 0.2, 3, 0.02).onChange((v) => (exposureFx.uniforms.get('exposure').value = v))
fLook.add(params, 'contrast', -0.2, 0.5, 0.01).onChange((v) => (contrastFx.uniforms.get('contrast').value = v))
fLook.add(params, 'saturation', -1, 0, 0.02).onChange((v) => (hueSat.saturation = v))
fLook.add(params, 'vignette', 0, 1, 0.02).onChange((v) => (vignette.darkness = v))
fLook.add(params, 'grain', 0, 0.5, 0.01).onChange((v) => (grain.blendMode.opacity.value = v))
fLook.add(params, 'fogNear', 5, 60, 0.5).name('fog start').onChange((v) => (scene.fog.near = v))
fLook.add(params, 'fogFar', 15, 90, 0.5).name('fog end').onChange((v) => (scene.fog.far = v))
fLook.addColor(params, 'fogColor').onChange((v) => {
  scene.fog.color.set(v)
  scene.background.set(v)
})
fLook.add(params, 'surveyLines').name('survey circles').onChange((v) => (hud3.lines.visible = v))

const fHud = gui.addFolder('HUD')
fHud.add(params, 'hud').name('show HUD').onChange((v) => hud2.setVisible(v))
fHud.add(params, 'hudOpacity', 0, 1, 0.02).name('HUD opacity').onChange((v) => hud2.setOpacity(v))
fHud
  .add(params, 'uiBlur', 0, 30, 1)
  .name('panel blur')
  .onChange((v) => document.documentElement.style.setProperty('--hud-blur', `${v}px`))
fHud
  .add(params, 'uiBgOpacity', 0, 1, 0.02)
  .name('panel bg opacity')
  .onChange((v) => document.documentElement.style.setProperty('--hud-bg-alpha', v))
fHud
  .addColor(params, 'hudAccent')
  .name('accent color')
  .onChange((v) => {
    document.documentElement.style.setProperty('--hud-accent', v)
    regenerateHud()
  })
fHud
  .addColor(params, 'hudInk')
  .name('ink color')
  .onChange((v) => {
    document.documentElement.style.setProperty('--hud-ink', v)
    regenerateHud()
  })
fHud.add(params, 'sweepSpeed', 0, 3, 0.05).name('sweep speed')
fHud
  .addColor(params, 'scanColor')
  .name('scan color')
  .onChange((v) => terrain.mapUniforms.uScanColor.value.set(v))
fHud.add(params, 'scanDuration', 1, 8, 0.1).name('scan duration')
fHud
  .add(params, 'scanWidth', 0.05, 4, 0.05)
  .name('scan width')
  .onChange((v) => (terrain.mapUniforms.uScanWidth.value = v))
fHud
  .add(params, 'scanBlur', 0, 3, 0.02)
  .name('scan blur')
  .onChange((v) => (terrain.mapUniforms.uScanBlur.value = v))
fHud
  .add(params, 'scanDispHeight', 0, 2, 0.02)
  .name('wave height')
  .onChange((v) => (terrain.mapUniforms.uScanDispH.value = v))
fHud
  .add(params, 'scanDispFalloff', 0.1, 6, 0.05)
  .name('wave falloff')
  .onChange((v) => (terrain.mapUniforms.uScanDispW.value = v))
fHud.add({ scan: triggerScan }, 'scan').name('trigger scan')

const fMotion = gui.addFolder('Motion')
fMotion.add(params, 'coneSpin', 0, 3, 0.05).name('cone spin')
fMotion.add(params, 'coneTilt', 0, 0.5, 0.01).name('cursor tilt')
fMotion.add(params, 'coneDrift', 0, 2, 0.05).name('cursor drift')
fMotion.add(params, 'bob', 0, 0.3, 0.01).name('hover bob')
fMotion.add(params, 'ringSpeed', 0, 6, 0.1).name('ring speed')
fMotion.add(params, 'flyDuration', 0.4, 4, 0.1).name('fly duration')
fMotion.add(params, 'flyEasing', ['smooth', 'glide', 'linear']).name('fly easing')

const fTour = gui.addFolder('Tour')
let tourFromCtrl = fTour.add(params, 'tourFrom', pois.map((p) => p.id)).name('from')
let tourToCtrl = fTour.add(params, 'tourTo', pois.map((p) => p.id)).name('to')

// POI ids change whenever the terrain regenerates (real peak names vs PK-xx) —
// rebuild both dropdowns and keep them at the top of the folder
function refreshTourOptions() {
  const ids = pois.map((p) => p.id)
  if (!ids.includes(params.tourFrom)) params.tourFrom = ids[0]
  if (!ids.includes(params.tourTo)) params.tourTo = ids[1] ?? ids[0]
  tourFromCtrl = tourFromCtrl.options(ids).name('from')
  tourToCtrl = tourToCtrl.options(ids).name('to')
  fTour.$children.prepend(tourToCtrl.domElement)
  fTour.$children.prepend(tourFromCtrl.domElement)
}
fTour.add(params, 'tourDuration', 4, 40, 0.5).name('duration (s)')
fTour.add(params, 'tourAltitude', 0.8, 10, 0.1).name('altitude')
fTour.add(params, 'tourSmoothing', 0, 1, 0.02).name('path smoothing')
fTour.add(params, 'tourLook', 0.02, 0.3, 0.01).name('look ahead')
fTour.add(params, 'tourBank', 0, 3, 0.05).name('bank into turns')
fTour.add({ start: startTour }, 'start').name('▶ start tour')
fTour.add(
  {
    stop: () => {
      tour.active = false
      camera.up.set(0, 1, 0)
    },
  },
  'stop'
).name('■ stop')

const fPerf = gui.addFolder('Performance')
fPerf
  .add(params, 'pixelRatio', 0.5, 2, 0.05)
  .name('render scale')
  .onChange((v) => {
    renderer.setPixelRatio(v)
    composer.setSize(window.innerWidth, window.innerHeight)
  })
fPerf.add(params, 'shadowMode', ['dynamic', 'static', 'off']).name('shadows').onChange(applyShadowMode)
fPerf
  .add(params, 'shadowRes', [1024, 2048, 4096])
  .name('shadow resolution')
  .onChange((v) => {
    sun.shadow.mapSize.set(v, v)
    if (sun.shadow.map) {
      sun.shadow.map.dispose()
      sun.shadow.map = null
    }
    if (params.shadowMode === 'static') renderer.shadowMap.needsUpdate = true
  })
fMotion.add(params, 'paused')

const fLight = gui.addFolder('Light')
fLight.add(params, 'sunIntensity', 0, 16, 0.1).onChange(placeSun)
fLight.add(params, 'sunAzimuth', 0, 360, 1).onChange(placeSun)
fLight.add(params, 'sunElevation', 5, 85, 1).onChange(placeSun)
fLight.add(params, 'hemiIntensity', 0, 2, 0.05).name('ambient').onChange(placeSun)
fLight
  .add(params, 'envLight', 0, 1.5, 0.02)
  .name('env light (shadow fill)')
  .onChange((v) => (scene.environmentIntensity = v))
fLight
  .add(params, 'shadowSoftness', 0, 30, 0.5)
  .name('shadow softness')
  .onChange((v) => (sun.shadow.radius = v))

// only Terrain source starts expanded (Tour closed too — the GUI now docks on
// the left and a fully expanded column would cover the bottom-left telemetry)
fTour.close()
fTerrain.close()
fSurface.close()
fCamera.close()
fMap.close()
fLook.close()
fHud.close()
fMotion.close()
fPerf.close()
fLight.close()

// ------------------------------------------------------------------ loop

// console access for debugging/scripting
window.__exp = {
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
  get labels() { return labels },
  get heightField() { return heightField },
  get fps() { return fps },
  stats() {
    return {
      chunks: terrain.chunkMap.size,
      queue: chunkManager.queue.length,
      tiles: terrain.heightFields ? [...terrain.heightFields.values()].reduce((n, f) => n + f.tiles.size, 0) : 0,
      tileStats: heightField ? { ...heightField.stats } : null,
      lod: lodZoom,
      dist: +camera.position.distanceTo(controls.target).toFixed(1),
      fogScale: +fogScale.toFixed(2),
      fps: Math.round(fps),
    }
  },
}

// real world is the default source — fetch its tiles on startup
if (params.source === 'real') loadRealTerrain()

const clock = new THREE.Clock()

function tick() {
  requestAnimationFrame(tick)
  const dt = Math.min(clock.getDelta(), 0.05)
  const t = clock.elapsedTime

  // cinematic tour: arc-length uniform speed + trapezoid profile + damped gimbal
  if (tour.active) {
    tour.t = Math.min(1, tour.t + dt / params.tourDuration)
    const s = trapezoid(tour.t, 0.18)

    // position: exact on the spline, constant speed thanks to getPointAt
    tour.curve.getPointAt(s, _tp)
    camera.position.copy(_tp)

    // desired orientation: look at the gaze target, rolled into the turn
    tourGaze(s, _tp, _tg)
    controls.target.copy(_tg)
    _tm.lookAt(camera.position, _tg, UP)
    _tq.setFromRotationMatrix(_tm)
    tour.curve.getTangentAt(s, _tt0)
    tour.curve.getTangentAt(Math.min(s + 0.02, 1), _tt1)
    const curl = _tt0.x * _tt1.z - _tt0.z * _tt1.x // signed xz turn over the window
    const arrived = tour.t >= 1
    // after arrival: settle — unwind the bank and let the gimbal fully converge
    // before handing off, so OrbitControls has nothing to snap to
    const bankTarget = arrived ? 0 : THREE.MathUtils.clamp(curl * 15 * params.tourBank, -0.5, 0.5)
    tour.bank = THREE.MathUtils.damp(tour.bank, bankTarget, 2.5, dt)
    _tq.multiply(_tqr.setFromAxisAngle(Z_AXIS, tour.bank))

    // gimbal: rotation chases the desired orientation with a max slew rate,
    // so it can never jump — 80°/s hard ceiling
    const angle = camera.quaternion.angleTo(_tq)
    if (angle > 1e-5) {
      const f = Math.min(1 - Math.exp(-3.2 * dt), (1.4 * dt) / angle)
      camera.quaternion.slerp(_tq, f)
    }

    if (arrived && angle < 0.001 && Math.abs(tour.bank) < 0.001) tour.active = false
  } else if (tween.active) {
    tween.t = Math.min(1, tween.t + dt / params.flyDuration)
    const e = EASINGS[params.flyEasing](tween.t)
    camera.position.lerpVectors(tween.p0, tween.p1, e)
    controls.target.lerpVectors(tween.t0, tween.t1, e)
    camera.lookAt(controls.target)
    if (tween.t >= 1) tween.active = false
  } else {
    controls.update()
    clampPan() // free navigation only — tours / fly-tos manage their own path
  }

  // P2: distance LOD + far-view scaling. At dist ≤ D0 everything resolves to
  // exactly the P1 values (fogScale = 1); dollying out pushes the fog wall,
  // contour interval and survey grid out proportionally (the map "morphs" to
  // the new scale), fades the shadows, and re-targets the LOD rings through
  // the hysteresis.
  const camDist = camera.position.distanceTo(controls.target)
  const realMode = params.source === 'real' && heightField
  fogScale = realMode ? Math.max(1, camDist / LOD_D0) : 1
  scene.fog.near = params.fogNear * fogScale
  scene.fog.far = params.fogFar * fogScale
  terrain.mapUniforms.uContourInterval.value = params.contourInterval * fogScale
  terrain.mapUniforms.uGridStep.value = params.gridStep * fogScale
  updateShadowScale(realMode ? camDist : LOD_D0)
  if (realMode) {
    const z = nextLodZoom(camDist)
    if (z !== lodZoom) {
      lodZoom = z
      params.demZoom = z // GUI "lod (auto)" indicator
      if (!rebuildPending) {
        // far/near label policies changed — re-sow peaks + spot elevations now
        refreshPoiAnchor()
        regenerateHud()
        regenerateLabels()
      }
    }
  }

  // chunk streaming + shadow frustum follow the pan target every frame
  // (also during tours/flights, so terrain grows along the flight path)
  chunkManager.update(dt, controls.target.x, controls.target.z)
  updateSunAnchor()

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
      hud2.setGps(ll.lat, ll.lon, lodZoom)
    }
  }

  // peaks + spot labels follow the pan target: refresh once it wanders far
  // enough from the last anchor (throttled; skipped mid-flight/tour so POI
  // sets don't churn under an active animation)
  poiAcc += dt
  if (poiAcc > 2) {
    poiAcc = 0
    if (params.source === 'real' && heightField && !tour.active && !tween.active && !rebuildPending) {
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
  dof.cocMaterial.worldFocusDistance = params.focusDistance

  if (params.hud) {
    fps += (1 / Math.max(dt, 1e-4) - fps) * 0.05
    const sph = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target))
    const secs = Math.floor(t)
    hud2.update(dt, camera, window.innerWidth, window.innerHeight, {
      conePoint: cone.getFocusPoint(),
      pois,
      az: THREE.MathUtils.radToDeg(sph.theta),
      el: 90 - THREE.MathUtils.radToDeg(sph.phi),
      focus: params.focusDistance,
      lod: params.source === 'real' && heightField ? lodZoom : null,
      fps,
      clock: `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`,
      coneAlt: cone.group.position.y,
      spin: params.coneSpin,
    })
  }

  composer.render(dt)
}
tick()

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
  composer.setSize(window.innerWidth, window.innerHeight)
})
