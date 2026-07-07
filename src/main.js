import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
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

// ------------------------------------------------------------------ params

const params = {
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
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
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

const camera = new THREE.PerspectiveCamera(params.fov, window.innerWidth / window.innerHeight, 0.5, 220)
camera.position.set(0, 18, 19)

const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, -0.3, 0)
controls.enableDamping = true
controls.dampingFactor = 0.06
controls.maxPolarAngle = Math.PI * 0.49
controls.minDistance = 6
controls.maxDistance = 60
controls.update()

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

const hemi = new THREE.HemisphereLight(0xdadada, 0x5c5c5c, params.hemiIntensity)
scene.add(hemi)

function placeSun() {
  const az = THREE.MathUtils.degToRad(params.sunAzimuth)
  const el = THREE.MathUtils.degToRad(params.sunElevation)
  const r = 34
  sun.position.set(Math.cos(az) * Math.cos(el) * r, Math.sin(el) * r, Math.sin(az) * Math.cos(el) * r)
  sun.intensity = params.sunIntensity
  hemi.intensity = params.hemiIntensity
}
placeSun()

// ------------------------------------------------------------------ world

const terrain = new Terrain(params)
scene.add(terrain.mesh)

const cone = createCone()
scene.add(cone.group)

let labels = createLabels(terrain.sample, params.seed)
labels.visible = params.labels
scene.add(labels)

function regenerateLabels() {
  scene.remove(labels)
  disposeLabels(labels)
  labels = createLabels(terrain.sample, params.seed)
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

let pois = findPois(terrain.sample, params.seed)
let hud3 = createHud3D(params.seed, pois, { ink: params.hudInk, accent: params.hudAccent })
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

const hud2 = createHud2D({
  onSelectPoi(i) {
    selectedPoi = i
    const p = pois[i]
    hud2.setSelected(i, p)
    const dir = new THREE.Vector3(p.x, 0, p.z).normalize()
    flyTo(new THREE.Vector3(p.x + dir.x * 6.5, p.h + 4.2, p.z + dir.z * 6.5), new THREE.Vector3(p.x, p.h + 0.6, p.z))
  },
  onDeselect() {
    selectedPoi = -1
    hud2.setSelected(-1, null)
    flyTo(HOME.pos, HOME.target)
  },
  onScan() {
    scanStart = performance.now() / 1000
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

// user grabbing the camera cancels any fly-to
controls.addEventListener('start', () => (tween.active = false))

function regenerateHud() {
  scene.remove(hud3.group)
  hud3.dispose()
  pois = findPois(terrain.sample, params.seed)
  hud3 = createHud3D(params.seed, pois, { ink: params.hudInk, accent: params.hudAccent })
  hud3.lines.visible = params.surveyLines
  scene.add(hud3.group)
  hud2.setPois(pois)
  hud2.setStatic(params)
  selectedPoi = -1
  hud2.setSelected(-1, null)
}

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

composer.addPass(new EffectPass(camera, dof))
composer.addPass(new EffectPass(camera, exposureFx, toneMap, hueSat, contrastFx, grain, vignette, smaa))

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
      regenerateLabels()
      regenerateHud()
      rebuildPending = false
      loadingEl.classList.add('hidden')
    }, 30)
  )
}

// ------------------------------------------------------------------ GUI

const gui = new GUI({ title: 'EXPERIMENT / 001' })

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
fHud.add({ scan: () => (scanStart = performance.now() / 1000) }, 'scan').name('trigger scan')

const fMotion = gui.addFolder('Motion')
fMotion.add(params, 'coneSpin', 0, 3, 0.05).name('cone spin')
fMotion.add(params, 'coneTilt', 0, 0.5, 0.01).name('cursor tilt')
fMotion.add(params, 'coneDrift', 0, 2, 0.05).name('cursor drift')
fMotion.add(params, 'bob', 0, 0.3, 0.01).name('hover bob')
fMotion.add(params, 'ringSpeed', 0, 6, 0.1).name('ring speed')
fMotion.add(params, 'flyDuration', 0.4, 4, 0.1).name('fly duration')
fMotion.add(params, 'flyEasing', ['smooth', 'glide', 'linear']).name('fly easing')
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

fTerrain.close()
fLight.close()

// ------------------------------------------------------------------ loop

// console access for debugging/scripting
window.__exp = { scene, camera, controls, params, terrain, get labels() { return labels } }

const clock = new THREE.Clock()

function tick() {
  requestAnimationFrame(tick)
  const dt = Math.min(clock.getDelta(), 0.05)
  const t = clock.elapsedTime

  // camera fly-to: timed ease with controls paused so damping can't fight the tween
  if (tween.active) {
    tween.t = Math.min(1, tween.t + dt / params.flyDuration)
    const e = EASINGS[params.flyEasing](tween.t)
    camera.position.lerpVectors(tween.p0, tween.p1, e)
    controls.target.lerpVectors(tween.t0, tween.t1, e)
    camera.lookAt(controls.target)
    if (tween.t >= 1) tween.active = false
  } else {
    controls.update()
  }

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
