import * as THREE from 'three'
import { MapControls } from 'three/addons/controls/MapControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
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
import { RainOverlayEffect } from './rainOverlay.js'

// The "stage": renderer / camera / controls / lights / post chain, plus the
// per-frame view-scale machinery (distance LOD target, fogScale, shadow
// frustum follow + fade). Owns no world objects — the engine facade
// (index.js) builds the terrain/HUD world on top of this.

// ---------------------------------------------------------------- P2: distance LOD
// targetZoom = clamp(12 - round(log2(dist / D0)), 10, 13) with ±15% hysteresis
// on the crossover distances so the LOD never flaps at a boundary. fogScale
// is the master far-view multiplier: 1 at dist ≤ D0 (near view = exactly the
// P1 look), then fog wall / contour interval / survey grid / streaming radius
// all scale with it.
export const LOD_D0 = 30 // camera distance that maps to z12 (the P0/P1 default view)
export const LOD_MIN = 10
export const LOD_MAX = 13
const LOD_HYST = 1.15

// P2: the ±26 shadow frustum grows with fogScale up to 2×, then the shadow
// fades out entirely on the way to the island view (dist 60 → 120) — a huge
// VSM frustum is mush; slope tint + hypso carry the far relief instead.
const SHADOW_BASE = 26

export function createStage(params, container) {
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
  // wall; near drops to 0.02 (was 0.5) so a hillside close-up (minDistance
  // 0.25, see below) doesn't clip into the terrain — ratio 150000, still
  // comfortably inside 24-bit depth since fog + streaming radius keep
  // anything near the 3000 far plane from ever rendering opaque
  const camera = new THREE.PerspectiveCamera(params.fov, window.innerWidth / window.innerHeight, 0.02, 3000)
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
  // 0.08 (was 0.25, before that 2) — ~40 m from the target, close enough for a
  // street-level look at the 3D buildings layer; index.js's tick() clamps
  // camera height to the ground sample so dollying this close never digs
  // into the terrain. near plane 0.02 (~10 m) still clears it comfortably.
  controls.minDistance = 0.08
  controls.maxDistance = 1000
  controls.update()

  let lodBase = 12 // unbiased hysteresis state: clamp(12 − round(log2(dist/30)), 10, 13)
  let lodZoom = 12 // published target = lodBase + detailBias, re-clamped to tile coverage
  let fogScale = 1

  // camera distance where the ideal zoom flips between z and z-1
  const lodCrossover = (z) => LOD_D0 * Math.pow(2, 12 - z + 0.5)
  function nextLodZoom(dist) {
    let z = lodBase
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

  function setShadowRes(v) {
    sun.shadow.mapSize.set(v, v)
    if (sun.shadow.map) {
      sun.shadow.map.dispose()
      sun.shadow.map = null
    }
    if (params.shadowMode === 'static') renderer.shadowMap.needsUpdate = true
  }

  // static shadow maps need a manual re-render whenever the world changes
  function shadowNeedsUpdate() {
    if (params.shadowMode === 'static') renderer.shadowMap.needsUpdate = true
  }

  // Environment-system override (src/engine/environment.js, docs/ENVIRONMENT_DESIGN.md):
  // sets the sun's DIRECTION only, from explicit az/el degrees rather than
  // params.sunAzimuth/sunElevation — lets envAuto drive the light off suncalc
  // without ever mutating those params (the manual-mode round-trip guarantee).
  // Intensity/color/hemi are the caller's job (environment.js sets stage.sun /
  // stage.hemi directly, both now exposed below).
  function placeSunAt(azDeg, elDeg) {
    const az = THREE.MathUtils.degToRad(azDeg)
    const el = THREE.MathUtils.degToRad(elDeg)
    const r = 34
    _sunOffset.set(Math.cos(az) * Math.cos(el) * r, Math.sin(el) * r, Math.sin(az) * Math.cos(el) * r)
    _sunAnchor.set(NaN, NaN) // force updateSunAnchor to re-place the light
    updateSunAnchor()
  }

  placeSun()
  // shadowMode isn't otherwise applied until a param change or a fade-driven
  // rescale — without this, renderer.shadowMap.autoUpdate stays at three's
  // built-in default (true) regardless of params.shadowMode
  applyShadowMode()

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

  // rain overlay (rainOverlay.js, docs/ENVIRONMENT_DESIGN.md §8): screen-space
  // streaks. MUST sit here — before the exposure/tonemap/grade merged pass
  // below, in the same toggleable slot dofPass occupies — and NOT as the
  // chain's last pass. First draft put it last (reasoning: read post-tonemap
  // colors for an accurate light/dark tint pick) and that broke on/off
  // toggling: EffectComposer.addPass() gives `renderToScreen` to whichever
  // pass was added most recently, and render() only writes the actual visible
  // canvas from whichever pass currently has that flag AND is enabled
  // (`if (pass.enabled) { pass.render(...) }` — a disabled pass's render()
  // never runs, full stop). With rain last, disabling it left NOTHING
  // painting the screen that frame — the canvas visibly froze on the last
  // rain frame forever (confirmed empirically: renderCount kept climbing
  // after weather→clear while the on-screen streaks never went away, fixed
  // immediately by moving the pass here). The always-on merged pass below
  // must stay the last-added pass so it keeps permanent renderToScreen
  // ownership — exactly the guarantee dofPass already relies on. Cost: rain's
  // luminance-based tint reads the pre-tonemap HDR linear buffer instead of
  // final graded colors (see rainOverlay.js's lum→lumTone compression for how
  // that's handled). Seed values here are placeholders; index.js's
  // applyRainOverlay() does the real initial sync right after HANDLERS is set
  // up (same two-step seed-then-apply() pattern environment.js uses).
  const rainOverlayFx = new RainOverlayEffect({ intensity: params.rainIntensity, wind: [0, 0] })
  const rainOverlayPass = new EffectPass(camera, rainOverlayFx)
  composer.addPass(rainOverlayPass)

  composer.addPass(new EffectPass(camera, exposureFx, toneMap, hueSat, contrastFx, grain, vignette, smaa))
  // skip the whole DOF pass when bokeh is zero — it's pure cost with no visual effect
  dofPass.enabled = params.bokehScale > 0
  // zero-cost while off — EffectComposer skips disabled passes entirely, same
  // guarantee dofPass relies on above (see the placement comment for why this
  // pass must NOT be last in the chain for that guarantee to hold safely).
  rainOverlayPass.enabled = params.rainVisible

  // shared viewport uniform for the fat-line materials (Line2/LineMaterial
  // needs the resolution to convert px linewidth → clip space): the overlay
  // modules install this exact Vector2 as their uniform value, so updating it
  // here updates every line material at once
  const lineResolution = new THREE.Vector2(window.innerWidth, window.innerHeight)

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
    composer.setSize(window.innerWidth, window.innerHeight)
    lineResolution.set(window.innerWidth, window.innerHeight)
  })

  return {
    renderer,
    scene,
    camera,
    controls,
    composer,
    lineResolution,
    sun,
    hemi, // exposed for environment.js — the only other writer of hemi.color/intensity
    dof,
    dofPass,
    exposureFx,
    contrastFx,
    hueSat,
    grain,
    vignette,
    rainOverlayFx,
    rainOverlayPass,
    get lodZoom() {
      return lodZoom
    },
    get fogScale() {
      return fogScale
    },
    clampPan,
    placeSun,
    placeSunAt,
    applyShadowMode,
    setShadowRes,
    shadowNeedsUpdate,
    updateSunAnchor,
    setPanBounds(b) {
      panBounds = b
    },
    setPixelRatio(v) {
      renderer.setPixelRatio(v)
      composer.setSize(window.innerWidth, window.innerHeight)
    },
    // P2 per-frame view scaling: fog wall follows the dolly distance, shadow
    // frustum grows/fades, and the LOD target re-evaluates through the
    // hysteresis. Returns lodChanged so the engine can re-sow labels/POIs.
    // envFogMul (docs/ENVIRONMENT_DESIGN.md §weather): a same-frame multiplier
    // on top of fogScale, e.g. ~0.55 in rain / ~0.4 in typhoon so the murk
    // closes in — driven every frame (not throttled) so it never lags behind
    // camera dolly the way a throttled ramp recompute would. 1 = no-op,
    // byte-for-byte the pre-weather fog math.
    tickView(camDist, realMode, envFogMul = 1) {
      // R2 viewRange: user-facing "view distance" folds into the same scale so
      // everything tied to the fog wall (streaming radius, scan, POI search,
      // contour/grid morphing) stretches together.
      fogScale = (realMode ? Math.max(1, camDist / LOD_D0) : 1) * (params.viewRange ?? 1)
      scene.fog.near = params.fogNear * fogScale * envFogMul
      scene.fog.far = params.fogFar * fogScale * envFogMul
      updateShadowScale(realMode ? camDist : LOD_D0)
      let lodChanged = false
      if (realMode) {
        lodBase = nextLodZoom(camDist)
        // detailBias (0|1, Settings 精緻度) lifts the whole LOD ladder one
        // level — including the far clamp, so the island view targets z11
        // (~150 land tiles) instead of z10 — capped at the z13 tile ceiling
        const z = THREE.MathUtils.clamp(lodBase + (params.detailBias ?? 0), LOD_MIN, LOD_MAX)
        if (z !== lodZoom) {
          lodZoom = z
          params.demZoom = z // GUI "lod (auto)" indicator
          lodChanged = true
        }
      }
      return lodChanged
    },
  }
}
