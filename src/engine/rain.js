import * as THREE from 'three'

// Rain layer (docs/ENVIRONMENT_DESIGN.md): a camera-following particle volume
// of falling streaks — purely procedural (no data, like typhoon.js), driven
// by the weather system (index.js's `weather` HANDLER) but independently
// toggleable (rainVisible) like any other overlay. Standard Layer interface
// (layers.js) — registers into the LayerManager, appears in the Layers panel.
//
// Geometry lives in a UNIT local box (-0.5..0.5 on every axis); tickView()
// repositions the group at the camera every frame and scales it by camera
// distance (ctx.camDist) — this is a scaled-map world (~480 m/world-unit at
// the P1 anchor), so a fixed-world-size rain volume would swallow the camera
// when zoomed in close and shrink to nothing when zoomed out to the island
// view. Scaling by distance keeps the box (and streak length, baked into the
// same local-unit space) framing the view at any zoom — see tickView.
//
// Streak "width" is NOT real per-pixel line thickness: plain THREE.LineSegments
// ignores gl.lineWidth on effectively every modern browser/GPU (a well-known
// WebGL spec limitation — see docs/ENVIRONMENT_DESIGN.md §known limitations).
// The visual read of "heavier rain" instead comes from streak LENGTH, density
// (segment count) and opacity, all of which genuinely respond to
// rainIntensity/rainDensity.

// local-unit box: x/z span -0.5..0.5 (baked directly into buildGeometry's
// Math.random()-0.5), y wraps over BOX_Y — the fall-wrap period
const BOX_Y = 1
const RAIN_WORLD_SCALE = 0.6 // group.scale = camDist * this — see module header
const BASE_SPEED = 0.16 // local-units/sec at rainIntensity 0
const SPEED_RANGE = 0.34 // added at rainIntensity 1
// BASE_LEN/LEN_RANGE, MAX_OPACITY and RAIN_COLOR below were tuned up from
// their original (0.03/0.05, 0.55, #bcd2e0) values — the pale blue-white at
// low opacity was reading as near-zero contrast against this app's light
// paper-map terrain (see docs/ENVIRONMENT_DESIGN.md §8): a darker, longer,
// more opaque streak actually shows "streak" texture at low camera angles
// (ride view) instead of just a faint shimmer.
const BASE_LEN = 0.05
const LEN_RANGE = 0.09
const MAX_OPACITY = 0.8
const MIN_DENSITY = 300
const MAX_DENSITY = 8000
const RAIN_COLOR = '#5a6b7a'
// wind tilt (local-unit xz offset per streak) by weather — typhoon slants
// hard. Exported so rainOverlay.js's screen-space streaks (index.js's
// applyRainOverlay()) slant in sync with this world-space layer — one source
// of truth, no duplicated numbers to drift.
export const WIND_BY_WEATHER = { clear: [0, 0], rain: [0.14, 0.08], typhoon: [0.42, 0.3] }

// BOX_Y interpolated directly into the template (NOT a post-hoc .replace() —
// that string-replace form only swaps the FIRST occurrence, silently leaving
// the second BOX_Y_CONST as a bare identifier and failing shader compilation;
// caught via console.log during verification, see docs/ENVIRONMENT_DESIGN.md).
const VERT = /* glsl */ `
  uniform float uTime, uSpeed, uStreakLen;
  uniform vec2 uWind;
  attribute vec3 aBase; // x, z, phase(0..1)
  attribute float aEnd; // 0 = head, 1 = tail
  varying float vEnd;
  varying float vFogDepth;
  void main() {
    vEnd = aEnd;
    float y = mod(aBase.z - uTime * uSpeed, 1.0) * ${BOX_Y.toFixed(4)} - ${BOX_Y.toFixed(4)} * 0.5;
    vec3 dir = normalize(vec3(uWind.x, -1.0, uWind.y));
    vec3 p = vec3(aBase.x, y, aBase.y) + dir * (aEnd * uStreakLen);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vFogDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`

const FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform vec3 fogColor;
  uniform float fogNear;
  uniform float fogFar;
  varying float vEnd;
  varying float vFogDepth;
  void main() {
    float a = mix(1.0, 0.15, vEnd); // comet-fade toward the trailing end
    vec3 col = uColor;
    float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    col = mix(col, fogColor, fogFactor);
    gl_FragColor = vec4(col, uOpacity * a);
  }
`

function clampDensity(n) {
  return Math.round(THREE.MathUtils.clamp(n || 0, MIN_DENSITY, MAX_DENSITY))
}

// one BufferGeometry per streak count: rainDensity segments x 2 verts. Fresh
// geometry on every density change (not a resize of the existing attributes)
// — same "setData swaps geometry" rule as every other deferred layer, though
// here it's a style-driven rebuild rather than a fetch (see new-layer SKILL's
// "先空後填" trap: an empty/zero-count geometry that's already been rendered
// once gets its _maxInstanceCount memoized at 0 forever — always build with a
// real count from the start, never defer-then-fill).
function buildGeometry(n) {
  const base = new Float32Array(n * 2 * 3)
  const end = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    const x = Math.random() - 0.5
    const z = Math.random() - 0.5
    const phase = Math.random()
    for (let v = 0; v < 2; v++) {
      const idx = (i * 2 + v) * 3
      base[idx] = x
      base[idx + 1] = z
      base[idx + 2] = phase
      end[i * 2 + v] = v
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('aBase', new THREE.BufferAttribute(base, 3))
  geo.setAttribute('aEnd', new THREE.BufferAttribute(end, 1))
  return geo
}

export function createRainLayer(params) {
  const group = new THREE.Group()
  group.visible = false

  let density = clampDensity(params.rainDensity)
  let geometry = buildGeometry(density)

  const uniforms = {
    uTime: { value: 0 },
    uSpeed: { value: BASE_SPEED },
    uStreakLen: { value: BASE_LEN },
    uWind: { value: new THREE.Vector2(0, 0) },
    uColor: { value: new THREE.Color(RAIN_COLOR) },
    uOpacity: { value: 0 },
    // placeholder values — WebGLRenderer.refreshFogUniforms overwrites these
    // from scene.fog every render call as long as material.fog===true and
    // scene.fog exists (three internals require the keys to already exist on
    // the material's own uniforms object; the values here are never read).
    fogColor: { value: new THREE.Color(params.fogColor) },
    fogNear: { value: params.fogNear },
    fogFar: { value: params.fogFar },
  }

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    fog: true,
  })

  let mesh = new THREE.LineSegments(geometry, material)
  mesh.frustumCulled = false
  group.add(mesh)

  function rebuild(n) {
    mesh.geometry.dispose()
    geometry = buildGeometry(n)
    mesh.geometry = geometry
    density = n
  }

  function gate() {
    return params.rainVisible
  }

  function applyStyle() {
    const intensity = THREE.MathUtils.clamp(params.rainIntensity ?? 0.6, 0, 1)
    uniforms.uOpacity.value = intensity * MAX_OPACITY
    uniforms.uSpeed.value = BASE_SPEED + intensity * SPEED_RANGE
    uniforms.uStreakLen.value = BASE_LEN + intensity * LEN_RANGE
    const wind = WIND_BY_WEATHER[params.weather] ?? WIND_BY_WEATHER.clear
    uniforms.uWind.value.set(wind[0] * (0.4 + intensity * 0.6), wind[1] * (0.4 + intensity * 0.6))
    const n = clampDensity(params.rainDensity)
    if (n !== density) rebuild(n)
  }

  return {
    id: 'rain',
    kind: 'area',
    label: 'Rain',
    rowLabel: '降雨 Rain',
    object3d: group,
    visibleParam: 'rainVisible',
    paramMap: {
      visible: 'rainVisible',
      intensity: 'rainIntensity',
      density: 'rainDensity',
    },

    build() {},

    update() {
      const show = gate()
      if (show) applyStyle()
      group.visible = show
    },

    // camera-following volume: recentre + rescale every frame it's visible
    // (see module header — RAIN_WORLD_SCALE keeps the box framing the view at
    // any zoom), advance the fall clock.
    tickView(ctx) {
      if (!group.visible) return
      uniforms.uTime.value += ctx.dt
      const camDist = ctx.camDist || 30
      group.position.copy(ctx.camera.position)
      group.scale.setScalar(camDist * RAIN_WORLD_SCALE)
    },

    describe() {
      return {
        id: 'rain',
        kind: 'area',
        label: 'Rain',
        rowLabel: '降雨 Rain',
        count: density,
        visible: params.rainVisible,
        styleSchema: {
          intensity: { type: 'slider', label: '雨勢 Intensity', min: 0, max: 1, step: 0.02, format: (v) => v.toFixed(2) },
          density: { type: 'slider', label: '密度 Density', min: MIN_DENSITY, max: MAX_DENSITY, step: 100, format: (v) => `${Math.round(v)}` },
        },
        style: {
          intensity: params.rainIntensity,
          density: params.rainDensity,
        },
      }
    },

    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}
