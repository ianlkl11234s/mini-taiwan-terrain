import * as THREE from 'three'
// suncalc's ESM build (v2.0.1) has NO default export, only named ones —
// `import SunCalc from 'suncalc'` silently resolves to undefined under Vite.
import { getPosition as sunCalcGetPosition, getMoonPosition as sunCalcGetMoonPosition } from 'suncalc'
import { Sky } from 'three/addons/objects/Sky.js'
import * as timeStore from '../state/timeStore.js'

// Environment system (docs/ENVIRONMENT_DESIGN.md, Phase 1 of
// docs/IMMERSIVE_MODE_RESEARCH.md): wires the timeline to the sun's real
// position (suncalc) and drives sun/hemi light, fog/background, an
// atmospheric Sky dome, and the sea shader's env uniforms off a time-of-day
// "ramp" + a weather modifier (clear/rain/typhoon). This is a SCENE-LEVEL
// system, not a Layer — it never touches the LayerManager and has no Layers
// panel row; its UI is Settings.jsx's "環境 Environment" section.
//
// Hard guarantee: params.envAuto=false must reproduce the exact pre-existing
// look (see applyManual below) — this module only ever READS params, never
// overwrites params.sunAzimuth/sunElevation/fogColor/etc, so turning envAuto
// off always lands back on whatever the user's manual sliders say.

// Observation point: Taiwan's geographic center (fixed — a per-region sun
// isn't worth the complexity for an island this size; the azimuth/elevation
// swing across it is a couple of degrees at most).
const LAT = 23.7
const LON = 121.0

// suncalc trap (README/most tutorials describe v1's radians + "measured from
// south" convention): the installed suncalc is v2.0.1, whose getPosition()
// returns DEGREES already, with a STANDARD COMPASS azimuth (0=N, 90=E,
// 180=S, 270=W, clockwise) — verified empirically (node -e SunCalc.getPosition
// probe against known Taiwan sunrise/noon/sunset geometry) before wiring this
// in, specifically BECAUSE this is the easiest place to get backwards.
//
// placeSun()'s own convention (scene.js): az=0 -> sun sits due EAST
// (world +X), az=90 -> due SOUTH (world +Z), i.e. engineAz = compassAz - 90.
// altitude is already "degrees above horizon", same meaning as sunElevation,
// no conversion needed.
function computeSunAngles(unixSeconds) {
  const date = new Date(unixSeconds * 1000)
  const pos = sunCalcGetPosition(date, LAT, LON)
  const az = ((pos.azimuth - 90) % 360 + 360) % 360
  const el = pos.altitude
  return { az, el }
}

// same degrees/compass convention as getPosition (probed the same way)
function computeMoonAngles(unixSeconds) {
  const date = new Date(unixSeconds * 1000)
  const pos = sunCalcGetMoonPosition(date, LAT, LON)
  const az = ((pos.azimuth - 90) % 360 + 360) % 360
  const el = pos.altitude
  return { az, el }
}

// Stylized moonlight: fades in as the sun drops -6°..-12°, fixed brightness
// regardless of lunar phase (a physically-honest new-moon night is just a
// black screen), real moon position when it's meaningfully above the horizon,
// a fixed pleasant angle otherwise (so the night look never degenerates).
const MOON_START_EL = -6
const MOON_FULL_EL = -12
const MOON_COEF = 0.12
const MOON_MIN_EL = 8
const MOON_FALLBACK_AZ = 210
const MOON_FALLBACK_EL = 45
const _moonColor = new THREE.Color('#b9c9e8')

// ceiling for the SHADING light's elevation (see the clamp in applyAuto) —
// twice the manual default 19° keeps midday clearly brighter/flatter than
// morning while never reaching the blown-out overhead regime.
const SUN_EL_MAX = 38

// unit sun direction in the engine's world axes — same formula placeSun()/
// placeSunAt() use for the light offset and typhoon.js's applyLight() uses
// for its cloud lighting; kept in one place here since environment.js also
// needs it for the sea shader's uSunDir and the Sky dome's sunPosition.
const _dir = new THREE.Vector3()
function sunDirection(azDeg, elDeg) {
  const az = THREE.MathUtils.degToRad(azDeg)
  const el = THREE.MathUtils.degToRad(elDeg)
  return _dir.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize()
}

function angDelta(a, b) {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

// ---------------------------------------------------------------- time-of-day ramp
// Keyframes by solar elevation (degrees). 'DAY' is a marker resolved to the
// user's live params.fogColor at eval time (never a params overwrite — see
// module header) so a custom fogColor (e.g. the satellite look documented in
// typhoon.js) still comes back at midday even with envAuto on.
const DAY = 'DAY'
const RAMP = [
  // 深夜 el < -12: flat dark-navy/moonlight — two stops at the same values so
  // everything below -12 clamps to this exact look (no further darkening).
  { el: -90, env: 0.15, sun: 0, sunColor: '#0d1b2e', hemi: 0.28, hemiSky: '#2a3b5c', hemiGround: '#0a0f1a', fog: '#152238', sky: '#101b30', envTint: 0.38, turbidity: 2, rayleigh: 0.4, mie: 0.004 },
  { el: -12, env: 0.15, sun: 0, sunColor: '#0d1b2e', hemi: 0.28, hemiSky: '#2a3b5c', hemiGround: '#0a0f1a', fog: '#152238', sky: '#101b30', envTint: 0.38, turbidity: 2, rayleigh: 0.4, mie: 0.004 },
  // 曙暮 -12..0: blue-violet twilight belt sliding toward the horizon glow
  { el: -4, env: 0.25, sun: 0.04, sunColor: '#7d6a86', hemi: 0.1, hemiSky: '#2b3a55', hemiGround: '#11131c', fog: '#3c3f5e', sky: '#2c3557', envTint: 0.4, turbidity: 4, rayleigh: 1.3, mie: 0.012 },
  // 金色時刻 0..8: warm horizon glow
  { el: 0, env: 0.5, sun: 0.14, sunColor: '#ff9a5c', hemi: 0.08, hemiSky: '#5a4a63', hemiGround: '#241d2c', fog: '#f0b487', sky: '#f6c89a', envTint: 0.55, turbidity: 8, rayleigh: 2.4, mie: 0.02 },
  { el: 8, env: 0.85, sun: 0.75, sunColor: '#ffe0b0', hemi: 0.02, hemiSky: '#cfd8dc', hemiGround: '#8a8f92', fog: DAY, sky: '#dfe6e2', envTint: 0.88, turbidity: 4.5, rayleigh: 1.4, mie: 0.01 },
  // 白天 8..35 -> 正午 >35: near the neutral pre-existing look (hemiSky/Ground
  // match HemisphereLight's own 0xdadada/0x5c5c5c constructor defaults; env 1.0
  // = exactly params.envLight). sun sits BELOW 1.0 and the shading light's
  // elevation is clamped to SUN_EL_MAX in applyAuto — a real overhead sun at
  // coef 1.0 lit flat terrain ~2.6x brighter than the manual 19° look and
  // washed the whole vista out (user feedback 2026-07-18).
  { el: 35, env: 1.0, sun: 0.85, sunColor: '#ffffff', hemi: 0, hemiSky: '#dadada', hemiGround: '#5c5c5c', fog: DAY, sky: '#dfe6e2', envTint: 1.0, turbidity: 2.2, rayleigh: 1.0, mie: 0.006 },
  { el: 90, env: 1.0, sun: 0.85, sunColor: '#ffffff', hemi: 0, hemiSky: '#dadada', hemiGround: '#5c5c5c', fog: DAY, sky: '#dfe6e2', envTint: 1.0, turbidity: 1.6, rayleigh: 0.85, mie: 0.004 },
]
// pre-parse every non-DAY hex once (module load, not per-apply)
for (const stop of RAMP) {
  stop._sunColor = new THREE.Color(stop.sunColor)
  stop._hemiSky = new THREE.Color(stop.hemiSky)
  stop._hemiGround = new THREE.Color(stop.hemiGround)
  stop._fog = stop.fog === DAY ? null : new THREE.Color(stop.fog)
  stop._sky = new THREE.Color(stop.sky)
}

const _fogBaselineScratch = new THREE.Color()
function lerpColor(out, a, b, t) {
  return out.copy(a).lerp(b, t)
}

// evaluate the ramp at a given elevation -> a plain object of resolved values
// (colors are freshly-lerped THREE.Color instances — cheap at the ~250ms
// throttled call rate this runs at, see tick() below)
function evalRamp(elDeg, fogBaseline) {
  let lo = RAMP[0]
  let hi = RAMP[RAMP.length - 1]
  for (let i = 0; i < RAMP.length - 1; i++) {
    if (elDeg >= RAMP[i].el && elDeg <= RAMP[i + 1].el) {
      lo = RAMP[i]
      hi = RAMP[i + 1]
      break
    }
  }
  if (elDeg <= RAMP[0].el) {
    lo = hi = RAMP[0]
  } else if (elDeg >= RAMP[RAMP.length - 1].el) {
    lo = hi = RAMP[RAMP.length - 1]
  }
  const span = hi.el - lo.el
  const t = span > 0 ? THREE.MathUtils.clamp((elDeg - lo.el) / span, 0, 1) : 0
  const loFog = lo._fog ?? fogBaseline
  const hiFog = hi._fog ?? fogBaseline
  return {
    sun: THREE.MathUtils.lerp(lo.sun, hi.sun, t),
    sunColor: lerpColor(new THREE.Color(), lo._sunColor, hi._sunColor, t),
    hemi: THREE.MathUtils.lerp(lo.hemi, hi.hemi, t),
    hemiSky: lerpColor(new THREE.Color(), lo._hemiSky, hi._hemiSky, t),
    hemiGround: lerpColor(new THREE.Color(), lo._hemiGround, hi._hemiGround, t),
    fog: lerpColor(new THREE.Color(), loFog, hiFog, t),
    sky: lerpColor(new THREE.Color(), lo._sky, hi._sky, t),
    env: THREE.MathUtils.lerp(lo.env, hi.env, t),
    envTint: THREE.MathUtils.lerp(lo.envTint, hi.envTint, t),
    turbidity: THREE.MathUtils.lerp(lo.turbidity, hi.turbidity, t),
    rayleigh: THREE.MathUtils.lerp(lo.rayleigh, hi.rayleigh, t),
    mie: THREE.MathUtils.lerp(lo.mie, hi.mie, t),
  }
}

// ---------------------------------------------------------------- weather modifier
// A modifier layered ON TOP of the ramp — only meaningful while envAuto is on
// (manual mode ignores weather's light/fog effects entirely; rain/typhoon
// still show their own particle/cloud layers regardless of envAuto, see
// index.js's weather HANDLER — this modifier is the "mood" half only).
const WEATHER = {
  clear: { sunMul: 1, envMul: 1, tint: null, tintAmt: 0, fogTintAmt: 0, envTintMul: 1, turbidityMul: 1, fogMul: 1 },
  rain: { sunMul: 0.35, envMul: 0.8, tint: '#9aa4ad', tintAmt: 0.35, fogTintAmt: 0.5, envTintMul: 0.85, turbidityMul: 1.6, fogMul: 0.55 },
  typhoon: { sunMul: 0.18, envMul: 0.6, tint: '#6b7a72', tintAmt: 0.5, fogTintAmt: 0.55, envTintMul: 0.6, turbidityMul: 2.2, fogMul: 0.4 },
}
for (const w of Object.values(WEATHER)) w._tint = w.tint ? new THREE.Color(w.tint) : null

export function createEnvironment(params, stage, { regionLayer, invalidate }) {
  const scene = stage.scene

  // Sky dome (Preetham/three-addons). Scaled to sit well inside the 3000-unit
  // far plane (see scene.js) — recentred on the camera every visible frame
  // (tick() below) so it always surrounds the viewer regardless of pan/dolly,
  // the standard "camera-centered skybox" trick.
  const SKY_SCALE = 2400
  const SKY_HIDE_EL = -10 // below this the Preetham model has nothing useful to show (see docs §known limitations)
  const sky = new Sky()
  sky.scale.setScalar(SKY_SCALE)
  sky.visible = false
  scene.add(sky)

  let lastAz = NaN
  let lastEl = NaN
  let lastState = null // last computed {az, el, ramp, weather} — window.__exp.environment

  function fogBaseline() {
    return _fogBaselineScratch.set(params.fogColor)
  }

  function applyAuto() {
    const { az, el } = computeSunAngles(timeStore.getTime())
    const ramp = evalRamp(el, fogBaseline())
    const w = WEATHER[params.weather] ?? WEATHER.clear

    // sun: coefficient x user baseline (never overwrites params.sunIntensity)
    const sunCoef = ramp.sun * w.sunMul
    const sunColor = w._tint ? ramp.sunColor.clone().lerp(w._tint, w.tintAmt) : ramp.sunColor
    // hemi: ADDITIVE on top of the user's hemiIntensity baseline (default 0)
    // — a coefficient wouldn't work here since 0 x anything is always 0,
    // which would silence the night-moonlight/day-sky-fill effect entirely
    // for the overwhelming majority of users who never touch that slider.
    const hemiIntensity = params.hemiIntensity + ramp.hemi
    const hemiSky = w._tint ? ramp.hemiSky.lerp(w._tint, w.tintAmt * 0.6) : ramp.hemiSky
    const hemiGround = w._tint ? ramp.hemiGround.lerp(w._tint, w.tintAmt * 0.6) : ramp.hemiGround
    const fogColor = w._tint ? ramp.fog.lerp(w._tint, w.fogTintAmt) : ramp.fog
    const skyColor = w._tint ? ramp.sky.lerp(w._tint, w.tintAmt) : ramp.sky
    const envTint = ramp.envTint * w.envTintMul
    const turbidity = ramp.turbidity * w.turbidityMul

    // moonlight takeover: as the sun sinks past -6° the directional light
    // hands over to the moon (see MOON_* consts above) so night keeps gentle
    // shadows and shape definition instead of going flat black.
    const moonT = THREE.MathUtils.clamp((MOON_START_EL - el) / (MOON_START_EL - MOON_FULL_EL), 0, 1)
    let lightAz = az
    let lightEl = el
    let lightIntensity = sunCoef * params.sunIntensity
    let lightColor = sunColor
    if (moonT > 0) {
      const moon = computeMoonAngles(timeStore.getTime())
      const real = moon.el > MOON_MIN_EL
      lightAz = real ? moon.az : MOON_FALLBACK_AZ
      lightEl = real ? moon.el : MOON_FALLBACK_EL
      lightIntensity = Math.max(lightIntensity, MOON_COEF * moonT * w.sunMul * params.sunIntensity)
      lightColor = _moonColor
    } else {
      // cartographic light clamp: ground irradiance goes with cos(incidence),
      // so a real midday sun (55-60° in July) lights flat terrain ~2.6x
      // brighter than the classic manual look's 19° modeling sun AND kills the
      // relief shading — a vista at noon read as blown-out white (user
      // feedback, 2026-07-18). Shading light never climbs past this; the Sky
      // dome below still tracks the REAL solar position, so the sky/horizon
      // keep honest time-of-day colors. Azimuth stays real — shadows still
      // swing east→west through the day.
      lightEl = Math.min(lightEl, SUN_EL_MAX)
    }

    // reposition the actual directional light only when it moved enough to
    // matter — angles are recomputed every apply() (cheap trig), but
    // placeSunAt() forces a VSM shadow-map re-render (static mode)
    // unconditionally, so gate that behind a ~0.5deg threshold
    // (docs/ENVIRONMENT_DESIGN.md) instead of re-baking every throttled tick.
    if (!Number.isFinite(lastAz) || angDelta(lightAz, lastAz) > 0.5 || Math.abs(lightEl - lastEl) > 0.5) {
      stage.placeSunAt(lightAz, lightEl)
      lastAz = lightAz
      lastEl = lightEl
    }
    stage.sun.intensity = lightIntensity
    stage.sun.color.copy(lightColor)
    stage.hemi.intensity = hemiIntensity
    stage.hemi.color.copy(hemiSky)
    stage.hemi.groundColor.copy(hemiGround)
    // RoomEnvironment IBL is the dominant fill on the mostly-unshaded paper
    // albedo — without ramping it down the map stays daylight-bright all night
    // (caught in acceptance: 21:00 looked identical to 17:45).
    scene.environmentIntensity = params.envLight * ramp.env * w.envMul

    scene.fog.color.copy(fogColor)
    scene.background.copy(fogColor)

    sky.visible = el > SKY_HIDE_EL
    if (sky.visible) {
      const dir = sunDirection(az, el)
      sky.material.uniforms.sunPosition.value.copy(dir)
      sky.material.uniforms.turbidity.value = turbidity
      sky.material.uniforms.rayleigh.value = ramp.rayleigh
      sky.material.uniforms.mieCoefficient.value = ramp.mie
    }

    const su = regionLayer.getSeaEnvUniforms()
    su.uSkyColor.value.copy(skyColor)
    su.uSunDir.value.copy(sunDirection(lightAz, lightEl)) // moon glint on the sea at night
    su.uEnvTint.value.setRGB(envTint, envTint, envTint)

    lastState = { az, el, moon: moonT > 0, lightAz, lightEl, weather: params.weather, sunIntensity: stage.sun.intensity, hemiIntensity, envIBL: scene.environmentIntensity, fogColor: '#' + fogColor.getHexString(), skyColor: '#' + skyColor.getHexString(), envTint, turbidity, skyVisible: sky.visible }
  }

  // exact pre-existing behaviour — envAuto=false must reproduce this
  // byte-for-byte (see module header). Reuses stage.placeSun() (the original,
  // params-driven function) rather than re-deriving the math here.
  function applyManual() {
    stage.placeSun()
    stage.sun.color.set(0xffffff)
    stage.hemi.color.set(0xdadada)
    stage.hemi.groundColor.set(0x5c5c5c)
    scene.environmentIntensity = params.envLight
    scene.fog.color.set(params.fogColor)
    scene.background.set(params.fogColor)
    sky.visible = false

    const su = regionLayer.getSeaEnvUniforms()
    su.uSkyColor.value.set(0.8745, 0.902, 0.8863)
    su.uSunDir.value.copy(sunDirection(params.sunAzimuth, params.sunElevation))
    su.uEnvTint.value.set(1, 1, 1)
    lastAz = params.sunAzimuth
    lastEl = params.sunElevation
    lastState = null
  }

  function apply() {
    if (params.envAuto) applyAuto()
    else applyManual()
    invalidate()
  }

  // discrete timeline changes (seek/play/pause/setSpeed) — fires regardless of
  // playing state, so scrubbing while PAUSED still moves the sun.
  const offTimeStore = timeStore.subscribe(() => {
    if (params.envAuto) applyAuto()
  })

  // continuous playback: raw subscribe() above does NOT fire per-frame while
  // playing (docs/TIMELINE_DESIGN.md §1.3), so the engine's active-frame tick
  // calls this every non-idle frame; internally throttled to ~250ms so
  // suncalc/ramp math doesn't run 60x/sec for a light that barely moves
  // frame-to-frame. Sky recentring on the camera is NOT throttled (must track
  // every active frame, camera movement is independent of playback).
  const APPLY_THROTTLE_MS = 250
  let accMs = 0
  function tick(dt) {
    if (sky.visible) sky.position.copy(stage.camera.position)
    if (!needsFrameLoop()) return
    accMs += dt * 1000
    if (accMs < APPLY_THROTTLE_MS) return
    accMs = 0
    applyAuto()
  }

  // isAnimating() gate: keeping the frame loop alive for the sun is only worth
  // it when playback is fast enough that it visibly sweeps (>= 60x ≈ 0.25°/s).
  // Live-follow at 1x moves 0.25°/min — burning ambient frames for that would
  // mean the app never idles again (timeline plays by default).
  const FAST_PLAYBACK_SPEED = 60
  function needsFrameLoop() {
    return params.envAuto && timeStore.getPlaying() && timeStore.getSpeed() >= FAST_PLAYBACK_SPEED
  }

  // slow/live playback stays fully frozen instead: this sparse wall-clock timer
  // recomputes the sun every 10s and repaints exactly one frame once it drifted
  // far enough to see (~40s of real time at 1x).
  const SLOW_POLL_MS = 10_000
  const SLOW_APPLY_DEG = 0.15
  const slowTimer = setInterval(() => {
    if (!(params.envAuto && timeStore.getPlaying()) || needsFrameLoop()) return
    const { az, el } = computeSunAngles(timeStore.getTime())
    if (lastState && angDelta(az, lastState.az) < SLOW_APPLY_DEG && Math.abs(el - lastState.el) < SLOW_APPLY_DEG) return
    applyAuto()
    invalidate()
  }, SLOW_POLL_MS)

  // multiplier scene.js's tickView folds into fog.near/far EVERY frame (not
  // throttled — must track camera dolly with zero lag); 1 = untouched math.
  function getFogMul() {
    if (!params.envAuto) return 1
    return (WEATHER[params.weather] ?? WEATHER.clear).fogMul
  }

  apply() // initial state on load — envAuto defaults true, so this shows "now"'s real light immediately

  return {
    apply,
    tick,
    getFogMul,
    needsFrameLoop,
    debug() {
      return { envAuto: params.envAuto, weather: params.weather, ...lastState }
    },
    dispose() {
      offTimeStore()
      clearInterval(slowTimer)
      scene.remove(sky)
      sky.geometry.dispose()
      sky.material.dispose()
    },
  }
}
